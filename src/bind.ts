import { isIP } from "node:net";
import type { ListenOptions, NodeHandlerOptions } from "./contracts.js";

function isLoopbackHost(host: string): boolean {
  if (host.toLowerCase() === "localhost") return true;
  const family = isIP(host);
  if (family === 4) return host.split(".", 1)[0] === "127";
  if (family !== 6) return false;
  const normalized = new URL(`http://[${host}]`).hostname;
  return normalized === "[::1]" || normalized.startsWith("[::ffff:7f");
}

export function resolveBindHost(options: Pick<ListenOptions, "allowPublicBind" | "host">): string {
  const host = options.host ?? "127.0.0.1";
  if (!isLoopbackHost(host) && options.allowPublicBind !== true) {
    throw new TypeError(
      `Refusing to bind non-loopback host ${host} without allowPublicBind: true.`,
    );
  }
  return host;
}

export function handlerOptionsForHost(options: ListenOptions, host: string): NodeHandlerOptions {
  return {
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    allowedHosts: [...new Set([host, "localhost", ...(options.allowedHosts ?? [])])],
  };
}

export function formatHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
