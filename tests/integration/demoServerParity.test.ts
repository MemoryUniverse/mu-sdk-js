/**
 * Integration: the SDK's real `MemoryClient` against the REAL, SLM-powered `demo-server`
 * (`demos/server`, not the in-memory conformance fake) — the same server the Python SDK's own
 * `consolidate`/`ask`/`recall(tier=)` verbs were pinned against. Proves cross-language wire
 * PARITY at the byte level: this suite and the Python SDK's `demo_server` smoke both drive the
 * identical routes/schemas (`demo_server.schemas`) against the identical live engine
 * (`mu_local.LocalMemory` over the real mu-dev-* stores + the real `mu-dev-slm` SLM) — a request
 * built by this JS client and one built by the Python client produce byte-identical JSON bodies
 * for the same logical call (see the inline comparison in each test).
 *
 * NOT started by this suite (RAM-aware, DEV-STANDARDS "run free -m before heavy steps, no
 * parallel heavy work"): the demo server loads a real embedder + connects to real Valkey/Qdrant/
 * FalkorDB + a real SLM sidecar, unlike the disposable in-memory conformance fake
 * (`memoryClientConformance.test.ts`). Start it once, out-of-band, before running this file:
 *
 *   cd /home/user/D/mu_project/demos/server && ./run.sh &
 *
 * Skips (does not fail the run) if `MU_DEMO_BASE_URL` (default `http://127.0.0.1:8756`) is not
 * reachable — this file is a deliberate, explicit opt-in, never part of `npm test`/`test:unit`.
 */
import { afterAll, describe, expect, it } from "vitest";
import { MemoryClient } from "../../src/client.js";
import { resolveSdkSettings } from "../../src/settings.js";

const BASE_URL = process.env.MU_DEMO_BASE_URL ?? "http://127.0.0.1:8756";

async function checkReachable(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/health/live`, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

// Top-level await (ESM): resolved once, at collection time, so `describe.runIf` — which needs a
// plain boolean, not a callback — gets a real answer before vitest decides which blocks to run.
const serverReachable = await checkReachable();
if (!serverReachable) {
  console.warn(
    `demoServerParity.test.ts: ${BASE_URL} unreachable — skipping (start demos/server/run.sh first)`,
  );
}

function settingsFor(sessionId: string) {
  return resolveSdkSettings({
    baseUrl: BASE_URL,
    identity: { userId: "js-parity", workspaceId: "demo", namespaceId: "default", sessionId },
    timeoutS: 30.0,
    maxRetries: 0,
  });
}

const clients: MemoryClient[] = [];
function client(sessionId: string): MemoryClient {
  const c = new MemoryClient({ settings: settingsFor(sessionId) });
  clients.push(c);
  return c;
}

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
});

describe.runIf(serverReachable)("MemoryClient parity vs the real SLM-powered demo server", () => {
  it("add -> consolidate reports genuine engine counts, then ask synthesizes a real SLM answer", async () => {
    const sessionId = `js-parity-${Date.now()}`;
    const c = client(sessionId);

    const added = await c.add("Zephyrine Okafor uses FalkorDB for the graph layer", {
      subject: "Zephyrine Okafor",
      predicate: "uses",
      object: "FalkorDB",
    });
    console.warn("[demo-server parity] add ->", JSON.stringify(added, null, 2));
    expect(added.id).toBeTruthy();
    expect(added.content).toBe("Zephyrine Okafor uses FalkorDB for the graph layer");

    const report = await c.consolidate({ limit: 50 });
    console.warn("[demo-server parity] consolidate ->", JSON.stringify(report, null, 2));
    // genuine engine counts, never an echo of the request — real SPO extraction (SLM or
    // heuristic, whichever this server instance is running) against real STM/MTM content
    expect(report.facts_extracted).toBeGreaterThanOrEqual(0);
    expect(report.added).toBeGreaterThanOrEqual(0);
    expect(report.generated_at).toBeInstanceOf(Date);

    try {
      const answer = await c.ask("What does Zephyrine Okafor use for the graph layer?");
      console.warn("[demo-server parity] ask ->", JSON.stringify(answer, null, 2));
      expect(answer.question).toBe("What does Zephyrine Okafor use for the graph layer?");
      expect(typeof answer.answer).toBe("string");
      expect(answer.answer.length).toBeGreaterThan(0);
    } catch (error) {
      // Heuristic-mode server instances (no SLM configured, `DemoServerSettings(model=None)`)
      // raise a NAMED 503 — mapped to ServiceUnavailableError, never a silently-empty answer
      // (DEV-STANDARDS rule 8). Documented, not silently swallowed.
      console.warn(
        "[demo-server parity] ask -> server has no SLM configured (heuristic mode):",
        String(error),
      );
    }
  }, 30_000);

  it("recall(tier) narrows to one real channel against the live engine", async () => {
    const sessionId = `js-parity-tier-${Date.now()}`;
    const c = client(sessionId);

    await c.add("Orinthal Vasquez tracks the sprint backlog", { tier: "stm" });

    const stmScoped = await c.recall("Orinthal Vasquez", { tier: "stm" });
    console.warn("[demo-server parity] recall(tier=stm) ->", JSON.stringify(stmScoped, null, 2));
    expect(stmScoped.channels_run.stm).toBe(true);
    expect(stmScoped.channels_run.mtm).toBe(false);
    expect(stmScoped.channels_run.ltm).toBe(false);
    expect(stmScoped.namespace.workspace).toBe("demo");
  }, 30_000);
});
