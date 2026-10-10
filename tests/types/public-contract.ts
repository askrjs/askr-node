import {
  CLIENT_ADDRESS_HEADER,
  createNodeHandler,
  listen,
  serve,
  type ListenOptions,
  type ListeningServer,
  type NodeHandler,
  type NodeHandlerOptions,
  type ServedApplication,
  type ServeOptions,
} from "@askrjs/node";
import { connectMcpStdio, type McpStdioConnection, type McpStdioOptions } from "@askrjs/node/mcp";
import type { McpServer } from "@askrjs/server/mcp";

const app = { fetch: async () => new Response() };
const handlerOptions: NodeHandlerOptions = { baseUrl: "https://askr.test" };
const handler: NodeHandler = createNodeHandler(app, handlerOptions);
const next: NonNullable<Parameters<NodeHandler>[2]> = (_error?: unknown) => {};
const websocket: Exclude<ListenOptions["websocket"], boolean | undefined> = { maxPayload: 1024 };
const listenOptions: ListenOptions = { websocket, requestTimeout: 1000 };
const server: Promise<ListeningServer> = listen(app, listenOptions);
const serveOptions: ServeOptions = { ...listenOptions, signals: false, assets: { root: "public" } };
const running: Promise<ServedApplication> = serve(app, serveOptions);
declare const mcp: McpServer<{ value: number }>;
const stdioOptions: McpStdioOptions<{ value: number }> = {
  dependencies: { value: 1 },
  maxConcurrency: 1,
};
const connection: McpStdioConnection = connectMcpStdio(mcp, stdioOptions);
void [CLIENT_ADDRESS_HEADER, handler, next, server, running, connection];

// @ts-expect-error Removed low-level address helper.
import { normalizeClientAddress } from "@askrjs/node";
// @ts-expect-error Derive the optional callback from NodeHandler instead.
import type { ConnectNext } from "@askrjs/node";
// @ts-expect-error Derive nested configuration from ListenOptions instead.
import type { NodeWebSocketOptions } from "@askrjs/node";
void normalizeClientAddress;
export type RemovedNames = ConnectNext | NodeWebSocketOptions;

// @ts-expect-error Handler options require a trusted URL boundary, not a port.
const invalidHandler: NodeHandlerOptions = { port: 3000 };
// @ts-expect-error Application dependencies are required by the MCP server's type.
const invalidMcp: McpStdioOptions<{ value: number }> = { dependencies: undefined };
void [invalidHandler, invalidMcp];
