import { EventEmitter, once } from "node:events";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { get, request as nodeRequest, type ServerResponse } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRouter, createServerApp } from "@askrjs/server";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { formatHostForUrl } from "../src/bind.js";
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
  it("should bind to loopback by default and require public bind opt-in", async () => {
    const app = { fetch: async () => new Response() };
    const local = await listen(app);
    const localAddress = local.address();
    if (!localAddress || typeof localAddress === "string") throw new Error("Expected TCP address");
    expect(localAddress.address).toBe("127.0.0.1");
    await new Promise<void>((resolve) => local.close(() => resolve()));

    expect(() => listen(app, { host: "0.0.0.0" })).toThrow("without allowPublicBind: true");
    const publicServer = await listen(app, { host: "0.0.0.0", allowPublicBind: true });
    const publicAddress = publicServer.address();
    if (!publicAddress || typeof publicAddress === "string")
      throw new Error("Expected TCP address");
    expect(publicAddress.address).toBe("0.0.0.0");
    await new Promise<void>((resolve) => publicServer.close(() => resolve()));

    expect(formatHostForUrl("::1")).toBe("[::1]");
    expect(formatHostForUrl("127.0.0.1")).toBe("127.0.0.1");
    expect(() => listen(app, { host: "127.999.999.999" })).toThrow("without allowPublicBind: true");
  });

  it("should accept the request given a public bind when its Host is explicitly allowed", async () => {
    const server = await listen(
      { fetch: async (request) => new Response(new URL(request.url).hostname) },
      {
        host: "0.0.0.0",
        allowPublicBind: true,
        allowedHosts: ["api.example"],
      },
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    try {
      const response = await new Promise<{ body: string; status: number }>((resolve, reject) => {
        const request = nodeRequest(
          {
            host: "127.0.0.1",
            port: address.port,
            headers: { host: `API.EXAMPLE:${address.port}` },
          },
          (incoming) => {
            const chunks: Buffer[] = [];
            incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            incoming.on("end", () =>
              resolve({
                body: Buffer.concat(chunks).toString(),
                status: incoming.statusCode ?? 0,
              }),
            );
          },
        );
        request.once("error", reject);
        request.end();
      });
      expect(response).toEqual({ body: "api.example", status: 200 });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("should fail at setup given invalid trusted request origins", () => {
    const app = { fetch: async () => new Response() };
    expect(() => createNodeHandler(app, { baseUrl: "ftp://example.test" })).toThrow(
      "HTTP or HTTPS origin",
    );
    expect(() => createNodeHandler(app, { allowedHosts: ["bad host"] })).toThrow("invalid host");
  });

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

  it("should reject the configuration given server timeouts when they are invalid", () => {
    const app = { fetch: async () => new Response() };
    expect(() => listen(app, { requestTimeout: -1 })).toThrow("non-negative safe integer");
    expect(() => listen(app, { headersTimeout: 1.5 })).toThrow("non-negative safe integer");
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
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/echo/room-1`, {
      origin: `http://127.0.0.1:${address.port}`,
    });
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

  it("should reject cross-site WebSocket upgrades by default", async () => {
    const router = createRouter();
    router.ws("/echo", () => undefined);
    const server = await listen(createServerApp({ router }), {
      host: "127.0.0.1",
      websocket: true,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/echo`, {
      origin: "https://evil.example",
    });
    socket.on("error", () => undefined);
    const [, response] = await once(socket, "unexpected-response");
    expect(response.statusCode).toBe(403);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("should stop buffering oversized WebSocket rejection bodies", async () => {
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("123456"));
      },
      cancel() {
        cancelled = true;
        throw new Error("cancellation failed");
      },
    });
    const server = await listen(
      { fetch: async () => new Response(body, { status: 401 }) },
      {
        host: "127.0.0.1",
        websocket: { maxRejectionBodyBytes: 8 },
      },
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/rejected`, {
      origin: `http://127.0.0.1:${address.port}`,
    });
    socket.on("error", () => undefined);
    const [, response] = await once(socket, "unexpected-response");
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    await once(response, "end");
    expect(response.statusCode).toBe(500);
    expect(Buffer.concat(chunks).toString()).toBe(
      "WebSocket rejection body exceeded configured limit",
    );
    expect(cancelled).toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("should preserve cookies given a WebSocket upgrade when the application rejects it", async () => {
    const headers = new Headers();
    headers.append("set-cookie", "one=1; Path=/");
    headers.append("set-cookie", "two=2; Path=/");
    const server = await listen(
      { fetch: async () => new Response("Unauthorized", { status: 401, headers }) },
      { websocket: true },
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/rejected`, {
      origin: `http://127.0.0.1:${address.port}`,
    });
    socket.on("error", () => undefined);
    const [, response] = await once(socket, "unexpected-response");
    response.resume();
    expect(response.headers["set-cookie"]).toEqual(["one=1; Path=/", "two=2; Path=/"]);
    await once(response, "end");
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("should fail at setup given a WebSocket origin when it is invalid", () => {
    expect(() =>
      listen(
        { fetch: async () => new Response() },
        { websocket: { allowedOrigins: ["not an origin"] } },
      ),
    ).toThrow("invalid origin");
    expect(() =>
      listen(
        { fetch: async () => new Response() },
        { websocket: { allowedOrigins: ["https://example.test/path"] } },
      ),
    ).toThrow("invalid origin");
    expect(() =>
      listen({ fetch: async () => new Response() }, { websocket: { maxPayload: -1 } }),
    ).toThrow("non-negative safe integer");
    expect(() =>
      listen({ fetch: async () => new Response() }, { websocket: { closeTimeout: -1 } }),
    ).toThrow("non-negative safe integer");
  });

  it("should reject the request given an untrusted Host or request-target authority", async () => {
    const server = await listen(
      createServerApp({ routes: [{ path: "/", handler: (ctx) => ctx.ok() }] }),
      {
        host: "127.0.0.1",
      },
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const send = (path: string, host: string) =>
      new Promise<number>((resolve, reject) => {
        const request = nodeRequest({
          host: "127.0.0.1",
          port: address.port,
          path,
          headers: { host },
        });
        request.once("response", (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        });
        request.once("error", reject);
        request.end();
      });
    await expect(send("/", "evil.example")).resolves.toBe(400);
    await expect(send("http://evil.example/", `127.0.0.1:${address.port}`)).resolves.toBe(400);
    await expect(send("//evil.example/", `127.0.0.1:${address.port}`)).resolves.toBe(400);
    await expect(send("/#fragment", `127.0.0.1:${address.port}`)).resolves.toBe(400);
    await expect(send("/\\evil.example/", `127.0.0.1:${address.port}`)).resolves.toBe(400);
    await expect(send("/", `127.0.0.1:${address.port}`)).resolves.toBe(200);
    await expect(send("/", "evil.example")).resolves.toBe(400);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("should accept the request given an OPTIONS asterisk-form target", async () => {
    const server = await listen({
      fetch: async (request) => new Response(`${request.method}:${new URL(request.url).pathname}`),
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const request = nodeRequest(
          {
            host: "127.0.0.1",
            method: "OPTIONS",
            path: "*",
            port: address.port,
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("end", () => resolve(Buffer.concat(chunks).toString()));
          },
        );
        request.once("error", reject);
        request.end();
      });
      expect(body).toBe("OPTIONS:/*");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("should accept the request given a same-origin absolute target with a default port", async () => {
    const server = await listen(
      {
        fetch: async (request) => {
          const url = new URL(request.url);
          return new Response(`${url.origin}${url.pathname}`);
        },
      },
      { allowedHosts: ["example.test:80"] },
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const request = nodeRequest(
          {
            headers: { host: "example.test:80" },
            host: "127.0.0.1",
            path: "http://example.test:80/path",
            port: address.port,
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("end", () => resolve(Buffer.concat(chunks).toString()));
          },
        );
        request.once("error", reject);
        request.end();
      });
      expect(body).toBe("http://example.test/path");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
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

  it("should preserve the application receiver given a fetch method that uses this", async () => {
    class ReceiverApp {
      readonly prefix = "receiver";

      async fetch(request: Request): Promise<Response> {
        return new Response(`${this.prefix}:${new URL(request.url).pathname}`);
      }
    }

    await withServer(new ReceiverApp(), async (origin) => {
      const response = await fetch(`${origin}/bound`);
      expect(await response.text()).toBe("receiver:/bound");
    });
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

  it("should preserve repeated values given Node request headers when they are Set-Cookie", async () => {
    const server = await listen({
      fetch: async (request) => Response.json(request.headers.getSetCookie()),
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    try {
      const values = await new Promise<unknown>((resolve, reject) => {
        const request = nodeRequest(
          {
            host: "127.0.0.1",
            port: address.port,
            headers: { "set-cookie": ["one=1", "two=2"] },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
          },
        );
        request.once("error", reject);
        request.end();
      });
      expect(values).toEqual(["one=1", "two=2"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
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
      write(chunk: Uint8Array) {
        chunks.push(Buffer.from(chunk).toString());
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

  it("should cancel the body given an application response when the request method is HEAD", async () => {
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("body"));
      },
      cancel() {
        cancelled = true;
      },
    });
    await withServer(
      { fetch: async () => new Response(body, { headers: { etag: "v1" } }) },
      async (origin) => {
        const response = await fetch(origin, { method: "HEAD" });
        expect(response.headers.get("etag")).toBe("v1");
        expect(await response.text()).toBe("");
        expect(cancelled).toBe(true);
      },
    );
  });

  it("should call Connect next given an adapter failure", async () => {
    let nextError: unknown;
    const handler = createNodeHandler(
      {
        fetch: async () => {
          throw new Error("boom");
        },
      },
      { allowedHosts: ["127.0.0.1"] },
    );
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

  it("should contain the failure given a Connect next callback when it throws", async () => {
    const handler = createNodeHandler(
      {
        fetch: async () => {
          throw new Error("adapter failed");
        },
      },
      { allowedHosts: ["127.0.0.1"] },
    );
    const { createServer } = await import("node:http");
    const server = createServer((request, response) =>
      handler(request, response, () => {
        throw new Error("next failed");
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const response = await fetch(`http://127.0.0.1:${address.port}`);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal Server Error");
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

  it("should reject startup given a signal when it is already aborted", () => {
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      listen({ fetch: async () => new Response() }, { signal: controller.signal }),
    ).toThrow("aborted");
  });

  it("should reject startup given a signal when it aborts before listening", async () => {
    const controller = new AbortController();
    const starting = listen({ fetch: async () => new Response() }, { signal: controller.signal });
    controller.abort();
    await expect(starting).rejects.toMatchObject({ name: "AbortError" });
  });

  it.each([
    [
      "synchronously",
      () => {
        throw new Error("boom");
      },
    ],
    [
      "asynchronously",
      async () => {
        throw new Error("boom");
      },
    ],
  ])(
    "should close with 1011 given a WebSocket handler when it fails %s",
    async (_kind, handler) => {
      const router = createRouter();
      router.ws("/boom", handler);
      const server = await listen(createServerApp({ router }), { websocket: true });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP address");
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/boom`, {
        origin: `http://127.0.0.1:${address.port}`,
      });
      socket.on("error", () => undefined);
      const [code, reason] = await once(socket, "close");
      expect(code).toBe(1011);
      expect(reason.toString()).toBe("WebSocket handler failed");
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  );

  it("should abort the request given a pending WebSocket upgrade when the socket disconnects", async () => {
    let markStarted!: () => void;
    let markAborted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      markAborted = resolve;
    });
    const server = await listen(
      {
        async fetch(request) {
          request.signal.addEventListener("abort", markAborted, { once: true });
          markStarted();
          await aborted;
          return new Response("closed", { status: 400 });
        },
      },
      { websocket: true },
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const socket = createConnection({ host: "127.0.0.1", port: address.port });
    socket.write(
      [
        "GET /wait HTTP/1.1",
        `Host: 127.0.0.1:${address.port}`,
        `Origin: http://127.0.0.1:${address.port}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "",
        "",
      ].join("\r\n"),
    );
    await started;
    socket.destroy();
    await aborted;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("should close with 1011 given a WebSocket message listener when it throws", async () => {
    const router = createRouter();
    router.ws("/boom", (socket) => {
      socket.onMessage(() => {
        throw new Error("boom");
      });
    });
    const server = await listen(createServerApp({ router }), { websocket: true });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/boom`, {
      origin: `http://127.0.0.1:${address.port}`,
    });
    await once(socket, "open");
    socket.send("boom");
    const [code, reason] = await once(socket, "close");
    expect(code).toBe(1011);
    expect(reason.toString()).toBe("WebSocket listener failed");
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("should wait for clients given an open WebSocket when the server closes", async () => {
    const router = createRouter();
    router.ws("/open", () => undefined);
    const server = await listen(createServerApp({ router }), { websocket: true });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/open`, {
      origin: `http://127.0.0.1:${address.port}`,
    });
    await once(socket, "open");
    const clientClosed = once(socket, "close");
    const serverClosed = new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    const [code, reason] = await clientClosed;
    await serverClosed;
    expect(code).toBe(1001);
    expect(reason.toString()).toBe("Server shutting down");
  });

  it("should terminate an unresponsive WebSocket given shutdown when its grace period elapses", async () => {
    const router = createRouter();
    router.ws("/open", () => undefined);
    const server = await listen(createServerApp({ router }), {
      websocket: { closeTimeout: 20 },
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const socket = createConnection({ host: "127.0.0.1", port: address.port });
    try {
      await once(socket, "connect");
      const upgraded = new Promise<string>((resolve, reject) => {
        let response = "";
        const cleanup = () => {
          socket.off("data", onData);
          socket.off("error", onError);
        };
        const onData = (chunk: Buffer) => {
          response += chunk.toString();
          if (!response.includes("\r\n\r\n")) return;
          cleanup();
          resolve(response);
        };
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        socket.on("data", onData);
        socket.once("error", onError);
      });
      socket.write(
        [
          "GET /open HTTP/1.1",
          `Host: 127.0.0.1:${address.port}`,
          `Origin: http://127.0.0.1:${address.port}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "",
          "",
        ].join("\r\n"),
      );
      expect(await upgraded).toContain("101 Switching Protocols");
      const socketClosed = once(socket, "close");
      const serverClosed = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          serverClosed,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error("WebSocket shutdown timed out")), 500);
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      await socketClosed;
      expect(socket.destroyed).toBe(true);
    } finally {
      socket.destroy();
    }
  });
});

describe("serve", () => {
  it("should stream static assets and reserve missing asset paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "askr-node-"));
    await writeFile(join(root, "app-12345678.js"), "asset");
    await writeFile(join(root, "module-12345678.wasm"), new Uint8Array());
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
      const wasm = await fetch(`${served.url}/module-12345678.wasm`);
      expect(wasm.headers.get("content-type")).toBe("application/wasm");
      expect((await fetch(`${served.url}/missing.js`)).status).toBe(404);
      expect(fallthrough).toBe(0);
      const address = served.server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP address");
      const send = (path: string, host: string) =>
        new Promise<number>((resolve, reject) => {
          const request = nodeRequest({
            host: "127.0.0.1",
            port: address.port,
            path,
            headers: { host },
          });
          request.once("response", (response) => {
            response.resume();
            resolve(response.statusCode ?? 0);
          });
          request.once("error", reject);
          request.end();
        });
      await expect(send("/app-12345678.js", "evil.example")).resolves.toBe(400);
      await expect(
        send("http://evil.example/app-12345678.js", `127.0.0.1:${address.port}`),
      ).resolves.toBe(400);
      expect(fallthrough).toBe(0);
      expect(await (await fetch(`${served.url}/page`)).text()).toBe("app");
      expect(fallthrough).toBe(1);
    } finally {
      await served.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("should disable caching given an HTML application response when no policy is authored", async () => {
    const served = await serve(
      {
        fetch: async () =>
          new Response("page", { headers: { "content-type": "Text/HTML; charset=utf-8" } }),
      },
      { signals: false },
    );
    try {
      const response = await fetch(`${served.url}/page`);
      expect(response.headers.get("cache-control")).toBe("no-cache");
    } finally {
      await served.close();
    }
  });

  it.runIf(process.platform !== "win32")(
    "should not follow static asset symlinks outside the configured root",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "askr-node-assets-"));
      const outside = await mkdtemp(join(tmpdir(), "askr-node-outside-"));
      await writeFile(join(outside, "secret.txt"), "secret");
      await symlink(outside, join(root, "escape"));
      const served = await serve(
        { fetch: async () => new Response("application") },
        { assets: { root }, signals: false },
      );
      try {
        const response = await fetch(`${served.url}/escape/secret.txt`);
        expect(response.status).toBe(404);
        expect(await response.text()).toBe("Not Found");
      } finally {
        await served.close();
        await Promise.all([
          rm(root, { recursive: true, force: true }),
          rm(outside, { recursive: true, force: true }),
        ]);
      }
    },
  );

  it("should close the application exactly once across concurrent shutdown", async () => {
    let closes = 0;
    const served = await serve(
      { fetch: async () => new Response(), close: async () => void (closes += 1) },
      { signals: false },
    );
    await Promise.all([served.close(), served.close(), served.close()]);
    expect(closes).toBe(1);
  });

  it("should close the application given a server when it was already stopped externally", async () => {
    let closes = 0;
    const served = await serve(
      { fetch: async () => new Response(), close: async () => void (closes += 1) },
      { signals: false },
    );
    await new Promise<void>((resolve, reject) =>
      served.server.close((error) => (error ? reject(error) : resolve())),
    );
    await served.close();
    expect(closes).toBe(1);
  });

  it("should close the application given startup when its signal aborts", async () => {
    let closes = 0;
    const controller = new AbortController();
    const starting = serve(
      { fetch: async () => new Response(), close: async () => void (closes += 1) },
      { signal: controller.signal, signals: false },
    );
    controller.abort();
    await expect(starting).rejects.toMatchObject({ name: "AbortError" });
    expect(closes).toBe(1);
  });
});
