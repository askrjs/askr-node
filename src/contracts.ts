import type { IncomingMessage, ServerResponse } from "node:http";
import type { PerMessageDeflateOptions } from "ws";

export interface NodeWebSocketOptions {
  readonly maxPayload?: number;
  readonly perMessageDeflate?: boolean | PerMessageDeflateOptions;
  readonly allowedOrigins?: readonly string[];
}

export interface NodeHandlerOptions {
  baseUrl?: string;
  allowedHosts?: readonly string[];
}

export interface ListenOptions {
  port?: number;
  host?: string;
  backlog?: number;
  signal?: AbortSignal;
  requestTimeout?: number;
  headersTimeout?: number;
  keepAliveTimeout?: number;
  websocket?: boolean | NodeWebSocketOptions;
}

export interface ServeOptions extends ListenOptions {
  readonly assets?: { readonly root: string };
  readonly signals?: false | readonly NodeJS.Signals[];
}

export interface ServedApplication {
  readonly server: import("node:http").Server;
  readonly url: string;
  close(): Promise<void>;
}

export type ConnectNext = (error?: unknown) => void;
export type NodeHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  next?: ConnectNext,
) => void;
