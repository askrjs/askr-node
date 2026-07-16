import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import type { NodeHandlerOptions } from "./contracts.js";

function requestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

export function requestFromNode(
  request: IncomingMessage,
  options: NodeHandlerOptions,
  signal: AbortSignal,
): Request {
  const base = options.baseUrl ?? `http://${request.headers.host ?? "localhost"}`;
  const method = request.method ?? "GET";
  const body =
    method === "GET" || method === "HEAD"
      ? undefined
      : (Readable.toWeb(request) as unknown as BodyInit);
  return new Request(new URL(request.url ?? "/", base), {
    method,
    headers: requestHeaders(request),
    body,
    signal,
    ...(body ? { duplex: "half" as const } : {}),
  } as RequestInit & { duplex?: "half" });
}
