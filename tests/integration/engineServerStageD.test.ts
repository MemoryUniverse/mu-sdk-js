/**
 * Integration: `MemoryClient({ mode: "local_server" })` against a REAL running `mu-engine-server`
 * (`./engineServer.ts` spawns it — real Valkey/Qdrant/FalkorDB clients, dev stack already up).
 * DEV-STANDARDS "zero mocks": real `fetch`, real TCP, real ASGI server, real stores.
 *
 * Covers this task's own REAL-TEST GATE:
 * - `mode="local_server"` against a running `mu-engine-server` returns DTOs matching the canonical
 *   `MemoryResponse`/`ContextView` shapes (verified via the SDK's own zod schemas, which are the
 *   TS twins of `mu_contracts.contracts.memory.MemoryResponse`/`mu_contracts.contracts.views.
 *   ContextView`).
 * - `mode="embedded"` throws `UnsupportedModeError` at construction (no server needed — re-asserted
 *   here for completeness; the exhaustive coverage is the unit suite,
 *   `tests/unit/clientStageD.test.ts`).
 * - `promote`/`demote` raise the named 501 (client-side, no network call).
 * - The bearer token auto-load (design §1.2 FIX 4) is exercised end-to-end: this suite writes the
 *   REAL token the launcher minted to a temp path and lets `MemoryClient` auto-load it — the
 *   server accepts the request, proving the auto-loaded credential is byte-correct.
 *
 * Slow (spins up a real embedder + real store clients, `engineServer.ts`'s own
 * `START_TIMEOUT_MS = 60_000`) — run explicitly via `npm run test:integration`, not part of
 * `npm test`/`test:unit`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryClient } from "../../src/client.js";
import { SurfaceVerbNotImplementedError, UnsupportedModeError } from "../../src/errors.js";
import { type EngineServer, startEngineServer } from "./engineServer.js";

const SETUP_TIMEOUT_MS = 90_000;

let dir: string;
let server: EngineServer;
const clients: MemoryClient[] = [];

function client(): MemoryClient {
  const c = new MemoryClient({
    mode: "local_server",
    endpoint: server.baseUrl,
    tokenPath: server.tokenPath,
  });
  clients.push(c);
  return c;
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "mu-sdk-js-engine-server-it-"));
  server = await startEngineServer(path.join(dir, "engine-server.token"));
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("MemoryClient(mode=local_server) against a REAL mu-engine-server", () => {
  it("mode=embedded throws UnsupportedModeError at construction (no server round-trip)", () => {
    expect(() => new MemoryClient({ mode: "embedded" })).toThrow(UnsupportedModeError);
  });

  it("add (raw _execute, mu-engine-server's real AddRequest shape) -> get returns a canonical MemoryResponse", async () => {
    const c = client();
    const user = `js-it-${Date.now()}`;

    // `add()`'s own public verb body is still frozen to the conformance-server shape (module
    // docstring's flagged gap) — this suite seeds data through the REAL mu-engine-server
    // AddRequest shape directly via the exposed `_execute` choke-point (the same test seam
    // `tests/integration/test_retry_conformance.py` uses on the Python side), so `get()` (a
    // genuine Stage D verb, wired to the real route) has something real to fetch.
    const addResponse = await c._execute("POST", "/memories", {
      jsonBody: { content: "Zephyrine Okafor prefers FalkorDB", user },
    });
    const written = addResponse.jsonBody as { memory_id: string };
    expect(written.memory_id).toBeTruthy();

    const fetched = await c.get(written.memory_id, { user });
    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe(written.memory_id);
    expect(fetched?.content).toBe("Zephyrine Okafor prefers FalkorDB");
    // canonical MemoryResponse shape assertions (mu_contracts.contracts.memory.MemoryResponse)
    expect(typeof fetched?.tier).toBe("string");
    expect(fetched?.created_at).toBeInstanceOf(Date);
  }, 30_000);

  it("get() returns null for a memory that was never written (real 404 round-trip)", async () => {
    const c = client();
    const result = await c.get("does-not-exist", { user: `js-it-${Date.now()}` });
    expect(result).toBeNull();
  });

  it("buildContext (real POST /v1/context/window, field `query`) returns a canonical ContextView", async () => {
    const c = client();
    const user = `js-it-ctx-${Date.now()}`;
    await c._execute("POST", "/memories", {
      jsonBody: { content: "Orinthal Vasquez tracks the sprint backlog", user },
    });

    const view = await c.buildContext("Orinthal Vasquez", { user, limit: 5 });
    expect(typeof view.text).toBe("string");
    expect(Array.isArray(view.items)).toBe(true);
  }, 30_000);

  it("share() is REJECTED by plane-gating — mu-engine-server has no shared plane", async () => {
    const c = client();
    await expect(c.share("whatever", { visibility: "shared" })).rejects.toThrow(
      /requires the 'shared' plane/,
    );
  });

  it("promote()/demote() throw SurfaceVerbNotImplementedError(501), no network call", async () => {
    const c = client();
    await expect(c.promote("mem_x", { toTier: "mtm" })).rejects.toBeInstanceOf(
      SurfaceVerbNotImplementedError,
    );
    await expect(c.demote("mem_x", { toTier: "stm" })).rejects.toBeInstanceOf(
      SurfaceVerbNotImplementedError,
    );
  });

  it("the auto-loaded token from server.tokenPath genuinely authenticates (no auth= passed)", async () => {
    // `client()` above never passes `auth=` — every request in this file already proves the
    // auto-load path works (a wrong/missing token would 401 on every call). This test asserts it
    // explicitly against a fresh client for clarity.
    const c = new MemoryClient({
      mode: "local_server",
      endpoint: server.baseUrl,
      tokenPath: server.tokenPath,
    });
    clients.push(c);
    const result = await c.get("whatever-nonexistent", { user: "probe" });
    expect(result).toBeNull(); // 404, not 401 — proves auth succeeded
  });
});
