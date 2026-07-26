import type { ListenOptions } from "./contracts.js";

export function resolveBindHost(options: Pick<ListenOptions, "allowPublicBind" | "host">): string {
  const host = options.host ?? "127.0.0.1";
  const loopback = host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
  if (!loopback && options.allowPublicBind !== true) {
    throw new TypeError(
      `Refusing to bind non-loopback host ${host} without allowPublicBind: true.`,
    );
  }
  return host;
}

export function formatHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
