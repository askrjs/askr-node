import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ServerApp } from "@askrjs/server";
import type { ListenOptions } from "./contracts.js";
import { createNodeHandler } from "./handler.js";
import { installWebSockets } from "./websocket.js";

export type ListeningServer = Server & {
  address(): AddressInfo | string | null;
};

export function listen(app: ServerApp, options: ListenOptions = {}): Promise<ListeningServer> {
  const handlerOptions = {
    allowedHosts: [options.host ?? "127.0.0.1", "localhost"],
  };
  const server = createServer(createNodeHandler(app, handlerOptions));
  if (options.requestTimeout !== undefined) server.requestTimeout = options.requestTimeout;
  if (options.headersTimeout !== undefined) server.headersTimeout = options.headersTimeout;
  if (options.keepAliveTimeout !== undefined) server.keepAliveTimeout = options.keepAliveTimeout;
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
      webSockets.close();
      return nativeClose(callback);
    }) as Server["close"];
  }
  const close = () => server.close();
  options.signal?.addEventListener("abort", close, { once: true });
  server.once("close", () => options.signal?.removeEventListener("abort", close));
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      options.signal?.removeEventListener("abort", close);
      reject(error);
    };
    server.once("error", onError);
    server.listen(options.port ?? 0, options.host, options.backlog, () => {
      server.off("error", onError);
      resolve(server as ListeningServer);
    });
  });
}
