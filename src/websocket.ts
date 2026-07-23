import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { ServerApp, ServerContext, WebSocketHandler, WebSocketLike } from "@askrjs/server";
import { WebSocket, WebSocketServer } from "ws";
import type { NodeHandlerOptions, NodeWebSocketOptions } from "./contracts.js";
import { requestFromNode } from "./request.js";

function subscribe<T extends unknown[]>(
  socket: WebSocket,
  event: string,
  listener: (...values: T) => void,
): () => void {
  socket.on(event, listener);
  return () => socket.off(event, listener);
}

function socketLike(socket: WebSocket): WebSocketLike {
  return {
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    onMessage: (listener) =>
      subscribe(socket, "message", (data: WebSocket.RawData, binary: boolean) => {
        if (!binary) listener(data.toString());
        else {
          const buffer = Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data as ArrayBuffer);
          listener(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
        }
      }),
    onClose: (listener) =>
      subscribe(socket, "close", (code: number, reason: Buffer) =>
        listener({ code, reason: reason.toString(), wasClean: code === 1000 }),
      ),
    onError: (listener) => subscribe(socket, "error", listener),
  };
}

async function rejectUpgrade(socket: Duplex, response: Response): Promise<void> {
  const body = Buffer.from(await response.arrayBuffer());
  const lines = [`HTTP/1.1 ${response.status} ${response.statusText || "Rejected"}`];
  response.headers.forEach((value, name) => lines.push(`${name}: ${value}`));
  if (!response.headers.has("content-length")) lines.push(`content-length: ${body.byteLength}`);
  lines.push("connection: close", "", "");
  socket.end(Buffer.concat([Buffer.from(lines.join("\r\n")), body]));
}

export function installWebSockets(
  server: Server,
  app: ServerApp,
  options: NodeWebSocketOptions = {},
  handlerOptions: NodeHandlerOptions = {},
): { close(): void } {
  const webSockets = new WebSocketServer({
    noServer: true,
    maxPayload: options.maxPayload ?? 1_048_576,
    perMessageDeflate: options.perMessageDeflate ?? false,
  });
  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const controller = new AbortController();
    let accepted:
      | { handler: WebSocketHandler; context: ServerContext; response: Response }
      | undefined;
    void Promise.resolve()
      .then(() => requestFromNode(request, handlerOptions, controller.signal))
      .then(async (webRequest) => {
        const origin = request.headers.origin;
        const allowedOrigins = options.allowedOrigins ?? [new URL(webRequest.url).origin];
        if (!origin || !allowedOrigins.includes(new URL(origin).origin)) {
          await rejectUpgrade(socket, new Response("Forbidden", { status: 403 }));
          return;
        }
        let marker: Response | undefined;
        const response = await app.fetch(webRequest, {
          websocket: {
            upgrade: (_request, handler, context) => {
              marker = new Response(null, { status: 200 });
              accepted = { handler, context, response: marker };
              return marker;
            },
          },
        });
        if (!accepted || response !== accepted.response) {
          await rejectUpgrade(socket, response);
          return;
        }
        webSockets.handleUpgrade(request, socket, head, (webSocket) => {
          webSocket.once("close", () => controller.abort());
          Promise.resolve(accepted!.handler(socketLike(webSocket), accepted!.context)).catch(() =>
            webSocket.close(1011, "WebSocket handler failed"),
          );
        });
      })
      .catch(() => socket.destroy());
  });
  return {
    close() {
      for (const socket of webSockets.clients) socket.close(1001, "Server shutting down");
      webSockets.close();
    },
  };
}
