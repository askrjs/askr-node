import { once } from "node:events";
import { PassThrough } from "node:stream";
import { createMcpServer, type McpServer } from "@askrjs/server/mcp";
import { schema } from "@askrjs/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectMcpStdio } from "../src/mcp.js";

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
    io.input.write(Buffer.from([0xff, 0x0a]));
    await until(() => io.lines.length === 2);
    expect(io.lines[0]).toMatchObject({ id: null, error: { code: -32700 } });
    expect(io.lines[1]).toMatchObject({ id: null, error: { code: -32700 } });
  });

  it("should reject the message given valid JSON when it is not a request object", async () => {
    const io = harness();
    const connection = connectMcpStdio(createMcpServer({ name: "stdio", version: "1" }), {
      dependencies: undefined,
      ...io,
    });
    connections.push(connection);
    io.input.write("null\n");
    await until(() => io.lines.length === 1);
    expect(io.lines[0]).toMatchObject({ id: null, error: { code: -32600 } });
  });

  it("should return an internal error given a request when authentication fails", async () => {
    const io = harness();
    const connection = connectMcpStdio(createMcpServer({ name: "stdio", version: "1" }), {
      dependencies: undefined,
      auth: () => {
        throw new Error("auth failed");
      },
      ...io,
    });
    connections.push(connection);
    io.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" })}\n`);
    await until(() => io.lines.length === 1);
    expect(io.lines[0]).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32603, message: "Internal error" },
    });
    expect(io.diagnostics.read()?.toString()).toContain("MCP stdio error: auth failed");
  });

  it("should reject oversized input before a newline can be buffered", async () => {
    const io = harness();
    const connection = connectMcpStdio(createMcpServer({ name: "stdio", version: "1" }), {
      dependencies: undefined,
      maxLineBytes: 128,
      ...io,
    });
    connections.push(connection);
    io.input.write("x".repeat(64));
    expect(io.lines).toEqual([]);
    io.input.write("x".repeat(65));
    await until(() => io.lines.length === 1);
    expect(io.lines[0]).toMatchObject({
      id: null,
      error: { code: -32600, message: "Request line exceeds the configured limit" },
    });
  });

  it("should bound line size and concurrent request handling", async () => {
    const io = harness();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = createMcpServer({ name: "stdio", version: "1" }).tool(
      "wait",
      { input: schema.object({}) },
      async () => {
        await gate;
        return { content: [] };
      },
    );
    const connection = connectMcpStdio(server, {
      dependencies: undefined,
      maxConcurrency: 1,
      maxLineBytes: 128,
      ...io,
    });
    connections.push(connection);
    io.input.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "wait" } })}\n`,
    );
    io.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`);
    io.input.write(`${"x".repeat(129)}\n`);
    await until(() => io.lines.length === 2);
    expect(io.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 2,
          error: { code: -32000, message: "Too many concurrent requests" },
        }),
        expect.objectContaining({
          error: { code: -32600, message: "Request line exceeds the configured limit" },
        }),
      ]),
    );
    release!();
  });

  it("should cancel the request given saturated concurrency when a cancellation arrives", async () => {
    const io = harness();
    let markStarted!: () => void;
    let markAborted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      markAborted = resolve;
    });
    const server = {
      async handle(_message: unknown, environment: { signal?: AbortSignal }): Promise<undefined> {
        environment.signal?.addEventListener("abort", markAborted, { once: true });
        markStarted();
        await aborted;
        return undefined;
      },
      terminateSession: vi.fn(),
    } as unknown as McpServer<undefined>;
    const connection = connectMcpStdio(server, {
      dependencies: undefined,
      maxConcurrency: 1,
      ...io,
    });
    connections.push(connection);
    io.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "wait" })}\n`);
    await started;
    io.input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 1 },
      })}\n`,
    );
    await aborted;
    expect(io.lines).toEqual([]);
  });

  it("should terminate the session given an active request when stdin closes", async () => {
    const io = harness();
    let release!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const terminateSession = vi.fn();
    const server = {
      async handle() {
        markStarted();
        await gate;
        return { jsonrpc: "2.0", id: 1, result: {} };
      },
      terminateSession,
    } as unknown as McpServer<undefined>;
    const connection = connectMcpStdio(server, { dependencies: undefined, ...io });
    connections.push(connection);
    io.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`);
    await started;
    io.input.end();
    await connection.closed;
    expect(terminateSession).toHaveBeenCalledOnce();
    release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(io.lines).toEqual([]);
  });

  it("should close immediately given a signal when it is already aborted", async () => {
    const io = harness();
    const controller = new AbortController();
    controller.abort();
    const terminateSession = vi.fn();
    const server = {
      handle: vi.fn(),
      terminateSession,
    } as unknown as McpServer<undefined>;
    const connection = connectMcpStdio(server, {
      dependencies: undefined,
      signal: controller.signal,
      ...io,
    });
    connections.push(connection);
    await connection.closed;
    expect(terminateSession).toHaveBeenCalledOnce();
    expect(io.input.listenerCount("data")).toBe(0);
  });

  it("should close immediately given an input stream when it already ended", async () => {
    const io = harness();
    io.input.resume();
    const ended = once(io.input, "end");
    io.input.end();
    await ended;
    const terminateSession = vi.fn();
    const server = {
      handle: vi.fn(),
      terminateSession,
    } as unknown as McpServer<undefined>;
    const connection = connectMcpStdio(server, { dependencies: undefined, ...io });
    connections.push(connection);
    await connection.closed;
    expect(terminateSession).toHaveBeenCalledOnce();
  });

  it("should close cleanly given an input stream when it emits an error", async () => {
    const io = harness();
    const terminateSession = vi.fn();
    const server = {
      handle: vi.fn(),
      terminateSession,
    } as unknown as McpServer<undefined>;
    const connection = connectMcpStdio(server, { dependencies: undefined, ...io });
    connections.push(connection);
    io.input.emit("error", new Error("input failed"));
    await connection.closed;
    expect(terminateSession).toHaveBeenCalledOnce();
    expect(io.diagnostics.read()?.toString()).toContain("MCP stdio error: input failed");
  });
});
