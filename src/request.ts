import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { CLIENT_ADDRESS_HEADER, normalizeClientAddress } from "./client-address.js";
import type { NodeHandlerOptions } from "./contracts.js";

export class NodeRequestError extends TypeError {}

interface AllowedAuthority {
  readonly host?: string;
  readonly hostname: string;
}

export interface PreparedNodeHandlerOptions {
  readonly allowedHosts: readonly AllowedAuthority[];
  readonly baseUrl?: string;
  readonly hostCache: {
    base?: string;
    value?: string;
  };
}

interface ParsedAuthority {
  readonly host: string;
  readonly hostname: string;
}

function explicitPort(authority: string): string | undefined {
  if (authority.startsWith("[")) {
    const bracket = authority.indexOf("]");
    return bracket >= 0 && authority[bracket + 1] === ":"
      ? authority.slice(bracket + 2)
      : undefined;
  }
  const first = authority.indexOf(":");
  return first >= 0 && first === authority.lastIndexOf(":")
    ? authority.slice(first + 1)
    : undefined;
}

function parseAuthority(value: string, allowBareIpv6 = false): ParsedAuthority {
  if (!value || value.trim() !== value)
    throw new NodeRequestError("Request host must be a non-empty HTTP authority.");
  const bareIpv6 = isIP(value) === 6;
  if (bareIpv6 && !allowBareIpv6)
    throw new NodeRequestError("IPv6 request hosts must use brackets.");
  const authority = bareIpv6 ? `[${value}]` : value;
  const port = explicitPort(authority);
  let parsed: URL;
  try {
    parsed = new URL(`http://${authority}`);
  } catch {
    throw new NodeRequestError("Request host is not a valid HTTP authority.");
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    (port !== undefined && !/^\d+$/u.test(port))
  ) {
    throw new NodeRequestError("Request host is not a valid HTTP authority.");
  }
  return {
    hostname: parsed.hostname,
    host: port === undefined ? parsed.hostname : `${parsed.hostname}:${Number(port)}`,
  };
}

function prepareBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("Node handler baseUrl must be a valid HTTP or HTTPS origin.");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new TypeError("Node handler baseUrl must be an HTTP or HTTPS origin.");
  }
  return parsed.origin;
}

export function prepareNodeHandlerOptions(options: NodeHandlerOptions): PreparedNodeHandlerOptions {
  const allowedHosts = (options.allowedHosts ?? []).map((value) => {
    try {
      const parsed = parseAuthority(value, true);
      return explicitPort(isIP(value) === 6 ? `[${value}]` : value) === undefined
        ? { hostname: parsed.hostname }
        : parsed;
    } catch (error) {
      throw new TypeError(
        `Node handler allowedHosts contains an invalid host: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
  const baseUrl = options.baseUrl === undefined ? undefined : prepareBaseUrl(options.baseUrl);
  if (!baseUrl && allowedHosts.length === 0)
    throw new TypeError("Node handling requires baseUrl or an allowedHosts allowlist.");
  return { allowedHosts, baseUrl, hostCache: {} };
}

function requestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const key in request.headers) {
    const value = request.headers[key];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }
  headers.set(CLIENT_ADDRESS_HEADER, normalizeClientAddress(request.socket.remoteAddress));
  return headers;
}

function resolveNodeRequestHref(
  request: IncomingMessage,
  options: PreparedNodeHandlerOptions,
): string {
  const host = request.headers.host;
  if (!host) throw new NodeRequestError("Request Host header is required.");
  let base = options.hostCache.value === host ? options.hostCache.base : undefined;
  if (!base) {
    const authority = parseAuthority(host);
    if (
      options.allowedHosts.length > 0 &&
      !options.allowedHosts.some((allowed) =>
        allowed.host === undefined
          ? allowed.hostname === authority.hostname
          : allowed.host === authority.host,
      )
    )
      throw new NodeRequestError("Request Host header is not allowed.");
    base = options.baseUrl ?? `http://${authority.host}`;
    options.hostCache.value = host;
    options.hostCache.base = base;
  }
  const requestTarget = request.url || "/";
  if (requestTarget === "*") {
    if (request.method === "OPTIONS") return `${base}/*`;
    throw new NodeRequestError("Asterisk-form request targets require OPTIONS.");
  }
  if (requestTarget.startsWith("//"))
    throw new NodeRequestError("Network-path request targets are not allowed.");
  if (requestTarget.startsWith("/")) {
    if (requestTarget.includes("\\"))
      throw new NodeRequestError("Request targets must not contain backslashes.");
    if (requestTarget.includes("#"))
      throw new NodeRequestError("Request targets must not contain fragments.");
    return `${base}${requestTarget}`;
  }
  if (!/^https?:\/\//iu.test(requestTarget))
    throw new NodeRequestError("Request target must use origin-form or absolute-form.");
  let target: URL;
  try {
    target = new URL(requestTarget, base);
  } catch {
    throw new NodeRequestError("Request target is not a valid HTTP URL.");
  }
  if (target.origin !== new URL(base).origin)
    throw new NodeRequestError("Absolute-form request target origin is not allowed.");
  if (target.hash) throw new NodeRequestError("Request targets must not contain fragments.");
  return target.href;
}

export function resolveNodeRequestUrl(
  request: IncomingMessage,
  options: PreparedNodeHandlerOptions,
): URL {
  try {
    return new URL(resolveNodeRequestHref(request, options));
  } catch (error) {
    if (error instanceof NodeRequestError) throw error;
    throw new NodeRequestError("Request target is not a valid HTTP URL.");
  }
}

export function requestFromNode(
  request: IncomingMessage,
  options: PreparedNodeHandlerOptions,
  signal: AbortSignal,
): Request {
  const target = resolveNodeRequestHref(request, options);
  const method = request.method ?? "GET";
  if (method === "GET" || method === "HEAD") request.resume();
  const body = method === "GET" || method === "HEAD" ? undefined : (request as unknown as BodyInit);
  try {
    return new Request(target, {
      method,
      headers: requestHeaders(request),
      body,
      signal,
      ...(body ? { duplex: "half" as const } : {}),
    } as RequestInit & { duplex?: "half" });
  } catch {
    throw new NodeRequestError("Node request cannot be represented as a Web Request.");
  }
}
