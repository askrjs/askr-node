import { addAbortListener } from "node:events";

/** Buffer a bounded rejection while retaining ownership until completion or disconnect. */
export async function readRejectionBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer | undefined> {
  if (signal.aborted) {
    void response.body?.cancel(signal.reason).catch(() => undefined);
    signal.throwIfAborted();
  }
  const lengthHeader = response.headers.get("content-length");
  const declaredLength = lengthHeader === null ? undefined : Number(lengthHeader);
  if (
    declaredLength !== undefined &&
    Number.isFinite(declaredLength) &&
    declaredLength > maxBytes
  ) {
    void response.body
      ?.cancel("WebSocket rejection body exceeded maxRejectionBodyBytes")
      .catch(() => undefined);
    return undefined;
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const listener = addAbortListener(signal, () => {
    void reader.cancel(signal.reason).catch(() => undefined);
    rejectAbort(signal.reason);
  });
  const consume = async () => {
    const chunks: Buffer[] = [];
    let length = 0;
    for (;;) {
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) return Buffer.concat(chunks, length);
      length += part.value.byteLength;
      if (length > maxBytes) {
        void reader
          .cancel("WebSocket rejection body exceeded maxRejectionBodyBytes")
          .catch(() => undefined);
        return undefined;
      }
      chunks.push(Buffer.from(part.value));
    }
  };
  try {
    return await Promise.race([consume(), aborted]);
  } catch (error) {
    void reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    listener[Symbol.dispose]();
    reader.releaseLock();
  }
}
