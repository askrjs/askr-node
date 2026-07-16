import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ServerApp } from "@askrjs/server";
import type { ListenOptions } from "./contracts.js";
import { createNodeHandler } from "./handler.js";

export type ListeningServer = Server & {
  address(): AddressInfo | string | null;
};

export function listen(app: ServerApp, options: ListenOptions = {}): Promise<ListeningServer> {
  const server = createServer(createNodeHandler(app));
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
