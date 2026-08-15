import type { AuthContext } from "@askrjs/auth";
import type { McpServer } from "@askrjs/server/mcp";
import { randomUUID } from "node:crypto";
import { addAbortListener } from "node:events";
import type { Readable, Writable } from "node:stream";

/** Options for {@link connectMcpStdio}. */
export interface McpStdioOptions<Dependencies = undefined> {
  /** Application dependencies passed through to each MCP request. */
  dependencies: Dependencies;
  /** Stream to read newline-delimited JSON-RPC requests from; defaults to `process.stdin`. */
  input?: Readable;
  /** Stream to write newline-delimited JSON-RPC responses to; defaults to `process.stdout`. */
  output?: Writable;
  /** Stream that non-protocol errors are reported to; defaults to `process.stderr`. */
  diagnostics?: Writable;
  /** Aborting this signal closes the connection. */
  signal?: AbortSignal;
  /** Auth context to use for requests, or a function that derives one from the environment. */
  auth?: AuthContext | ((environment: NodeJS.ProcessEnv) => AuthContext | Promise<AuthContext>);
  /** Environment passed to the `auth` function; defaults to `process.env`. */
  environment?: NodeJS.ProcessEnv;
  /** Maximum size, in bytes, of a single input line before it is rejected; defaults to 1 MiB. */
  maxLineBytes?: number;
  /** Maximum number of requests handled concurrently; defaults to 16. */
  maxConcurrency?: number;
}

/** A live MCP stdio connection returned by {@link connectMcpStdio}. */
export interface McpStdioConnection {
  /** Resolves once the connection has fully closed. */
  readonly closed: Promise<void>;
  /** Closes the connection, aborting in-flight requests and terminating the MCP session. */
  close(): Promise<void>;
}

const anonymous: AuthContext = Object.freeze({
  authenticated: false,
  principal: null,
  session: null,
  tenant: null,
});

/**
 * Connects an MCP server to newline-delimited JSON-RPC over stdio (or any
 * pair of readable/writable streams).
 *
 * Reads one JSON-RPC message per line, dispatches it to `mcp.handle`, and
 * writes the response back as a line of JSON. Handles request cancellation
 * notifications, enforces `maxConcurrency` and `maxLineBytes`, and cleans up
 * the MCP session when the connection closes.
 *
 * @param mcp - The MCP server to dispatch requests to.
 * @param options - Stdio connection options, including dependencies and stream overrides.
 * @returns A handle exposing `closed` and `close()` for the connection's lifecycle.
 */
export function connectMcpStdio<Dependencies>(
  mcp: McpServer<Dependencies>,
  options: McpStdioOptions<Dependencies>,
): McpStdioConnection {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const diagnostics = options.diagnostics ?? process.stderr;
  const controllers = new Map<string | number, Set<AbortController>>();
  const sessionId = randomUUID();
  let finish!: () => void;
  const closed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let ended = false;
  const maxLineBytes = options.maxLineBytes ?? 1_048_576;
  const maxConcurrency = options.maxConcurrency ?? 16;
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0)
    throw new TypeError("MCP maxLineBytes must be a positive integer.");
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency <= 0)
    throw new TypeError("MCP maxConcurrency must be a positive integer.");
  let active = 0;
  let abortListener: ReturnType<typeof addAbortListener> | undefined;
  let cleanupTransport = () => undefined;
  const report = (error: unknown) => {
    try {
      diagnostics.write(
        `MCP stdio error: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    } catch {
      // The diagnostic stream is best-effort and must not affect protocol shutdown.
    }
  };
  const write = (message: unknown) => {
    if (ended) return Promise.reject(new Error("MCP stdio connection is closed."));
    return new Promise<void>((resolve, reject) => {
      output.write(`${JSON.stringify(message)}\n`, (error) => (error ? reject(error) : resolve()));
    });
  };
  const close = async () => {
    if (ended) return closed;
    ended = true;
    cleanupTransport();
    abortListener?.[Symbol.dispose]();
    for (const values of controllers.values()) {
      for (const controller of values) controller.abort();
    }
    controllers.clear();
    try {
      mcp.terminateSession(sessionId);
    } catch (error) {
      report(error);
    } finally {
      finish();
    }
    return closed;
  };
  if (options.signal) abortListener = addAbortListener(options.signal, () => void close());
  const writeProtocolError = (code: number, message: string) =>
    write({ jsonrpc: "2.0", id: null, error: { code, message } });
  const handleLine = (line: string) => {
    if (ended) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      void writeProtocolError(-32700, "Parse error").catch(() => void close());
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      void writeProtocolError(-32600, "Invalid Request").catch(() => void close());
      return;
    }
    const value = message as Record<string, unknown>;
    if (
      value.method === "notifications/cancelled" &&
      value.params &&
      typeof value.params === "object"
    ) {
      const requestId = (value.params as Record<string, unknown>).requestId;
      if (typeof requestId === "string" || typeof requestId === "number") {
        for (const controller of controllers.get(requestId) ?? []) controller.abort();
      }
      return;
    }
    const id = value.id;
    if (active >= maxConcurrency) {
      if (typeof id === "string" || typeof id === "number") {
        void write({
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: "Too many concurrent requests" },
        }).catch(() => void close());
      }
      return;
    }
    active += 1;
    void (async () => {
      const controller =
        typeof id === "string" || typeof id === "number" ? new AbortController() : undefined;
      if (controller && (typeof id === "string" || typeof id === "number")) {
        const values = controllers.get(id) ?? new Set<AbortController>();
        values.add(controller);
        controllers.set(id, values);
      }
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
        if (result !== undefined && !ended) await write(result);
      } catch (error) {
        if (!ended) {
          report(error);
          if (typeof id === "string" || typeof id === "number") {
            await write({
              jsonrpc: "2.0",
              id,
              error: { code: -32603, message: "Internal error" },
            });
          }
        }
      } finally {
        if (controller && (typeof id === "string" || typeof id === "number")) {
          const values = controllers.get(id);
          values?.delete(controller);
          if (values?.size === 0) controllers.delete(id);
        }
      }
    })()
      .catch((error) => {
        if (!ended) report(error);
      })
      .finally(() => {
        active -= 1;
      });
  };
  const lineBuffer = Buffer.allocUnsafe(maxLineBytes);
  const decoder = new TextDecoder("utf-8", { fatal: true });
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
    if (ended) return;
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
        try {
          handleLine(decoder.decode(lineBuffer.subarray(0, length)));
        } catch {
          void writeProtocolError(-32700, "Parse error").catch(() => void close());
        }
      }
      lineBytes = 0;
      discardingOversizedLine = false;
      offset = newline + 1;
    }
  };
  const finishInput = () => void close();
  const inputError = (error: Error) => {
    report(error);
    void close();
  };
  const outputError = (error: Error) => {
    report(error);
    void close();
  };
  input.on("data", onData);
  input.once("end", finishInput);
  input.once("close", finishInput);
  input.once("error", inputError);
  output.once("error", outputError);
  cleanupTransport = () => {
    input.off("data", onData);
    input.off("end", finishInput);
    input.off("close", finishInput);
    input.off("error", inputError);
    output.off("error", outputError);
  };
  if (input.readableEnded || input.destroyed || output.destroyed) void close();
  return { closed, close };
}
