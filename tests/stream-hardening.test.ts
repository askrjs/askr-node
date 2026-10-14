import { once } from "node:events";
import { request } from "node:http";
import { createConnection } from "node:net";
import { describe, expect, it } from "vite-plus/test";
import WebSocket from "ws";
import { listen } from "../src/index.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function close(server: Awaited<ReturnType<typeof listen>>) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("transport stream ownership", () => {
  it("disposes a response returned after the HTTP client disconnected", async () => {
    const entered = deferred(),
      aborted = deferred(),
      release = deferred(),
      cancel = deferred();
    let cancelled = 0;
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
      },
      cancel() {
        cancelled++;
        return cancel.promise;
      },
    });
    const server = await listen({
      fetch: async (input) => {
        input.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
        entered.resolve();
        await release.promise;
        return new Response(body);
      },
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const client = request(`http://127.0.0.1:${address.port}`);
    client.on("error", () => undefined);
    client.end();
    try {
      await entered.promise;
      client.destroy();
      await aborted.promise;
      release.resolve();
      await expect.poll(() => cancelled).toBe(1);
      expect(body.locked).toBe(false);
    } finally {
      client.destroy();
      release.resolve();
      cancel.resolve();
      if (!cancelled) source.close();
      await close(server);
    }
  });

  it("disposes an application body when Node rejects its response headers", async () => {
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled++;
      },
    });
    const server = await listen({
      fetch: async () =>
        new Response(body, {
          headers: { "x-value": "\u0001", "content-length": "99999", "set-cookie": "failed=1" },
        }),
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}`);
      expect(response.status).toBe(500);
      expect(response.headers.get("content-length")).not.toBe("99999");
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await response.text()).toBe("Internal Server Error");
      expect(cancelled).toBe(1);
      expect(body.locked).toBe(false);
    } finally {
      await close(server);
    }
  });

  it.each(["throws", "never settles"])(
    "closes failed response writes when cancellation %s",
    async (mode) => {
      const cancel = deferred();
      let cancelled = 0,
        disconnected = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue({ invalid: true } as unknown as Uint8Array);
        },
        cancel() {
          cancelled++;
          if (mode === "throws") throw new Error("cancel failed");
          return cancel.promise;
        },
      });
      const server = await listen({
        fetch: async (input) =>
          new URL(input.url).pathname === "/healthy"
            ? new Response(null, { status: 204 })
            : new Response(body),
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP address");
      const origin = `http://127.0.0.1:${address.port}`;
      const client = request(origin);
      client.once("error", () => {
        disconnected = true;
      });
      client.end();
      try {
        await expect.poll(() => cancelled).toBe(1);
        await expect.poll(() => disconnected).toBe(true);
        expect(body.locked).toBe(false);
        expect((await fetch(`${origin}/healthy`)).status).toBe(204);
      } finally {
        client.destroy();
        cancel.resolve();
        await close(server);
      }
    },
  );

  it.each([false, true])(
    "bounds upgrade rejection without awaiting cancellation; Content-Length %s",
    async (declared) => {
      const cancel = deferred();
      let cancelled = 0,
        status: number | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(5));
        },
        cancel() {
          cancelled++;
          return cancel.promise;
        },
      });
      const server = await listen(
        {
          fetch: async () =>
            new Response(body, { status: 401, headers: declared ? { "content-length": "5" } : {} }),
        },
        { websocket: { maxRejectionBodyBytes: 4 } },
      );
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP address");
      const origin = `http://127.0.0.1:${address.port}`;
      const client = new WebSocket(`ws://127.0.0.1:${address.port}/`, { origin });
      client.on("error", () => undefined);
      client.once("unexpected-response", (_request, response) => {
        status = response.statusCode;
        response.resume();
      });
      try {
        await expect.poll(() => status).toBe(500);
        expect(cancelled).toBe(1);
        expect(body.locked).toBe(false);
      } finally {
        cancel.resolve();
        client.terminate();
        await close(server);
      }
    },
  );

  it("cancels a stalled upgrade rejection when its socket disconnects", async () => {
    const entered = deferred();
    let cancelled = 0;
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
      },
      pull() {
        entered.resolve();
      },
      cancel() {
        cancelled++;
      },
    });
    const server = await listen(
      { fetch: async () => new Response(body, { status: 401 }) },
      { websocket: true },
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const client = createConnection({ host: "127.0.0.1", port: address.port });
    client.on("error", () => undefined);
    try {
      await once(client, "connect");
      client.write(
        [
          "GET / HTTP/1.1",
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
      await entered.promise;
      // The stream's eager pull is not enough; wait until the adapter owns its reader.
      await expect.poll(() => body.locked).toBe(true);
      client.destroy();
      await expect.poll(() => cancelled).toBe(1);
      expect(body.locked).toBe(false);
    } finally {
      client.destroy();
      if (!cancelled) source.close();
      await close(server);
    }
  });
});
