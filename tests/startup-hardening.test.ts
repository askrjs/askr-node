import { getEventListeners } from "node:events";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { listen, serve } from "../src/index.js";

describe("startup resource ownership", () => {
  it.each(
    [-1, 65_536, 1.5, Number.NaN].flatMap((port) =>
      [false, true].map((websocket) => ({ port, websocket })),
    ),
  )(
    "removes abort hooks after invalid port $port with WebSockets $websocket",
    async ({ port, websocket }) => {
      const controller = new AbortController();
      try {
        await expect(
          listen(
            { fetch: async () => new Response() },
            { port, websocket, signal: controller.signal },
          ),
        ).rejects.toMatchObject({ code: "ERR_SOCKET_BAD_PORT" });
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      } finally {
        controller.abort();
        await setImmediate();
      }
    },
  );

  it("cleans up a failed bind exactly once while preserving the original error and listener", async () => {
    const occupied = await listen({ fetch: async () => new Response("occupied") });
    const address = occupied.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const signalCount = process.listenerCount("SIGTERM");
    const controller = new AbortController();
    let closes = 0;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        await expect(
          serve(
            {
              fetch: async () => new Response(),
              close: async () => {
                closes++;
              },
            },
            {
              port: address.port,
              websocket: true,
              signals: ["SIGTERM"],
              signal: controller.signal,
            },
          ),
        ).rejects.toMatchObject({ code: "EADDRINUSE" });
        expect(closes).toBe(attempt + 1);
        expect(process.listenerCount("SIGTERM")).toBe(signalCount);
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      }
      expect(await (await fetch(`http://127.0.0.1:${address.port}`)).text()).toBe("occupied");
    } finally {
      controller.abort();
      occupied.closeAllConnections();
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });
});
