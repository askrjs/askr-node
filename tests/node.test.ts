import { EventEmitter, once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { get, request as nodeRequest, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRouter, createServerApp } from "@askrjs/server";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createNodeHandler, listen, serve } from "../src/index.js";
import { writeNodeResponse } from "../src/response.js";

async function withServer(
  app: { fetch(request: Request): Promise<Response> },
  run: (origin: string) => Promise<void>,
): Promise<void> {
  const server = await listen(app);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("Node adapter", () => {
  it("should apply native timeout options", async () => {
    const server = await listen(
      { fetch: async () => new Response() },
      {
        requestTimeout: 123,
        headersTimeout: 456,
        keepAliveTimeout: 789,
      },
    );
    expect(server.requestTimeout).toBe(123);
    expect(server.headersTimeout).toBe(456);
    expect(server.keepAliveTimeout).toBe(789);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("should exchange text and binary WebSocket messages", async () => {
    const router = createRouter();
    router.ws("/echo/{room}", (socket, context) => {
      socket.onMessage((message) =>
        socket.send(typeof message === "string" ? `${context.params.room}:${message}` : message),
      );
    });
    const server = await listen(createServerApp({ router }), {
      host: "127.0.0.1",
      websocket: true,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/echo/room-1`);
    await once(socket, "open");
    socket.send("hello");
    const [text] = await once(socket, "message");
    expect(text.toString()).toBe("room-1:hello");
    socket.send(Buffer.from([1, 2, 3]));
    const [binary, isBinary] = await once(socket, "message");
    expect(isBinary).toBe(true);
    expect([...binary]).toEqual([1, 2, 3]);
    socket.close();
    await once(socket, "close");
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("should preserve method URL headers and streaming body", async () => {
    await withServer(
      {
        async fetch(request) {
          const body = await request.text();
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(`${request.method}:${new URL(request.url).pathname}:`),
                );
                controller.enqueue(
                  new TextEncoder().encode(`${request.headers.get("x-test")}:${body}`),
                );
                controller.close();
              },
            }),
          );
        },
      },
      async (origin) => {
        const response = await fetch(`${origin}/items?view=all`, {
          method: "POST",
          headers: { "x-test": "yes" },
          body: "payload",
        });
        expect(await response.text()).toBe("POST:/items:yes:payload");
      },
    );
  });

  it("should preserve DELETE request bodies", async () => {
    await withServer(
      {
        async fetch(request) {
          return new Response(`${request.method}:${await request.text()}`);
        },
      },
      async (origin) => {
        const response = await fetch(`${origin}/items/1`, { method: "DELETE", body: "reason" });
        expect(await response.text()).toBe("DELETE:reason");
      },
    );
  });

  it("should abort the Web Request when the Node request closes", async () => {
    let observed!: () => void;
    let markStarted!: () => void;
    const aborted = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const server = await listen({
      async fetch(request) {
        request.signal.addEventListener("abort", observed, { once: true });
        markStarted();
        await aborted;
        return new Response(null);
      },
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const request = nodeRequest({ host: "127.0.0.1", port: address.port, path: "/" });
    request.once("error", () => undefined);
    request.end();
    await started;
    request.destroy();
    await aborted;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("should preserve repeated Set-Cookie headers", async () => {
    await withServer(
      {
        async fetch() {
          const headers = new Headers();
          headers.append("set-cookie", "one=1; Path=/");
          headers.append("set-cookie", "two=2; Path=/");
          return new Response(null, { headers });
        },
      },
      async (origin) => {
        const response = await fetch(origin);
        expect(response.headers.getSetCookie()).toEqual(["one=1; Path=/", "two=2; Path=/"]);
      },
    );
  });

  it("should preserve response status text", async () => {
    await withServer(
      {
        async fetch() {
          return new Response(null, { status: 418, statusText: "Teapot Time" });
        },
      },
      async (origin) => {
        const status = await new Promise<string | undefined>((resolve, reject) => {
          get(origin, (response) => {
            resolve(response.statusMessage);
            response.resume();
          }).once("error", reject);
        });
        expect(status).toBe("Teapot Time");
      },
    );
  });

  it("should honor response backpressure", async () => {
    const emitter = new EventEmitter();
    const chunks: string[] = [];
    let ended = false;
    const target = Object.assign(emitter, {
      statusCode: 0,
      statusMessage: "",
      setHeader() {},
      write(chunk: Buffer) {
        chunks.push(chunk.toString());
        if (chunks.length === 1) {
          setTimeout(() => emitter.emit("drain"), 0);
          return false;
        }
        return true;
      },
      end() {
        ended = true;
      },
      destroy(error?: Error) {
        if (error) emitter.emit("error", error);
      },
    });
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("one"));
          controller.enqueue(new TextEncoder().encode("two"));
          controller.close();
        },
      }),
    );
    await writeNodeResponse(response, target as unknown as ServerResponse, "GET");
    expect(chunks).toEqual(["one", "two"]);
    expect(ended).toBe(true);
  });

  it("should cancel the Web response body given an early Node disconnect", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("first"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const emitter = new EventEmitter();
    const target = Object.assign(emitter, {
      statusCode: 0,
      statusMessage: "",
      setHeader() {},
      write() {
        emitter.emit("close");
        return true;
      },
      end() {
        throw new Error("end should not run after disconnect");
      },
      destroy() {},
    });

    await writeNodeResponse(new Response(body), target as unknown as ServerResponse, "GET");

    expect(cancelled).toBe(true);
  });

  it("should omit a body for HEAD", async () => {
    await withServer(
      { fetch: async () => new Response("body", { headers: { etag: "v1" } }) },
      async (origin) => {
        const response = await fetch(origin, { method: "HEAD" });
        expect(response.headers.get("etag")).toBe("v1");
        expect(await response.text()).toBe("");
      },
    );
  });

  it("should call Connect next given an adapter failure", async () => {
    let nextError: unknown;
    const handler = createNodeHandler({
      fetch: async () => {
        throw new Error("boom");
      },
    });
    const { createServer } = await import("node:http");
    const server = createServer((request, response) =>
      handler(request, response, (error) => {
        nextError = error;
        response.statusCode = 502;
        response.end("next");
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    expect((await fetch(`http://127.0.0.1:${address.port}`)).status).toBe(502);
    expect(nextError).toMatchObject({ message: "boom" });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("should return a minimal 500 when no next callback exists", async () => {
    await withServer(
      {
        fetch: async () => {
          throw new Error("boom");
        },
      },
      async (origin) => {
        const response = await fetch(origin);
        expect(response.status).toBe(500);
        expect(await response.text()).toBe("Internal Server Error");
      },
    );
  });

  it("should close the server when the listen signal aborts", async () => {
    const controller = new AbortController();
    const server = await listen(
      { fetch: async () => new Response(null) },
      { signal: controller.signal },
    );
    const closed = once(server, "close");
    controller.abort();
    await closed;
    expect(server.listening).toBe(false);
  });
});

describe("serve", () => {
  it("should stream static assets and reserve missing asset paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "askr-node-"));
    await writeFile(join(root, "app-12345678.js"), "asset");
    let fallthrough = 0;
    const served = await serve(
      { fetch: async () => ((fallthrough += 1), new Response("app")) },
      { assets: { root }, signals: false },
    );
    try {
      const asset = await fetch(`${served.url}/app-12345678.js`);
      expect(await asset.text()).toBe("asset");
      expect(asset.headers.get("content-type")).toContain("text/javascript");
      expect(asset.headers.get("x-content-type-options")).toBe("nosniff");
      expect((await fetch(`${served.url}/missing.js`)).status).toBe(404);
      expect(fallthrough).toBe(0);
      expect(await (await fetch(`${served.url}/page`)).text()).toBe("app");
      expect(fallthrough).toBe(1);
    } finally {
      await served.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("should close the application exactly once across concurrent shutdown", async () => {
    let closes = 0;
    const served = await serve(
      { fetch: async () => new Response(), close: async () => void (closes += 1) },
      { signals: false },
    );
    await Promise.all([served.close(), served.close(), served.close()]);
    expect(closes).toBe(1);
  });
});
