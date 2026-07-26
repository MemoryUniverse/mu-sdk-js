# mu-sdk-js

**Open (Apache-2.0).** The Product-B **developer SDK for JavaScript/TypeScript** — for web, Node,
and browser developers using Memory Universe. See `../CLAUDE.md` for project-wide rules.

## What it is — a wire client, nothing else

- **No engine, no stores, no strategies.** It only speaks the versioned wire contract.
- **Types are generated from the language-neutral wire schema** (OpenAPI / JSON-Schema published from
  `mu-core`) — the TS type layer is the JS counterpart of `mu-contracts`, kept in lock-step by
  codegen + the conformance suite. This is exactly why the SDK is its own repo: a TS toolchain cannot
  live in the Python `mu-core`.
- Toolchain: `tsc` / a JS bundler, published to **npm** (ESM + types).

## Where it connects (the request surface)

Same public surface as the Python SDK — **`mu-server` through the gateway edge**, never the engine:
- **REST** (Streamable-HTTP) — memories, sessions, context/recall, rooms, devices, sync, persona,
  conflict inbox, subscriptions.
- **MCP** — the operations as agent tools.
- **Centrifugo (SSE / streaming)** — live push (`SyncStatusView`, room events, conflict/other
  notifications), with browser-safe transport (EventSource/WebSocket-compat as Centrifugo provides).
- Auth via bearer / device token; namespace-scoped; Product B metered per-MAU.

## Features it exposes

Parity with `mu-sdk-python` — memory ops, live session + context, rooms (incl. local agent-to-agent),
device enroll + sync-status, persona, agent+subagent identity, conflict inbox, trust surfaces +
notifications, governed subscriptions — as idiomatic TS (promises/streams, typed DTOs).

> Must stay feature-parity with `mu-sdk-python` and faithful to
> `../docs/superpowers/design/api-sdk-mcp-surface-design.md`.
