# AGENTS.md

Operational guide for `@askrjs/node`, the Node HTTP transport adapter for
`@askrjs/server`.

## Askr North Star

Keep the transport flow narratable: a Node request becomes a Web `Request`, the
server app returns a Web `Response`, and the adapter writes or cancels it.
Enforce malformed configuration and impossible transport state at this boundary
with actionable errors. Test disconnect, abort, streaming, timeout, and cleanup
failure modes using real Node HTTP mechanisms. Do not fuse application routing
or middleware policy into the adapter. Prefer explicit server and timeout
configuration over environmental inference, and add adapter surface only for a
demonstrated transport need.

Run `npm run check` and the relevant HTTP benchmark before declaring a
performance-sensitive change ready.

## Optimization Gate

A benchmark number is only half of an optimization's success criterion. The
change must also preserve a causal path that a human or agent can narrate in one
sentence.

Every benchmark-driven change must include:

1. the one-sentence causal description of the optimized path;
2. the exact fallback trigger and proof that optimized and fallback paths have
   identical observable behavior and error surfaces;
3. an explicit legibility-cost statement, including `none` when no new path or
   concept is introduced; and
4. evidence that a measured bottleneck in a real application justifies the
   optimization now.

Prefer making the existing single path faster. New caches, inference,
memoization, shortcuts, fast paths, or scheduler states require an explicit
legibility decision; a speedup alone does not justify them.
