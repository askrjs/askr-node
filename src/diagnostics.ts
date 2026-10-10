import type { Writable } from "node:stream";
import { streamWriter } from "./stream-writer.js";

/** Own error events until the associated diagnostic writes settle, even after shutdown. */
export function diagnosticReporter(stream: Writable): (error: unknown) => void {
  const write = streamWriter(stream);
  return (error) => {
    if (stream.destroyed) return;
    try {
      void write(
        `MCP stdio error: ${error instanceof Error ? error.message : String(error)}\n`,
      ).catch(() => undefined);
    } catch {
      // Formatting an arbitrary thrown value is also best-effort.
    }
  };
}
