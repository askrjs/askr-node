import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerApp } from "@askrjs/server";
import type { NodeHandler, NodeHandlerOptions } from "./contracts.js";
import { NodeRequestError, requestFromNode } from "./request.js";
import { writeNodeResponse } from "./response.js";

function minimalError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.destroy(error instanceof Error ? error : undefined);
    return;
  }
  const clientError = error instanceof NodeRequestError;
  response.statusCode = clientError ? 400 : 500;
  response.statusMessage = clientError ? "Bad Request" : "Internal Server Error";
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.end(clientError ? "Bad Request" : "Internal Server Error");
}

function attachAbort(
  request: IncomingMessage,
  response: ServerResponse,
  controller: AbortController,
): () => void {
  const abort = () => controller.abort();
  const close = () => {
    if (request.aborted || !request.complete) abort();
  };
  request.once("aborted", abort);
  request.once("error", abort);
  request.once("close", close);
  response.once("close", abort);
  return () => {
    request.off("aborted", abort);
    request.off("error", abort);
    request.off("close", close);
    response.off("close", abort);
  };
}

export function createNodeHandler(app: ServerApp, options: NodeHandlerOptions = {}): NodeHandler {
  return (request, response, next) => {
    const controller = new AbortController();
    const cleanup = attachAbort(request, response, controller);
    Promise.resolve()
      .then(() => requestFromNode(request, options, controller.signal))
      .then((webRequest) => app.fetch(webRequest))
      .then((webResponse) => writeNodeResponse(webResponse, response, request.method))
      .catch((error) => (next ? next(error) : minimalError(response, error)))
      .finally(cleanup);
  };
}

export default createNodeHandler;
