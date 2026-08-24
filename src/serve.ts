import { addAbortListener } from "node:events";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { pipeline } from "node:stream";
import type { ServerApp } from "@askrjs/server";
import * as serverHttp from "@askrjs/server/http";
import type { ServeOptions, ServedApplication } from "./contracts.js";
import { formatHostForUrl, handlerOptionsForHost, resolveBindHost } from "./bind.js";
import { createNodeHandler } from "./handler.js";
import { prepareNodeHandlerOptions, resolveNodeRequestUrl } from "./request.js";
import { applyServerTimeouts, resolveServerOptions } from "./server-options.js";
import { installWebSockets } from "./websocket.js";

const mimeTypes: Readonly<Record<string, string>> = {
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webm": "video/webm",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const parseContentType =
  (serverHttp as { contentType?: (value: string | null) => string | undefined }).contentType ??
  ((value: string | null): string | undefined => {
    if (!value) return undefined;
    const separator = value.indexOf(";");
    const type = (separator === -1 ? value : value.slice(0, separator)).trim();
    return type ? type.toLowerCase() : undefined;
  });

function isAssetPath(pathname: string): boolean {
  return extname(pathname) !== "";
}

function isWithinRoot(root: string, candidate: string): boolean {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate === root || candidate.startsWith(prefix);
}

/**
 * Serves an `@askrjs/server` application over Node HTTP, with optional static
 * asset serving, WebSocket support, and graceful shutdown on OS signals or an
 * abort signal.
 *
 * Requests for paths with a file extension are first checked against
 * `options.assets.root` (path-traversal safe, following symlinks) and served
 * directly with appropriate `content-type`/`cache-control` headers before
 * falling back to the application handler. HTML responses from the
 * application get a `no-cache` header when they don't already set
 * `cache-control`.
 *
 * @param app - The application to serve; may expose an optional `close()` for cleanup.
 * @param options - Serve options such as port, host, static assets, and shutdown signals.
 * @returns The served application, including its bound `url` and a `close()` for shutdown.
 * @example
 * const app = await serve(myApp, { port: 3000, assets: { root: "./public" } });
 * // ...
 * await app.close();
 */
export async function serve(
  app: ServerApp & { close?: () => void | Promise<void> },
  options: ServeOptions = {},
): Promise<ServedApplication> {
  options.signal?.throwIfAborted();
  const host = resolveBindHost(options);
  const root = options.assets ? await realpath(resolve(options.assets.root)) : undefined;
  const handlerOptions = handlerOptionsForHost(options, host);
  const preparedHandlerOptions = prepareNodeHandlerOptions(handlerOptions);
  const applicationHandler = createNodeHandler(
    {
      async fetch(request, dispatchOptions) {
        const result = await app.fetch(request, dispatchOptions);
        const responseContentType = parseContentType(result.headers.get("content-type"));
        if (!result.headers.has("cache-control") && responseContentType === "text/html") {
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
    },
    handlerOptions,
  );
  const server = createServer(resolveServerOptions(options), async (request, response) => {
    if (!root) {
      applicationHandler(request, response);
      return;
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(
        resolveNodeRequestUrl(request, preparedHandlerOptions).pathname,
      );
    } catch {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("Bad Request");
      return;
    }
    const method = request.method ?? "GET";
    if (
      (method === "GET" || method === "HEAD") &&
      isAssetPath(pathname) &&
      !options.assets?.exclude?.(pathname)
    ) {
      const extension = extname(pathname).toLowerCase();
      const unresolvedCandidate = resolve(root, `.${pathname}`);
      const inside = isWithinRoot(root, unresolvedCandidate);
      let candidate: string | undefined;
      let file: Awaited<ReturnType<typeof stat>> | undefined;
      if (inside && extension !== ".map") {
        try {
          const [resolvedCandidate, candidateFile] = await Promise.all([
            realpath(unresolvedCandidate),
            stat(unresolvedCandidate),
          ]);
          if (isWithinRoot(root, resolvedCandidate)) {
            candidate = resolvedCandidate;
            file = candidateFile;
          }
        } catch {
          candidate = undefined;
          file = undefined;
        }
      }
      if (!candidate || !file?.isFile()) {
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
      else pipeline(createReadStream(candidate), response, () => undefined);
      return;
    }
    applicationHandler(request, response);
  });
  applyServerTimeouts(server, options);
  const webSockets = options.websocket
    ? installWebSockets(
        server,
        app,
        options.websocket === true ? {} : options.websocket,
        handlerOptions,
      )
    : undefined;

  let closing: Promise<void> | undefined;
  let serverClosed = false;
  server.once("close", () => {
    serverClosed = true;
  });
  const signals = options.signals === false ? [] : (options.signals ?? ["SIGINT", "SIGTERM"]);
  let abortListener: Disposable | undefined;
  const removeListeners = () => {
    abortListener?.[Symbol.dispose]();
    for (const signal of signals) process.removeListener(signal, shutdown);
  };
  const close = () =>
    (closing ??= (async () => {
      removeListeners();
      const closeServer = new Promise<void>((resolveClose, rejectClose) => {
        if (serverClosed) {
          resolveClose();
          return;
        }
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
      const results = await Promise.allSettled([closeServer, webSockets?.close()]);
      const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      try {
        await app.close?.();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1)
        throw new AggregateError(errors, "Failed to close served application.");
    })());
  const shutdown = () => void close().catch(() => undefined);
  if (options.signal) abortListener = addAbortListener(options.signal, shutdown);
  for (const signal of signals) process.once(signal, shutdown);

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error) => {
      server.off("close", onClose);
      rejectListen(error);
    };
    const onClose = () => {
      server.off("error", onError);
      rejectListen(
        options.signal?.reason ?? new Error("Node server closed before it started listening."),
      );
    };
    server.once("error", onError);
    server.once("close", onClose);
    server.listen(options.port ?? 0, host, options.backlog, () => {
      server.off("error", onError);
      server.off("close", onClose);
      resolveListen();
    });
  }).catch(async (error) => {
    removeListeners();
    await close().catch(() => undefined);
    throw error;
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await close();
    throw new Error("serve requires a TCP address.");
  }
  return Object.freeze({ server, url: `http://${formatHostForUrl(host)}:${address.port}`, close });
}
