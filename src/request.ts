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
  const host = request.headers.host;
  if (!options.baseUrl && !options.allowedHosts?.length)
    throw new TypeError("Node handling requires baseUrl or an allowedHosts allowlist.");
  if (!host) throw new TypeError("Request Host header is required.");
  const hostName = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":", 1)[0]!;
  if (
    options.allowedHosts?.length &&
    !options.allowedHosts.some((allowed) => allowed === host || allowed === hostName)
  )
    throw new TypeError("Request Host header is not allowed.");
  const base = options.baseUrl ?? `http://${host}`;
  const target = new URL(request.url ?? "/", base);
  if (/^https?:\/\//i.test(request.url ?? "") && target.origin !== new URL(base).origin)
    throw new TypeError("Absolute-form request target origin is not allowed.");
  const method = request.method ?? "GET";
  const body =
    method === "GET" || method === "HEAD"
      ? undefined
      : (Readable.toWeb(request) as unknown as BodyInit);
  return new Request(target, {
    method,
    headers: requestHeaders(request),
    body,
    signal,
    ...(body ? { duplex: "half" as const } : {}),
  } as RequestInit & { duplex?: "half" });
}
