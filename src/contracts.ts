import type { IncomingMessage, ServerResponse } from "node:http";
import type { PerMessageDeflateOptions } from "ws";

/** Options controlling how WebSocket upgrades are handled on a Node server. */
export interface NodeWebSocketOptions {
  /** Milliseconds to wait for a peer to acknowledge a close handshake before the socket is force-closed. */
  readonly closeTimeout?: number;
  /** Maximum allowed size, in bytes, of a single WebSocket message. */
  readonly maxPayload?: number;
  /** Maximum number of body bytes read from a rejected upgrade request before the connection is destroyed. */
  readonly maxRejectionBodyBytes?: number;
  /** Enables or configures the permessage-deflate WebSocket extension. */
  readonly perMessageDeflate?: boolean | PerMessageDeflateOptions;
  /** Origins allowed to open a WebSocket connection; when omitted, all origins are allowed. */
  readonly allowedOrigins?: readonly string[];
}

/** Options shared by anything that turns Node HTTP requests into `@askrjs/server` fetch calls. */
export interface NodeHandlerOptions {
  /** Base URL used to resolve request paths into absolute URLs. */
  readonly baseUrl?: string;
  /** Hosts allowed in the request's `Host` header; requests for other hosts are rejected. */
  readonly allowedHosts?: readonly string[];
}

/** Options for {@link listen}, controlling how the Node HTTP server binds and behaves. */
export interface ListenOptions extends NodeHandlerOptions {
  /** Port to listen on; defaults to an ephemeral port when omitted. */
  port?: number;
  /** Host/address to bind to. */
  host?: string;
  /** Allows binding to a non-loopback host without the usual safety check. */
  allowPublicBind?: boolean;
  /** Maximum length of the queue of pending connections. */
  backlog?: number;
  /** Aborting this signal stops the server. */
  signal?: AbortSignal;
  /** Node HTTP server `requestTimeout`, in milliseconds. */
  requestTimeout?: number;
  /** Node HTTP server `headersTimeout`, in milliseconds. */
  headersTimeout?: number;
  /** Node HTTP server `keepAliveTimeout`, in milliseconds. */
  keepAliveTimeout?: number;
  /** Enables WebSocket support, optionally with detailed options. */
  websocket?: boolean | NodeWebSocketOptions;
}

/** Options for {@link serve}, extending {@link ListenOptions} with static asset serving and shutdown behavior. */
export interface ServeOptions extends ListenOptions {
  /** Serves static files from this directory before falling back to the application. */
  readonly assets?: { readonly root: string };
  /** OS signals that trigger a graceful shutdown; pass `false` to disable automatic shutdown handling. */
  readonly signals?: false | readonly NodeJS.Signals[];
}

/** A running application returned by {@link serve}. */
export interface ServedApplication {
  /** The underlying Node HTTP server. */
  readonly server: import("node:http").Server;
  /** The base URL the server is listening on. */
  readonly url: string;
  /** Gracefully shuts down the server, any WebSocket connections, and the application. */
  close(): Promise<void>;
}

/** Connect/Express-style `next` callback used to hand off unhandled requests. */
export type ConnectNext = (error?: unknown) => void;
/** A Node-style request handler compatible with `http.Server` and Connect-style middleware chains. */
export type NodeHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  next?: ConnectNext,
) => void;
