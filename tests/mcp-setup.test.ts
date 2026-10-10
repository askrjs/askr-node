import type { McpServer } from "@askrjs/server/mcp";
import { getEventListeners } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { connectMcpStdio } from "../src/mcp.js";

describe("MCP setup ownership", () => {
  it.each(["maxLineBytes", "maxConcurrency"] as const)(
    "rejects malformed %s before acquiring hooks",
    (key) => {
      for (const value of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
        const input = new PassThrough(),
          output = new PassThrough(),
          signal = new AbortController().signal;
        const terminateSession = vi.fn();
        try {
          expect(() =>
            connectMcpStdio({ terminateSession } as unknown as McpServer<undefined>, {
              dependencies: undefined,
              input,
              output,
              signal,
              [key]: value,
            }),
          ).toThrow(TypeError);
          expect(getEventListeners(signal, "abort")).toHaveLength(0);
          expect(input.listenerCount("data")).toBe(0);
          expect(output.listenerCount("error")).toBe(0);
          expect(terminateSession).not.toHaveBeenCalled();
        } finally {
          input.destroy();
          output.destroy();
        }
      }
    },
  );

  it("does not retain abort hooks when allocating the bounded line buffer fails", () => {
    const input = new PassThrough(),
      output = new PassThrough(),
      signal = new AbortController().signal;
    const reason = new RangeError("injected buffer allocation failure");
    const terminateSession = vi.fn();
    const allocate = vi.spyOn(Buffer, "allocUnsafe").mockImplementationOnce(() => {
      throw reason;
    });
    let failure: unknown;
    try {
      connectMcpStdio({ terminateSession } as unknown as McpServer<undefined>, {
        dependencies: undefined,
        input,
        output,
        signal,
      });
    } catch (error) {
      failure = error;
    } finally {
      allocate.mockRestore();
      input.destroy();
      output.destroy();
    }
    expect(failure).toBe(reason);
    expect(getEventListeners(signal, "abort")).toHaveLength(0);
    expect(terminateSession).not.toHaveBeenCalled();
  });
});
