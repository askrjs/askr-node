# @askrjs/node

The Node.js runtime adapter for transport-neutral `@askrjs/server` applications. It converts Node
HTTP requests and responses at the boundary while preserving the application's native Web
`Request`/`Response` contract.

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

`createNodeHandler` is Connect-shaped and accepts an optional `next` callback. Request bodies,
response streams, repeated `Set-Cookie` headers, aborts, backpressure, status text, and HEAD
semantics are carried across the Node/Web API boundary.

## Listen directly

```ts
import { listen } from "@askrjs/node";

const server = await listen(app, { port: 3000 });
await server.close();
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

`serve` combines the application with static assets and coordinates application and HTTP-server
shutdown exactly once.

## MCP over stdio

```ts
import { connectMcpStdio } from "@askrjs/node/mcp";

const connection = connectMcpStdio(mcp, { dependencies });
await connection.closed;
```

Protocol messages use stdin/stdout; diagnostics remain isolated on stderr. Authentication may be
provided directly or resolved from the process environment for each message.
