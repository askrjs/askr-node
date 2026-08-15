import { addAbortListener } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ServerApp } from "@askrjs/server";
import type { ListenOptions } from "./contracts.js";
import { handlerOptionsForHost, resolveBindHost } from "./bind.js";
import { createNodeHandler } from "./handler.js";
import { applyServerTimeouts, resolveServerOptions } from "./server-options.js";
import { installWebSockets } from "./websocket.js";

/** A Node HTTP server that is guaranteed to be listening for connections. */
export type ListeningServer = Server & {
  address(): AddressInfo | string | null;
};

/**
 * Starts a Node HTTP server for an `@askrjs/server` application and resolves once it is listening.
 *
 * Optionally installs WebSocket support and wires up graceful shutdown on
 * `options.signal`. Unlike {@link serve}, this does not serve static assets
 * or install OS signal handlers.
 *
 * @param app - The application to serve.
 * @param options - Listen options such as port, host, timeouts, and WebSocket support.
 * @returns A promise resolving to the listening server once it has bound successfully.
 * @example
 * const server = await listen(app, { port: 3000 });
 */
export function listen(app: ServerApp, options: ListenOptions = {}): Promise<ListeningServer> {
  options.signal?.throwIfAborted();
  const host = resolveBindHost(options);
  const handlerOptions = handlerOptionsForHost(options, host);
  const server = createServer(
    resolveServerOptions(options),
    createNodeHandler(app, handlerOptions),
  );
  applyServerTimeouts(server, options);
  const webSockets = options.websocket
    ? installWebSockets(
        server,
        app,
        options.websocket === true ? {} : options.websocket,
        handlerOptions,
      )
    : undefined;
  if (webSockets) {
    const nativeClose = server.close.bind(server);
    server.close = ((callback?: (error?: Error) => void) => {
      let remaining = 2;
      let closeError: Error | undefined;
      const complete = (error?: Error) => {
        closeError ??= error;
        remaining -= 1;
        if (remaining === 0) callback?.(closeError);
      };
      nativeClose(complete);
      void webSockets.close().then(() => complete(), complete);
      return server;
    }) as Server["close"];
  }
  const close = () => server.close();
  const abortListener = options.signal ? addAbortListener(options.signal, close) : undefined;
  const disposeAbortListener = () => abortListener?.[Symbol.dispose]();
  server.once("close", disposeAbortListener);
  return new Promise((resolve, reject) => {
    const onClose = () => {
      server.off("error", onError);
      reject(
        options.signal?.reason ?? new Error("Node server closed before it started listening."),
      );
    };
    const onError = (error: Error) => {
      server.off("close", onClose);
      disposeAbortListener();
      reject(error);
    };
    server.once("error", onError);
    server.once("close", onClose);
    server.listen(options.port ?? 0, host, options.backlog, () => {
      server.off("error", onError);
      server.off("close", onClose);
      resolve(server as ListeningServer);
    });
  });
}
