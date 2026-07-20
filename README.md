# @askrjs/node

Run an `@askrjs/server` application on Node.js. The adapter translates Node HTTP messages at the
boundary while the application continues to use Web `Request` and `Response` objects.

## Install

```sh
npm install @askrjs/server @askrjs/node
```

## Create a Node handler

```ts
import { createServer } from "node:http";
import { createServerApp, json } from "@askrjs/server";
import { createNodeHandler } from "@askrjs/node";

const app = createServerApp({
  routes: [{ path: "/health", handler: () => json({ status: "ok" }) }],
});

createServer(createNodeHandler(app)).listen(3000);
```

`createNodeHandler` also works as Connect middleware because it accepts an optional `next`
callback. It preserves streaming bodies, repeated `Set-Cookie` headers, aborts, backpressure,
status text, and HEAD responses.

## Listen directly

```ts
import { listen } from "@askrjs/node";

const server = await listen(app, { port: 3000 });
server.close();
```

Pass an `AbortSignal` to integrate shutdown with your process lifecycle.

## Serve a production application

```ts
import { serve } from "@askrjs/node";

const running = await serve(app, {
  port: 3000,
  assets: { root: "./dist/client" },
});

await running.close();
```

`serve` handles static assets and closes both the HTTP server and the application during shutdown.

## MCP over stdio

```ts
import { connectMcpStdio } from "@askrjs/node/mcp";

const connection = connectMcpStdio(mcp, { dependencies });
await connection.closed;
```

Protocol messages use stdin/stdout; diagnostics remain isolated on stderr. Authentication may be
provided directly or resolved from the process environment for each message.
