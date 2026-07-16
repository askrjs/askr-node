import type { AuthContext } from "@askrjs/auth";
import type { McpServer } from "@askrjs/server/mcp";
import type { Readable, Writable } from "node:stream";
import { createInterface } from "node:readline";

export interface McpStdioOptions<Dependencies = undefined> {
  dependencies: Dependencies;
  input?: Readable;
  output?: Writable;
  diagnostics?: Writable;
  signal?: AbortSignal;
  auth?: AuthContext | ((environment: NodeJS.ProcessEnv) => AuthContext | Promise<AuthContext>);
  environment?: NodeJS.ProcessEnv;
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
  const lines = createInterface({ input, crlfDelay: Infinity, terminal: false });
  const controllers = new Map<string | number, AbortController>();
  const sessionId = crypto.randomUUID();
  let finish!: () => void;
  const closed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let ended = false;
  const write = (message: unknown) =>
    new Promise<void>((resolve, reject) => {
      output.write(`${JSON.stringify(message)}\n`, (error) => (error ? reject(error) : resolve()));
    });
  const close = async () => {
    if (ended) return closed;
    ended = true;
    lines.close();
    for (const controller of controllers.values()) controller.abort();
    controllers.clear();
    mcp.terminateSession(sessionId);
    finish();
    return closed;
  };
  options.signal?.addEventListener("abort", () => void close(), { once: true });
  lines.on("line", (line) => {
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
    })().catch((error) =>
      diagnostics.write(
        `MCP stdio error: ${error instanceof Error ? error.message : String(error)}\n`,
      ),
    );
  });
  lines.once("close", () => {
    if (!ended) {
      ended = true;
      finish();
    }
  });
  return { closed, close };
}
