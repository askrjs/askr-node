import { PassThrough } from "node:stream";
import { createMcpServer } from "@askrjs/server/mcp";
import { afterEach, describe, expect, it } from "vitest";
import { connectMcpStdio } from "../src/mcp";

const connections: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(connections.splice(0).map((value) => value.close()));
});

function harness() {
  const input = new PassThrough();
  const output = new PassThrough();
  const diagnostics = new PassThrough();
  const lines: unknown[] = [];
  let buffer = "";
  output.on("data", (chunk) => {
    buffer += chunk.toString();
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      lines.push(JSON.parse(buffer.slice(0, newline)));
      buffer = buffer.slice(newline + 1);
    }
  });
  return { input, output, diagnostics, lines };
}

async function until(check: () => boolean): Promise<void> {
  for (let index = 0; index < 100 && !check(); index += 1)
    await new Promise((resolve) => setTimeout(resolve, 1));
  expect(check()).toBe(true);
}

describe("MCP stdio", () => {
  it("should isolate protocol output and retain connection lifecycle", async () => {
    const io = harness();
    const server = createMcpServer({ name: "stdio", version: "1" });
    const connection = connectMcpStdio(server, { dependencies: undefined, ...io });
    connections.push(connection);
    io.input.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } })}\n`,
    );
    io.input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    io.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`);
    await until(() => io.lines.length === 2);
    expect(io.lines).toMatchObject([
      { id: 1, result: { protocolVersion: "2025-11-25" } },
      { id: 2, result: {} },
    ]);
    expect(io.diagnostics.read()).toBeNull();
  });

  it("should report malformed lines as JSON-RPC parse errors", async () => {
    const io = harness();
    const connection = connectMcpStdio(createMcpServer({ name: "stdio", version: "1" }), {
      dependencies: undefined,
      ...io,
    });
    connections.push(connection);
    io.input.write("not-json\n");
    await until(() => io.lines.length === 1);
    expect(io.lines[0]).toMatchObject({ id: null, error: { code: -32700 } });
  });
});
