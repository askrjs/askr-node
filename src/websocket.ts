import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { ServerApp, ServerContext, WebSocketHandler, WebSocketLike } from "@askrjs/server";
import { WebSocket, WebSocketServer } from "ws";
import type { NodeHandlerOptions, NodeWebSocketOptions } from "./contracts.js";
import { prepareNodeHandlerOptions, requestFromNode } from "./request.js";

function subscribe<T extends unknown[]>(
  socket: WebSocket,
  event: string,
  listener: (...values: T) => void,
): () => void {
  socket.on(event, listener);
  return () => socket.off(event, listener);
}

function notify<T extends unknown[]>(
  socket: WebSocket,
  listener: (...values: T) => void,
  ...values: T
): void {
  try {
    listener(...values);
  } catch {
    if (socket.readyState === WebSocket.OPEN) socket.close(1011, "WebSocket listener failed");
  }
}

function socketLike(socket: WebSocket): WebSocketLike {
  return {
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    onMessage: (listener) =>
      subscribe(socket, "message", (data: WebSocket.RawData, binary: boolean) => {
        if (!binary) notify(socket, listener, data.toString());
        else {
          const buffer = Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data as ArrayBuffer);
          notify(
            socket,
            listener,
            new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
          );
        }
      }),
    onClose: (listener) =>
      subscribe(socket, "close", (code: number, reason: Buffer) =>
        notify(socket, listener, { code, reason: reason.toString(), wasClean: code !== 1006 }),
      ),
    onError: (listener) =>
      subscribe(socket, "error", (error: Error) => notify(socket, listener, error)),
  };
}

function normalizeHttpOrigin(value: string): string {
  const parsed = new URL(value);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new TypeError("WebSocket origins must be HTTP or HTTPS origins.");
  }
  return parsed.origin;
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
    await response.body
      ?.cancel("WebSocket rejection body exceeded maxRejectionBodyBytes")
      .catch(() => undefined);
    return undefined;
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) return Buffer.concat(chunks, length);
      length += part.value.byteLength;
      if (length > maxBytes) {
        await reader
          .cancel("WebSocket rejection body exceeded maxRejectionBodyBytes")
          .catch(() => undefined);
        return undefined;
      }
      chunks.push(Buffer.from(part.value));
    }
  } finally {
    reader.releaseLock();
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
  const cookies = response.headers.getSetCookie();
  response.headers.forEach((value, name) => {
    if (
      name !== "connection" &&
      name !== "content-length" &&
      name !== "set-cookie" &&
      name !== "transfer-encoding" &&
      name !== "upgrade"
    )
      lines.push(`${name}: ${value}`);
  });
  for (const cookie of cookies) lines.push(`set-cookie: ${cookie}`);
  lines.push(`content-length: ${body.byteLength}`);
  lines.push("connection: close", "", "");
  socket.end(Buffer.concat([Buffer.from(lines.join("\r\n")), body]));
}

export function installWebSockets(
  server: Server,
  app: ServerApp,
  options: NodeWebSocketOptions,
  handlerOptions: NodeHandlerOptions,
): { close(): Promise<void> } {
  const closeTimeout = options.closeTimeout ?? 5_000;
  if (!Number.isSafeInteger(closeTimeout) || closeTimeout < 0)
    throw new TypeError("WebSocket closeTimeout must be a non-negative safe integer.");
  const maxRejectionBodyBytes = options.maxRejectionBodyBytes ?? 65_536;
  if (!Number.isSafeInteger(maxRejectionBodyBytes) || maxRejectionBodyBytes <= 0) {
    throw new TypeError("WebSocket maxRejectionBodyBytes must be a positive integer.");
  }
  const maxPayload = options.maxPayload ?? 1_048_576;
  if (!Number.isSafeInteger(maxPayload) || maxPayload < 0)
    throw new TypeError("WebSocket maxPayload must be a non-negative safe integer.");
  const preparedHandlerOptions = prepareNodeHandlerOptions(handlerOptions);
  const configuredAllowedOrigins = options.allowedOrigins?.map((origin) => {
    try {
      return normalizeHttpOrigin(origin);
    } catch {
      throw new TypeError(`WebSocket allowedOrigins contains an invalid origin: ${origin}`);
    }
  });
  const webSockets = new WebSocketServer({
    noServer: true,
    maxPayload,
    perMessageDeflate: options.perMessageDeflate ?? false,
  });
  const pending = new Map<Duplex, AbortController>();
  let closing: Promise<void> | undefined;
  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (closing) {
      socket.destroy();
      return;
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    const cleanupPending = () => {
      pending.delete(socket);
      socket.off("close", abort);
      socket.off("end", abort);
      socket.off("error", abort);
    };
    pending.set(socket, controller);
    socket.once("close", abort);
    socket.once("end", abort);
    socket.once("error", abort);
    let accepted:
      | { handler: WebSocketHandler; context: ServerContext; response: Response }
      | undefined;
    let upgraded = false;
    void Promise.resolve()
      .then(() => requestFromNode(request, preparedHandlerOptions, controller.signal))
      .then(async (webRequest) => {
        if (controller.signal.aborted) return;
        const originHeader = request.headers.origin;
        const origin = Array.isArray(originHeader) ? undefined : originHeader;
        const allowedOrigins = configuredAllowedOrigins ?? [new URL(webRequest.url).origin];
        let normalizedOrigin: string | undefined;
        try {
          normalizedOrigin = origin ? normalizeHttpOrigin(origin) : undefined;
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
          upgraded = true;
          cleanupPending();
          webSocket.on("error", () => undefined);
          webSocket.once("close", () => controller.abort());
          void Promise.resolve()
            .then(() => accepted!.handler(socketLike(webSocket), accepted!.context))
            .catch(() => webSocket.close(1011, "WebSocket handler failed"));
        });
      })
      .catch(() => socket.destroy())
      .finally(() => {
        if (!upgraded) {
          cleanupPending();
          controller.abort();
        }
      });
  };
  server.on("upgrade", onUpgrade);
  return {
    close() {
      return (closing ??= new Promise<void>((resolve, reject) => {
        let settled = false;
        let forceClose: NodeJS.Timeout | undefined;
        const complete = (error?: Error) => {
          if (settled) return;
          settled = true;
          if (forceClose) clearTimeout(forceClose);
          if (error) reject(error);
          else resolve();
        };
        server.off("upgrade", onUpgrade);
        for (const [socket, controller] of pending) {
          controller.abort();
          socket.destroy();
        }
        pending.clear();
        for (const socket of webSockets.clients) socket.close(1001, "Server shutting down");
        if (webSockets.clients.size > 0) {
          forceClose = setTimeout(() => {
            for (const socket of webSockets.clients) socket.terminate();
            complete();
          }, closeTimeout);
          forceClose.unref();
        }
        webSockets.close(complete);
      }));
    },
  };
}
