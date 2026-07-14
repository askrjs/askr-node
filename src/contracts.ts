import type { IncomingMessage, ServerResponse } from 'node:http';

export interface NodeHandlerOptions {
  baseUrl?: string;
}

export interface ListenOptions {
  port?: number;
  host?: string;
  backlog?: number;
  signal?: AbortSignal;
}

export type ConnectNext = (error?: unknown) => void;
export type NodeHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  next?: ConnectNext,
) => void;
