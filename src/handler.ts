import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerApp } from "@askrjs/server";
import type { NodeHandler, NodeHandlerOptions } from "./contracts.js";
import { NodeRequestError, prepareNodeHandlerOptions, requestFromNode } from "./request.js";
import { writeNodeResponse } from "./response.js";

function minimalError(response: ServerResponse, error: unknown): void {
  if (response.headersSent || response.destroyed) {
    response.destroy(error instanceof Error ? error : undefined);
    return;
  }
  try {
    const clientError = error instanceof NodeRequestError;
    response.statusCode = clientError ? 400 : 500;
    response.statusMessage = clientError ? "Bad Request" : "Internal Server Error";
    response.setHeader("content-type", "text/plain; charset=utf-8");
    response.end(clientError ? "Bad Request" : "Internal Server Error");
  } catch {
    response.destroy(error instanceof Error ? error : undefined);
  }
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

async function handleNodeRequest(
  app: ServerApp,
  preparedOptions: ReturnType<typeof prepareNodeHandlerOptions>,
  request: IncomingMessage,
  response: ServerResponse,
  signal: AbortSignal,
  cleanup: () => void,
  next?: (error?: unknown) => void,
): Promise<void> {
  try {
    const webRequest = requestFromNode(request, preparedOptions, signal);
    const webResponse = await app.fetch(webRequest);
    await writeNodeResponse(webResponse, response, request.method);
  } catch (error) {
    if (!next) {
      minimalError(response, error);
      return;
    }
    try {
      next(error);
    } catch (nextError) {
      minimalError(response, nextError);
    }
  } finally {
    cleanup();
  }
}

/**
 * Wraps an `@askrjs/server` application as a Node-style request handler.
 *
 * Converts each incoming `IncomingMessage`/`ServerResponse` pair into a web
 * `Request`, dispatches it through `app.fetch`, and writes the resulting web
 * `Response` back to Node. Errors are reported to `next` when provided,
 * otherwise a minimal 400/500 response is written directly.
 *
 * @param app - The application to dispatch requests to.
 * @param options - Options controlling base URL resolution and host validation.
 * @returns A handler usable with `http.createServer` or Connect-style middleware.
 */
export function createNodeHandler(app: ServerApp, options: NodeHandlerOptions): NodeHandler {
  const preparedOptions = prepareNodeHandlerOptions(options);
  return (request, response, next) => {
    const controller = new AbortController();
    const cleanup = attachAbort(request, response, controller);
    void handleNodeRequest(
      app,
      preparedOptions,
      request,
      response,
      controller.signal,
      cleanup,
      next,
    );
  };
}

export default createNodeHandler;
