# @askrjs/node

[![CI](https://github.com/askrjs/askr-node/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/askrjs/askr-node/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40askrjs%2Fnode.svg)](https://www.npmjs.com/package/@askrjs/node)

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

createServer(createNodeHandler(app, { baseUrl: "http://localhost:3000" })).listen(3000);
```

`createNodeHandler` also works as Connect middleware because it accepts an optional `next`
callback. It preserves streaming bodies, repeated `Set-Cookie` headers, aborts, backpressure,
status text, and HEAD responses. `next` receives adapter failures; application responses, including
`404`, remain owned by the `ServerApp` and do not fall through.

Every dispatched request includes `CLIENT_ADDRESS_HEADER` (`x-askr-client-address`) set from the
TCP socket peer. The adapter overwrites a client-supplied value and does not interpret
`X-Forwarded-For`, so applications can use this header for direct-listener IP controls without
trusting attacker-controlled forwarding metadata. Deployments behind a reverse proxy see the
proxy peer by default. Supporting original client addresses requires an explicit trusted-proxy
boundary; do not read `X-Forwarded-For` directly in application code.

Every handler must have a trusted URL boundary. Pass `baseUrl` when the external origin is fixed,
or `allowedHosts` when the request `Host` determines the origin. Host names are canonicalized and
compared case-insensitively; entries without a port allow that host on any port, while entries with
a port require that exact authority. Absolute-form request targets must retain the trusted origin,
and ambiguous network-path targets are rejected.

## Listen directly

```ts
import { listen } from "@askrjs/node";

const server = await listen(app, {
  port: 3000,
  requestTimeout: 120_000,
  headersTimeout: 60_000,
  keepAliveTimeout: 5_000,
});
server.close();
```

`listen()` and `serve()` apply timeout options during `http.Server` construction and configure
Node's incomplete-connection check interval no slower than the smallest finite request/header
timeout (capped at one second). This makes the authored values enforceable for stalled headers and
bodies instead of relying on Node's much slower default checking interval. Use explicit finite
`requestTimeout` and `headersTimeout` values in production; `0` retains Node's disable semantics.

Pass an `AbortSignal` to integrate shutdown with your process lifecycle.

Enable the built-in `ws` transport with `websocket: true`. It defaults to a
1 MiB maximum message payload with compression disabled; pass
`websocket: { closeTimeout, maxPayload, maxRejectionBodyBytes, perMessageDeflate }` to override
those settings. Rejected upgrade bodies are capped at 64 KiB by default. Shutdown gives clients five
seconds to complete the close handshake by default, then terminates any remaining connections.
Upgrades require an `Origin`. The request origin is allowed by default; set
`websocket.allowedOrigins` to a canonical allowlist when trusted browser origins differ from the
application origin.

```ts
router.ws("/echo", (socket) => {
  socket.onMessage((message) => socket.send(message));
});

const server = await listen(createServerApp({ router }), { websocket: true });
```

Route matching, authentication, and middleware complete before the handshake.
Rejected upgrades preserve the application response, and shutdown closes active
sockets.

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
When an asset root is configured, extension-bearing `GET` and `HEAD` paths are reserved for static
files: missing files return `404` without falling through to application routing, source maps are not
served, and resolved files must remain inside the configured root. Fingerprinted files under
`/assets/` receive immutable caching; other files receive `no-cache`.
Both `listen` and `serve` bind to `127.0.0.1` by default. A non-loopback
`host` also requires `allowPublicBind: true` so public exposure is explicit. Public listeners should
declare every external host name through `allowedHosts`; the bind host and `localhost` remain allowed
automatically:

```ts
await serve(app, {
  host: "0.0.0.0",
  allowPublicBind: true,
  allowedHosts: ["app.example.com"],
});
```

`listen` and `serve` fail before binding when their `AbortSignal` is already aborted. Later aborts
start shutdown. `serve().close()` is idempotent, waits for HTTP and WebSocket closure, and then closes
the application exactly once.

## MCP over stdio

```ts
import { connectMcpStdio } from "@askrjs/node/mcp";

const connection = connectMcpStdio(mcp, { dependencies });
await connection.closed;
```

Protocol messages use stdin/stdout; diagnostics remain isolated on stderr. Authentication may be
provided directly or resolved from the process environment for each message. Closing stdin, calling
`connection.close()`, or aborting its signal detaches the transport, cancels active requests,
terminates the MCP session, and prevents late protocol output.
