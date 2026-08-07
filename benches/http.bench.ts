import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { bench, describe, type BenchOptions } from "vitest";
import type { ServedApplication } from "../src/contracts.js";
import { createNodeHandler } from "../src/handler.js";
import { prepareNodeHandlerOptions, requestFromNode } from "../src/request.js";
import { writeNodeResponse } from "../src/response.js";
import { serve } from "../src/serve.js";

const JSON_BODY = '{"ok":true}';
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const preparedOptions = prepareNodeHandlerOptions({ allowedHosts: ["127.0.0.1"] });
const BENCH_OPTIONS = { time: 2_000, warmupTime: 500 } satisfies BenchOptions;

class BenchmarkRequest extends EventEmitter {
  readonly complete = true;
  readonly headers = { host: "127.0.0.1" };
  readonly method = "GET";
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

  bench(
    "should create the equivalent Web Request directly",
    () => {
      new Request("http://127.0.0.1/json", {
        headers: new Headers({ host: "127.0.0.1" }),
        method: "GET",
        signal: new AbortController().signal,
      });
    },
    BENCH_OPTIONS,
  );

  bench(
    "should convert an origin-form GET request",
    () => {
      requestFromNode(request, preparedOptions, new AbortController().signal);
    },
    BENCH_OPTIONS,
  );

  bench(
    "should write an empty Web response",
    async () => {
      await writeNodeResponse(new Response(null, { status: 204 }), nodeResponse(), "GET");
    },
    BENCH_OPTIONS,
  );

  bench(
    "should write a small Web response body",
    async () => {
      await writeNodeResponse(
        new Response(JSON_BODY, { headers: JSON_HEADERS }),
        nodeResponse(),
        "GET",
      );
    },
    BENCH_OPTIONS,
  );

  const emptyHandler = createNodeHandler(
    { fetch: () => Promise.resolve(new Response(null, { status: 204 })) },
    { allowedHosts: ["127.0.0.1"] },
  );
  bench(
    "should handle an empty Web response end to end",
    async () => {
      const response = nodeResponse();
      emptyHandler(request, response);
      await response.completed;
    },
    BENCH_OPTIONS,
  );

  const bodyHandler = createNodeHandler(
    {
      fetch: () => Promise.resolve(new Response(JSON_BODY, { headers: JSON_HEADERS })),
    },
    { allowedHosts: ["127.0.0.1"] },
  );
  bench(
    "should handle a small Web response body end to end",
    async () => {
      const response = nodeResponse();
      bodyHandler(request, response);
      await response.completed;
    },
    BENCH_OPTIONS,
  );
});

describe("Node HTTP server", () => {
  let served: ServedApplication;

  bench(
    "should serve an empty application response over HTTP",
    async () => {
      const response = await fetch(served.url);
      await response.arrayBuffer();
    },
    {
      ...BENCH_OPTIONS,
      setup: async () => {
        served = await serve(
          { fetch: async () => new Response(null, { status: 204 }) },
          { signals: false },
        );
      },
      teardown: async () => {
        await served.close();
      },
    },
  );

  bench(
    "should serve a dynamic route with an asset root over HTTP",
    async () => {
      const response = await fetch(`${served.url}/route`);
      await response.arrayBuffer();
    },
    {
      ...BENCH_OPTIONS,
      setup: async () => {
        served = await serve(
          { fetch: async () => new Response(null, { status: 204 }) },
          { assets: { root: "tests" }, signals: false },
        );
      },
      teardown: async () => {
        await served.close();
      },
    },
  );

  bench(
    "should serve a small static asset over HTTP",
    async () => {
      const response = await fetch(`${served.url}/package.json`);
      await response.arrayBuffer();
    },
    {
      ...BENCH_OPTIONS,
      setup: async () => {
        served = await serve(
          { fetch: async () => new Response(null, { status: 500 }) },
          { assets: { root: "." }, signals: false },
        );
      },
      teardown: async () => {
        await served.close();
      },
    },
  );

  bench(
    "should reject a missing static asset over HTTP",
    async () => {
      const response = await fetch(`${served.url}/missing.js`);
      await response.arrayBuffer();
    },
    {
      ...BENCH_OPTIONS,
      setup: async () => {
        served = await serve(
          { fetch: async () => new Response(null, { status: 500 }) },
          { assets: { root: "." }, signals: false },
        );
      },
      teardown: async () => {
        await served.close();
      },
    },
  );

  bench(
    "should consume a small POST body over HTTP",
    async () => {
      const response = await fetch(served.url, {
        body: JSON_BODY,
        method: "POST",
      });
      await response.arrayBuffer();
    },
    {
      ...BENCH_OPTIONS,
      setup: async () => {
        served = await serve(
          {
            fetch: async (request) => {
              await request.arrayBuffer();
              return new Response(null, { status: 204 });
            },
          },
          { signals: false },
        );
      },
      teardown: async () => {
        await served.close();
      },
    },
  );
});
