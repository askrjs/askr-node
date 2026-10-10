# Changelog

## Unreleased

### Breaking changes

- Name the supported root exports explicitly. Remove `normalizeClientAddress`,
  `ConnectNext` and `NodeWebSocketOptions`; use the peer header or derive nested
  types from `NodeHandler` and `ListenOptions` as described in
  [the complete API inventory](docs/0.5.0-api.md).

### Fixed

- Dispose startup abort hooks and WebSocket ownership when native `listen` throws.
- Release failed response writers and bounded WebSocket rejections without waiting
  for application cancellation promises; cancel stalled or late upgrade bodies.
- Cancel late HTTP responses and bodies rejected by Node's header validation;
  clear partial application headers before writing the minimal error response.
- Allocate the bounded MCP line buffer before installing abort hooks, so a setup allocation error leaves no hooks behind.
- Prevent MCP dispatch after shutdown or cancellation while authentication waits.
- Contain asynchronous diagnostic and protocol-output stream failures, including writes pending when
  the MCP connection closes.
- Correct the documented default WebSocket origin policy and the README router example.

### Validation

- Add real-socket ownership regressions, MCP framing/recovery cases, V8 source
  coverage and strict installed-package checks with TypeScript 6 and 7.
- Ship migration and hardening evidence with the package. Align qualification
  types to Node 24 and update compatible development tooling advisories.
