import { Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { diagnosticReporter } from "../src/diagnostics.js";

describe("best-effort MCP diagnostics", () => {
  it("handles asynchronous failures once, preserves caller listeners and skips destroyed diagnostics", async () => {
    const failure = new Error("async write failed");
    const stream = new Writable({
      write(_chunk, _encoding, callback) {
        setImmediate().then(() => callback(failure));
      },
    });
    const existing = vi.fn();
    stream.on("error", existing);
    const report = diagnosticReporter(stream);
    for (let index = 0; index < 32; index++) report("failure");
    expect(stream.listenerCount("error")).toBe(2);
    await setImmediate();
    await setImmediate();
    expect(existing).toHaveBeenCalledExactlyOnceWith(failure);
    expect(stream.listenerCount("error")).toBe(1);
    report("after destruction");
    expect(stream.listenerCount("error")).toBe(1);
  });
  it("shares one error listener across pending writes and releases it on successful completion", async () => {
    const callbacks: Array<(error?: Error | null) => void> = [];
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        callbacks.push(callback);
      },
    });
    const existing = vi.fn();
    stream.on("error", existing);
    const report = diagnosticReporter(stream);
    for (let index = 0; index < 32; index++) report(new Error(`failure ${index}`));
    expect(stream.listenerCount("error")).toBe(2);
    for (let index = 0; index < 32; index++) callbacks[index]();
    await setImmediate();
    expect(chunks).toHaveLength(32);
    expect(chunks[0]).toBe("MCP stdio error: failure 0\n");
    expect(stream.listenerCount("error")).toBe(1);
    expect(existing).not.toHaveBeenCalled();
    stream.destroy();
  });

  it("ignores synchronous diagnostic failures without removing caller listeners", () => {
    const stream = new Writable({
      write() {
        throw new Error("write failed");
      },
    });
    const existing = vi.fn();
    stream.on("error", existing);
    expect(() => diagnosticReporter(stream)("report")).not.toThrow();
    expect(stream.listenerCount("error")).toBe(1);
    stream.destroy();
  });
});
