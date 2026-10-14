import type { McpServer } from "@askrjs/server/mcp";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vite-plus/test";
import { connectMcpStdio } from "../src/mcp.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const anonymous = { authenticated: false, principal: null, session: null, tenant: null } as const;

describe("MCP dispatch lifetime", () => {
  it.each(["close", "cancel"])("ignores authentication rejection after %s", async (mode) => {
    const entered = deferred<void>();
    let reject!: (error: Error) => void;
    const auth = new Promise<typeof anonymous>((_yes, no) => {
      reject = no;
    });
    const input = new PassThrough(),
      output = new PassThrough(),
      diagnostics = new PassThrough();
    const handle = vi.fn(),
      terminateSession = vi.fn();
    const connection = connectMcpStdio(
      { handle, terminateSession } as unknown as McpServer<undefined>,
      {
        dependencies: undefined,
        input,
        output,
        diagnostics,
        auth: () => {
          entered.resolve();
          return auth;
        },
      },
    );
    try {
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" })}\n`);
      await entered.promise;
      if (mode === "close") await connection.close();
      else
        input.write(
          `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } })}\n`,
        );
      reject(new Error("late authentication failure"));
      await setImmediate();
      expect(handle).not.toHaveBeenCalled();
      expect(output.read()).toBeNull();
      expect(diagnostics.read()).toBeNull();
    } finally {
      await connection.close();
      input.destroy();
      output.destroy();
      diagnostics.destroy();
    }
    expect(terminateSession).toHaveBeenCalledOnce();
  });
  it.each(["close", "cancel"])(
    "does not start a handler after %s while authentication is pending",
    async (mode) => {
      const auth = deferred<typeof anonymous>(),
        entered = deferred<void>();
      const input = new PassThrough(),
        output = new PassThrough(),
        diagnostics = new PassThrough();
      const handle = vi.fn(async () => ({ jsonrpc: "2.0", id: 7, result: {} }));
      const terminateSession = vi.fn();
      const server = { handle, terminateSession } as unknown as McpServer<undefined>;
      const connection = connectMcpStdio(server, {
        dependencies: undefined,
        input,
        output,
        diagnostics,
        auth: () => {
          entered.resolve();
          return auth.promise;
        },
      });
      try {
        input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" })}\n`);
        await entered.promise;
        if (mode === "close") await connection.close();
        else
          input.write(
            `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } })}\n`,
          );
        auth.resolve(anonymous);
        await setImmediate();
        expect(handle).not.toHaveBeenCalled();
        expect(output.read()).toBeNull();
      } finally {
        auth.resolve(anonymous);
        await connection.close();
        input.destroy();
        output.destroy();
        diagnostics.destroy();
      }
      expect(terminateSession).toHaveBeenCalledOnce();
      expect(input.listenerCount("data")).toBe(0);
    },
  );
});
