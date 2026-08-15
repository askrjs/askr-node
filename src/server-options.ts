import type { Server, ServerOptions } from "node:http";
import type { ListenOptions } from "./contracts.js";

function timeout(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError(`${name} must be a non-negative safe integer.`);
  return value;
}

export function resolveServerOptions(options: ListenOptions): ServerOptions {
  const requestTimeout = timeout(options.requestTimeout, "requestTimeout");
  const headersTimeout = timeout(options.headersTimeout, "headersTimeout");
  const keepAliveTimeout = timeout(options.keepAliveTimeout, "keepAliveTimeout");
  const enforced = [requestTimeout, headersTimeout].filter(
    (value): value is number => value !== undefined && value > 0,
  );
  return {
    requestTimeout:
      requestTimeout !== undefined &&
      headersTimeout !== undefined &&
      headersTimeout > requestTimeout
        ? headersTimeout
        : requestTimeout,
    headersTimeout,
    keepAliveTimeout,
    connectionsCheckingInterval: enforced.length ? Math.min(1_000, ...enforced) : undefined,
  };
}

export function applyServerTimeouts(server: Server, options: ListenOptions): void {
  const requestTimeout = timeout(options.requestTimeout, "requestTimeout");
  const headersTimeout = timeout(options.headersTimeout, "headersTimeout");
  const keepAliveTimeout = timeout(options.keepAliveTimeout, "keepAliveTimeout");
  if (requestTimeout !== undefined) server.requestTimeout = requestTimeout;
  if (headersTimeout !== undefined) server.headersTimeout = headersTimeout;
  if (keepAliveTimeout !== undefined) server.keepAliveTimeout = keepAliveTimeout;
}
