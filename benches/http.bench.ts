import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, test } from "vite-plus/test";
import { createNodeHandler } from "../src/handler.js";
import { prepareNodeHandlerOptions, requestFromNode } from "../src/request.js";
import { writeNodeResponse } from "../src/response.js";
import { serve } from "../src/serve.js";

const JSON_BODY = '{"ok":true}';
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const preparedOptions = prepareNodeHandlerOptions({ allowedHosts: ["127.0.0.1"] });
const BENCH_OPTIONS = { time: 2_000, warmupTime: 500 };

class BenchmarkRequest extends EventEmitter {
  readonly complete = true;
  readonly headers = { host: "127.0.0.1" };
  readonly method = "GET";
  readonly socket = { remoteAddress: "127.0.0.1" };
  readonly url = "/json";

  resume(): this {
    return this;
  }
}

class BenchmarkResponse extends EventEmitter {
  statusCode = 200;
  statusMessage = "";
  readonly completed: Promise<void>;
  private finish!: () => void;

  constructor() {
    super();
    this.completed = new Promise((resolve) => {
      this.finish = resolve;
    });
  }

  destroy(): this {
    this.finish();
    return this;
  }

  end(): this {
    this.finish();
    return this;
  }

  setHeader(): this {
    return this;
  }

  write(): boolean {
    return true;
  }
}

function nodeRequest(): IncomingMessage {
  return new BenchmarkRequest() as unknown as IncomingMessage;
}

function nodeResponse(): BenchmarkResponse & ServerResponse {
  return new BenchmarkResponse() as BenchmarkResponse & ServerResponse;
}

describe("Node HTTP adapter", () => {
  const request = nodeRequest();

  test("should create the equivalent Web Request directly", async ({ bench }) => {
    await bench("create the equivalent Web Request directly", () => {
      new Request("http://127.0.0.1/json", {
        headers: new Headers({ host: "127.0.0.1" }),
        method: "GET",
        signal: new AbortController().signal,
      });
    }).run(BENCH_OPTIONS);
  });

  test("should convert an origin-form GET request", async ({ bench }) => {
    await bench("convert an origin-form GET request", () => {
      requestFromNode(request, preparedOptions, new AbortController().signal);
    }).run(BENCH_OPTIONS);
  });

  test("should write an empty Web response", async ({ bench }) => {
    await bench("write an empty Web response", async () => {
      await writeNodeResponse(new Response(null, { status: 204 }), nodeResponse(), "GET");
    }).run(BENCH_OPTIONS);
  });

  test("should write a small Web response body", async ({ bench }) => {
    await bench("write a small Web response body", async () => {
      await writeNodeResponse(
        new Response(JSON_BODY, { headers: JSON_HEADERS }),
        nodeResponse(),
        "GET",
      );
    }).run(BENCH_OPTIONS);
  });

  const emptyHandler = createNodeHandler(
    { fetch: () => Promise.resolve(new Response(null, { status: 204 })) },
    { allowedHosts: ["127.0.0.1"] },
  );
  test("should handle an empty Web response end to end", async ({ bench }) => {
    await bench("handle an empty Web response end to end", async () => {
      const response = nodeResponse();
      emptyHandler(request, response);
      await response.completed;
    }).run(BENCH_OPTIONS);
  });

  const bodyHandler = createNodeHandler(
    {
      fetch: () => Promise.resolve(new Response(JSON_BODY, { headers: JSON_HEADERS })),
    },
    { allowedHosts: ["127.0.0.1"] },
  );
  test("should handle a small Web response body end to end", async ({ bench }) => {
    await bench("handle a small Web response body end to end", async () => {
      const response = nodeResponse();
      bodyHandler(request, response);
      await response.completed;
    }).run(BENCH_OPTIONS);
  });
});

describe("Node HTTP server", () => {
  test("should serve an empty application response over HTTP", async ({ bench }) => {
    const served = await serve(
      { fetch: async () => new Response(null, { status: 204 }) },
      { signals: false },
    );
    try {
      await bench("serve an empty application response over HTTP", async () => {
        const response = await fetch(served.url);
        assert.equal(response.status, 204);
        await response.arrayBuffer();
      }).run(BENCH_OPTIONS);
    } finally {
      await served.close();
    }
  });

  test("should serve a dynamic route with an asset root over HTTP", async ({ bench }) => {
    const served = await serve(
      { fetch: async () => new Response(null, { status: 204 }) },
      { assets: { root: "tests" }, signals: false },
    );
    try {
      await bench("serve a dynamic route with an asset root over HTTP", async () => {
        const response = await fetch(`${served.url}/route`);
        assert.equal(response.status, 204);
        await response.arrayBuffer();
      }).run(BENCH_OPTIONS);
    } finally {
      await served.close();
    }
  });

  test("should serve a small static asset over HTTP", async ({ bench }) => {
    const served = await serve(
      { fetch: async () => new Response(null, { status: 500 }) },
      { assets: { root: "tests/fixtures" }, signals: false },
    );
    try {
      await bench("serve a small static asset over HTTP", async () => {
        const response = await fetch(`${served.url}/bench-asset.txt`);
        assert.equal(response.status, 200);
        assert.equal((await response.arrayBuffer()).byteLength, 1024);
      }).run(BENCH_OPTIONS);
    } finally {
      await served.close();
    }
  });

  test("should reject a missing static asset over HTTP", async ({ bench }) => {
    const served = await serve(
      { fetch: async () => new Response(null, { status: 500 }) },
      { assets: { root: "." }, signals: false },
    );
    try {
      await bench("reject a missing static asset over HTTP", async () => {
        const response = await fetch(`${served.url}/missing.js`);
        assert.equal(response.status, 404);
        await response.arrayBuffer();
      }).run(BENCH_OPTIONS);
    } finally {
      await served.close();
    }
  });

  test("should consume a small POST body over HTTP", async ({ bench }) => {
    const served = await serve(
      {
        fetch: async (request) => {
          await request.arrayBuffer();
          return new Response(null, { status: 204 });
        },
      },
      { signals: false },
    );
    try {
      await bench("consume a small POST body over HTTP", async () => {
        const response = await fetch(served.url, {
          body: JSON_BODY,
          method: "POST",
        });
        assert.equal(response.status, 204);
        await response.arrayBuffer();
      }).run(BENCH_OPTIONS);
    } finally {
      await served.close();
    }
  });
});
