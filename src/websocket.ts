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

async function readRejectionBody(
  response: Response,
  maxBytes: number,
): Promise<Buffer | undefined> {
  const lengthHeader = response.headers.get("content-length");
  const declaredLength = lengthHeader === null ? undefined : Number(lengthHeader);
  if (
    declaredLength !== undefined &&
    Number.isFinite(declaredLength) &&
    declaredLength > maxBytes
  ) {
    await response.body?.cancel("WebSocket rejection body exceeded maxRejectionBodyBytes");
    return undefined;
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let length = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) return Buffer.concat(chunks, length);
    length += part.value.byteLength;
    if (length > maxBytes) {
      await reader.cancel("WebSocket rejection body exceeded maxRejectionBodyBytes");
      return undefined;
    }
    chunks.push(Buffer.from(part.value));
  }
}

async function rejectUpgrade(
  socket: Duplex,
  response: Response,
  maxBodyBytes: number,
): Promise<void> {
  const buffered = await readRejectionBody(response, maxBodyBytes);
  if (!buffered) {
    response = new Response("WebSocket rejection body exceeded configured limit", { status: 500 });
  }
  const body = buffered ?? Buffer.from(await response.arrayBuffer());
  const lines = [`HTTP/1.1 ${response.status} ${response.statusText || "Rejected"}`];
  response.headers.forEach((value, name) => {
    if (name !== "content-length" && name !== "transfer-encoding") lines.push(`${name}: ${value}`);
  });
  lines.push(`content-length: ${body.byteLength}`);
  lines.push("connection: close", "", "");
  socket.end(Buffer.concat([Buffer.from(lines.join("\r\n")), body]));
}

export function installWebSockets(
  server: Server,
  app: ServerApp,
  options: NodeWebSocketOptions = {},
  handlerOptions: NodeHandlerOptions = {},
): { close(): void } {
  const maxRejectionBodyBytes = options.maxRejectionBodyBytes ?? 65_536;
  if (!Number.isInteger(maxRejectionBodyBytes) || maxRejectionBodyBytes <= 0) {
    throw new TypeError("WebSocket maxRejectionBodyBytes must be a positive integer.");
  }
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
        const originHeader = request.headers.origin;
        const origin = Array.isArray(originHeader) ? undefined : originHeader;
        const allowedOrigins = options.allowedOrigins ?? [new URL(webRequest.url).origin];
        let normalizedOrigin: string | undefined;
        try {
          normalizedOrigin = origin ? new URL(origin).origin : undefined;
        } catch {
          normalizedOrigin = undefined;
        }
        if (!normalizedOrigin || !allowedOrigins.includes(normalizedOrigin)) {
          await rejectUpgrade(
            socket,
            new Response("Forbidden", { status: 403 }),
            maxRejectionBodyBytes,
          );
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
          await rejectUpgrade(socket, response, maxRejectionBodyBytes);
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
