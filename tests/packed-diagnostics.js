import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { connectMcpStdio } from "@askrjs/node/mcp";

const input = new PassThrough(),
  output = new PassThrough();
let failed = false,
  terminated = 0;
const diagnostics = new Writable({
  write(_chunk, _encoding, callback) {
    setImmediate().then(() => {
      failed = true;
      callback(new Error("diagnostics unavailable"));
    });
  },
});
const connection = connectMcpStdio(
  {
    handle() {
      throw new Error("request failed");
    },
    terminateSession() {
      terminated++;
    },
  },
  {
    dependencies: undefined,
    input,
    output,
    diagnostics,
  },
);
input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`);
await connection.close();
await setImmediate();
await setImmediate();
assert.equal(failed, true);
assert.equal(terminated, 1);
assert.equal(diagnostics.listenerCount("error"), 0);
input.destroy();
output.destroy();
diagnostics.destroy();
