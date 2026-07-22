import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import type { ServerApp } from "@askrjs/server";
import type { ServeOptions, ServedApplication } from "./contracts.js";
import { createNodeHandler } from "./handler.js";
import { installWebSockets } from "./websocket.js";

const mimeTypes: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function isAssetPath(pathname: string): boolean {
  return extname(pathname) !== "";
}

export async function serve(
  app: ServerApp & { close?: () => void | Promise<void> },
  options: ServeOptions = {},
): Promise<ServedApplication> {
  const root = options.assets ? resolve(options.assets.root) : undefined;
  const applicationHandler = createNodeHandler({
    async fetch(request, dispatchOptions) {
      const result = await app.fetch(request, dispatchOptions);
      if (
        !result.headers.has("cache-control") &&
        result.headers.get("content-type")?.includes("text/html")
      ) {
        const headers = new Headers(result.headers);
        headers.set("cache-control", "no-cache");
        return new Response(result.body, {
          status: result.status,
          statusText: result.statusText,
          headers,
        });
      }
      return result;
    },
  });
  const server = createServer(async (request, response) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(request.url ?? "/", "http://askr.local").pathname);
    } catch {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("Bad Request");
      return;
    }
    const method = request.method ?? "GET";
    if (root && (method === "GET" || method === "HEAD") && isAssetPath(pathname)) {
      const extension = extname(pathname).toLowerCase();
      const candidate = resolve(root, `.${pathname}`);
      const inside = candidate.startsWith(`${root}${sep}`);
      let file: Awaited<ReturnType<typeof stat>> | undefined;
      if (inside && extension !== ".map") {
        try {
          file = await stat(candidate);
        } catch {
          file = undefined;
        }
      }
      if (!file?.isFile()) {
        response
          .writeHead(404, {
            "content-type": "text/plain; charset=utf-8",
            "x-content-type-options": "nosniff",
          })
          .end("Not Found");
        return;
      }
      response.writeHead(200, {
        "content-type": mimeTypes[extension] ?? "application/octet-stream",
        "content-length": Number(file.size),
        "cache-control":
          pathname.startsWith("/assets/") && /-[A-Za-z0-9_-]{8,}\.[^.]+$/.test(pathname)
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        "x-content-type-options": "nosniff",
      });
      if (method === "HEAD") response.end();
      else createReadStream(candidate).pipe(response);
      return;
    }
    applicationHandler(request, response);
  });
  if (options.requestTimeout !== undefined) server.requestTimeout = options.requestTimeout;
  if (options.headersTimeout !== undefined) server.headersTimeout = options.headersTimeout;
  if (options.keepAliveTimeout !== undefined) server.keepAliveTimeout = options.keepAliveTimeout;
  const webSockets = options.websocket
    ? installWebSockets(server, app, options.websocket === true ? {} : options.websocket)
    : undefined;

  let closing: Promise<void> | undefined;
  const signals = options.signals === false ? [] : (options.signals ?? ["SIGINT", "SIGTERM"]);
  const removeListeners = () => {
    options.signal?.removeEventListener("abort", shutdown);
    for (const signal of signals) process.removeListener(signal, shutdown);
  };
  const close = () =>
    (closing ??= new Promise<void>((resolveClose, rejectClose) => {
      removeListeners();
      webSockets?.close();
      const finish = async (serverError?: Error) => {
        try {
          await app.close?.();
          if (serverError) rejectClose(serverError);
          else resolveClose();
        } catch (error) {
          rejectClose(error);
        }
      };
      if (!server.listening) void finish();
      else server.close((error) => void finish(error));
    }));
  const shutdown = () => void close().catch(() => undefined);
  options.signal?.addEventListener("abort", shutdown, { once: true });
  for (const signal of signals) process.once(signal, shutdown);

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", options.backlog, () => {
      server.removeListener("error", rejectListen);
      resolveListen();
    });
  }).catch((error) => {
    removeListeners();
    throw error;
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await close();
    throw new Error("serve requires a TCP address.");
  }
  const host = options.host ?? "127.0.0.1";
  return Object.freeze({ server, url: `http://${host}:${address.port}`, close });
}
