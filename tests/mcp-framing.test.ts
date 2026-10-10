import type { McpServer } from "@askrjs/server/mcp";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { connectMcpStdio } from "../src/mcp.js";

async function framing(chunks: Array<string | Buffer>, maxLineBytes = 1024) {
  const input = new PassThrough(),
    output = new PassThrough(),
    diagnostics = new PassThrough();
  const messages: unknown[] = [],
    lines: unknown[] = [];
  const terminateSession = vi.fn();
  const server = {
    handle: async (message: unknown) => {
      messages.push(message);
      return { jsonrpc: "2.0", id: 1, result: {} };
    },
    terminateSession,
  } as unknown as McpServer<undefined>;
  output.on("data", (chunk) => lines.push(JSON.parse(chunk.toString())));
  const connection = connectMcpStdio(server, {
    dependencies: undefined,
    input,
    output,
    diagnostics,
    maxLineBytes,
  });
  try {
    for (const chunk of chunks) input.write(chunk);
    await setImmediate();
    input.end();
    await connection.closed;
    expect(terminateSession).toHaveBeenCalledOnce();
    expect(input.listenerCount("data")).toBe(0);
    expect(diagnostics.read()).toBeNull();
    return { messages, lines };
  } finally {
    await connection.close();
    input.destroy();
    output.destroy();
    diagnostics.destroy();
  }
}
const request = { jsonrpc: "2.0", id: 1, method: "echo", params: { value: "日本語 🚀" } };
const valid = JSON.stringify(request);

describe("bounded MCP framing", () => {
  it("preserves multibyte UTF-8 across one-byte chunks and split CRLF", async () => {
    const chunks = [...Buffer.from(`${valid}\r\n`)].map((byte) => Buffer.from([byte]));
    expect((await framing(chunks)).messages).toEqual([request]);
  });
  it("accepts a line at the exact byte limit", async () => {
    expect((await framing([`${valid}\n`], Buffer.byteLength(valid))).messages).toEqual([request]);
  });
  it("discards an entire oversized line then recovers within the same chunk", async () => {
    const result = await framing(["x".repeat(100), `ignored\n${valid}\n`], 100);
    expect(result.messages).toEqual([request]);
    expect(result.lines).toMatchObject([{ error: { code: -32600 } }, { id: 1, result: {} }]);
  });
  it("recovers after invalid UTF-8 and malformed JSON", async () => {
    const result = await framing([Buffer.from([0xff, 0x0a]), `bad-json\n${valid}\n`]);
    expect(result.messages).toEqual([request]);
    expect(result.lines).toMatchObject([
      { error: { code: -32700 } },
      { error: { code: -32700 } },
      { id: 1 },
    ]);
  });
  it.each(["[]", "true", "1", '"text"'])(
    "rejects %s without poisoning the next message",
    async (invalid) => {
      const result = await framing([`${invalid}\n${valid}\n`]);
      expect(result.messages).toEqual([request]);
      expect(result.lines).toMatchObject([{ error: { code: -32600 } }, { id: 1 }]);
    },
  );
  it("drops an unterminated line at EOF", async () => {
    expect(await framing([valid])).toEqual({ messages: [], lines: [] });
  });
});
