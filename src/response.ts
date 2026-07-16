import type { ServerResponse } from "node:http";

function writeHeaders(response: Response, target: ServerResponse): void {
  const cookies =
    typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  response.headers.forEach((value, key) => {
    if (key !== "set-cookie") target.setHeader(key, value);
  });
  if (cookies.length) target.setHeader("set-cookie", cookies);
}

function waitForDrain(response: ServerResponse): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      response.off("drain", drained);
      response.off("close", closed);
      response.off("error", failed);
    };
    const drained = () => {
      cleanup();
      resolve();
    };
    const closed = () => {
      cleanup();
      resolve();
    };
    const failed = (error: Error) => {
      cleanup();
      reject(error);
    };
    response.once("drain", drained);
    response.once("close", closed);
    response.once("error", failed);
  });
}

function disconnectError(): Error {
  const error = new Error("Node response closed before the Web response completed.");
  error.name = "AbortError";
  return error;
}

export async function writeNodeResponse(
  response: Response,
  target: ServerResponse,
  method?: string,
): Promise<void> {
  target.statusCode = response.status;
  target.statusMessage = response.statusText;
  writeHeaders(response, target);
  if (!response.body || method === "HEAD") {
    target.end();
    return;
  }
  const reader = response.body.getReader();
  let disconnected = false;
  const onClose = () => {
    disconnected = true;
    void reader.cancel(disconnectError()).catch(() => undefined);
  };
  target.once("close", onClose);
  try {
    for (;;) {
      if (disconnected) return;
      const part = await reader.read();
      if (part.done || disconnected) break;
      if (!target.write(Buffer.from(part.value))) await waitForDrain(target);
    }
    if (!disconnected) target.end();
  } catch (error) {
    if (disconnected) return;
    await reader.cancel(error).catch(() => undefined);
    target.destroy(error instanceof Error ? error : undefined);
  } finally {
    target.off("close", onClose);
  }
}
