import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import * as api from "@askrjs/node";
import * as stdio from "@askrjs/node/mcp";
import { createServerApp } from "@askrjs/server";
import { createRouter } from "@askrjs/server/router";
import { createMcpServer } from "@askrjs/server/mcp";

assert.deepEqual(Object.keys(api).sort(), [
  "CLIENT_ADDRESS_HEADER",
  "createNodeHandler",
  "listen",
  "serve",
]);
assert.deepEqual(Object.keys(stdio), ["connectMcpStdio"]);
const running = await api.serve(
  createServerApp({
    router: createRouter().get(
      "/",
      () => new Response("ok", { headers: { "content-type": " Text/HTML; charset=utf-8" } }),
    ),
  }),
  { signals: false },
);
try {
  const response = await fetch(running.url);
  assert.equal(await response.text(), "ok");
  assert.equal(response.headers.get("cache-control"), "no-cache");
} finally {
  await running.close();
}

const input = new PassThrough(),
  output = new PassThrough(),
  diagnostics = new PassThrough();
const lines = [];
output.on("data", (chunk) => lines.push(JSON.parse(chunk.toString())));
const connection = stdio.connectMcpStdio(createMcpServer({ name: "packed", version: "1" }), {
  dependencies: undefined,
  input,
  output,
  diagnostics,
});
try {
  input.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "packed", version: "1" } } })}\n`,
  );
  await setImmediate();
  assert.equal(lines[0]?.result?.protocolVersion, "2025-11-25");
  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`);
  await setImmediate();
  assert.deepEqual(lines.slice(1), [{ jsonrpc: "2.0", id: 1, result: {} }]);
  assert.equal(diagnostics.read(), null);
} finally {
  await connection.close();
  input.destroy();
  output.destroy();
  diagnostics.destroy();
}
assert.equal(input.listenerCount("data"), 0);
