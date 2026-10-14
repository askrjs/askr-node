import type { Writable } from "node:stream";

/** Own error events until writes settle, independently of the connection lifecycle. */
export function streamWriter(stream: Writable): (chunk: string) => Promise<void> {
  let pending = 0;
  const failed = () => {
    pending = 0;
  };
  const completed = () => {
    if (pending > 0 && --pending === 0) stream.off("error", failed);
  };
  return (chunk) =>
    new Promise<void>((resolve, reject) => {
      if (pending++ === 0) stream.once("error", failed);
      try {
        stream.write(chunk, (error) => {
          if (error) {
            // Node emits the error after calling the failed write's callback.
            reject(error);
          } else {
            completed();
            resolve();
          }
        });
      } catch (error) {
        completed();
        reject(error);
      }
    });
}
