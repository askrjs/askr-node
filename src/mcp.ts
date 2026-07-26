import type { AuthContext } from "@askrjs/auth";
import type { McpServer } from "@askrjs/server/mcp";
import type { Readable, Writable } from "node:stream";

export interface McpStdioOptions<Dependencies = undefined> {
  dependencies: Dependencies;
  input?: Readable;
  output?: Writable;
  diagnostics?: Writable;
  signal?: AbortSignal;
  auth?: AuthContext | ((environment: NodeJS.ProcessEnv) => AuthContext | Promise<AuthContext>);
  environment?: NodeJS.ProcessEnv;
  maxLineBytes?: number;
  maxConcurrency?: number;
}

export interface McpStdioConnection {
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

const anonymous: AuthContext = Object.freeze({
  authenticated: false,
  principal: null,
  session: null,
  tenant: null,
});

export function connectMcpStdio<Dependencies>(
  mcp: McpServer<Dependencies>,
  options: McpStdioOptions<Dependencies>,
): McpStdioConnection {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const diagnostics = options.diagnostics ?? process.stderr;
  const controllers = new Map<string | number, AbortController>();
  const sessionId = crypto.randomUUID();
  let finish!: () => void;
  const closed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let ended = false;
  const maxLineBytes = options.maxLineBytes ?? 1_048_576;
  const maxConcurrency = options.maxConcurrency ?? 16;
  if (!Number.isInteger(maxLineBytes) || maxLineBytes <= 0)
    throw new TypeError("MCP maxLineBytes must be a positive integer.");
  if (!Number.isInteger(maxConcurrency) || maxConcurrency <= 0)
    throw new TypeError("MCP maxConcurrency must be a positive integer.");
  let active = 0;
  let cleanupInput = () => undefined;
  const write = (message: unknown) =>
    new Promise<void>((resolve, reject) => {
      output.write(`${JSON.stringify(message)}\n`, (error) => (error ? reject(error) : resolve()));
    });
  const close = async () => {
    if (ended) return closed;
    ended = true;
    cleanupInput();
    for (const controller of controllers.values()) controller.abort();
    controllers.clear();
    mcp.terminateSession(sessionId);
    finish();
    return closed;
  };
  options.signal?.addEventListener("abort", () => void close(), { once: true });
  const handleLine = (line: string) => {
    if (active >= maxConcurrency) {
      void write({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Too many concurrent requests" },
      }).catch(() => void close());
      return;
    }
    active += 1;
    void (async () => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        await write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        return;
      }
      if (message && typeof message === "object") {
        const value = message as Record<string, unknown>;
        if (
          value.method === "notifications/cancelled" &&
          value.params &&
          typeof value.params === "object"
        ) {
          const requestId = (value.params as Record<string, unknown>).requestId;
          if (typeof requestId === "string" || typeof requestId === "number")
            controllers.get(requestId)?.abort();
        }
        const id = value.id;
        const controller =
          typeof id === "string" || typeof id === "number" ? new AbortController() : undefined;
        if (controller && (typeof id === "string" || typeof id === "number"))
          controllers.set(id, controller);
        try {
          const environment = options.environment ?? process.env;
          const auth =
            typeof options.auth === "function"
              ? await options.auth(environment)
              : (options.auth ?? anonymous);
          const result = await mcp.handle(message, {
            dependencies: options.dependencies,
            auth,
            transport: "stdio",
            sessionId,
            supportsPush: true,
            signal: controller?.signal ?? options.signal,
            send: write,
          });
          if (result !== undefined) await write(result);
        } finally {
          if (controller && id !== undefined) controllers.delete(id as string | number);
        }
      }
    })()
      .catch((error) =>
        diagnostics.write(
          `MCP stdio error: ${error instanceof Error ? error.message : String(error)}\n`,
        ),
      )
      .finally(() => {
        active -= 1;
      });
  };
  const lineBuffer = Buffer.allocUnsafe(maxLineBytes);
  let lineBytes = 0;
  let discardingOversizedLine = false;
  const rejectOversizedLine = () => {
    void write({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Request line exceeds the configured limit" },
    }).catch(() => void close());
  };
  const onData = (chunk: string | Buffer | Uint8Array) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const newline = bytes.indexOf(0x0a, offset);
      const end = newline < 0 ? bytes.byteLength : newline;
      const segmentBytes = end - offset;
      if (!discardingOversizedLine) {
        if (lineBytes + segmentBytes > maxLineBytes) {
          discardingOversizedLine = true;
          lineBytes = 0;
          rejectOversizedLine();
        } else if (segmentBytes > 0) {
          bytes.copy(lineBuffer, lineBytes, offset, end);
          lineBytes += segmentBytes;
        }
      }
      if (newline < 0) break;
      if (!discardingOversizedLine) {
        const length =
          lineBytes > 0 && lineBuffer[lineBytes - 1] === 0x0d ? lineBytes - 1 : lineBytes;
        handleLine(lineBuffer.subarray(0, length).toString("utf8"));
      }
      lineBytes = 0;
      discardingOversizedLine = false;
      offset = newline + 1;
    }
  };
  const finishInput = () => {
    if (!ended) {
      if (!discardingOversizedLine && lineBytes > 0) {
        handleLine(lineBuffer.subarray(0, lineBytes).toString("utf8"));
      }
      ended = true;
      cleanupInput();
      finish();
    }
  };
  input.on("data", onData);
  input.once("end", finishInput);
  input.once("close", finishInput);
  cleanupInput = () => {
    input.off("data", onData);
    input.off("end", finishInput);
    input.off("close", finishInput);
  };
  return { closed, close };
}
