/**
 * Integration suite: the SDK's real `MemoryClient` (real `fetch` via `FetchTransport`) against the
 * REAL Python conformance server (`conformanceServer.ts`, same process the Python SDK's own
 * integration suite drives) over real TCP. Asserts: correct serialized request payloads / response
 * parsing via zod, error-code -> typed-error mapping, and idempotent-replay/conflict behavior.
 * ZERO mocks (DEV-STANDARDS). Mirrors
 * `mu-sdk-python/tests/integration/test_memory_client_conformance.py` test-for-test — proving
 * cross-language wire compatibility against the identical server.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryClient } from "../../src/client.js";
import { AuthenticationError, ConflictError, PrivateDataRejectedError } from "../../src/errors.js";
import { type SdkSettings, resolveSdkSettings } from "../../src/settings.js";
import { type ConformanceServer, startConformanceServer } from "./conformanceServer.js";

let server: ConformanceServer;

beforeAll(async () => {
  server = await startConformanceServer();
}, 20_000);

afterAll(async () => {
  await server.stop();
});

function settingsFor(sessionId = "session-1"): SdkSettings {
  return resolveSdkSettings({
    baseUrl: server.baseUrl,
    identity: { userId: "alice", workspaceId: "ws-1", namespaceId: "ns-1", sessionId },
    maxRetries: 1,
    backoffBaseS: 0.01,
    backoffMaxS: 0.05,
    timeoutS: 5.0,
  });
}

describe("MemoryClient conformance (real Python server)", () => {
  it("add then search round-trips on the real wire", async () => {
    const client = new MemoryClient({ settings: settingsFor() });
    try {
      const added = await client.add("the sky is blue", { visibility: "shared" });
      expect(added.content).toBe("the sky is blue");
      expect(added.id).toBeTruthy();

      const found = await client.search("sky");
      expect(found.total).toBe(1);
      expect(found.memories[0]?.id).toBe(added.id);
      expect(found.memories[0]?.content).toBe("the sky is blue");
    } finally {
      await client.close();
    }
  });

  it("search excludes non-matching content", async () => {
    const client = new MemoryClient({ settings: settingsFor("session-2") });
    try {
      await client.add("apples are red");
      const result = await client.search("banana");
      expect(result.total).toBe(0);
      expect(result.memories).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("rejects a PRIVATE-visibility write on the shared route", async () => {
    const client = new MemoryClient({ settings: settingsFor("session-3") });
    try {
      let caught: unknown;
      try {
        await client.add("a private thought", { visibility: "private" });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(PrivateDataRejectedError);
      expect((caught as PrivateDataRejectedError).statusCode).toBe(403);
      expect((caught as PrivateDataRejectedError).requestId).toBeTruthy();
    } finally {
      await client.close();
    }
  });

  it("returns the original response on an idempotent replay", async () => {
    const client = new MemoryClient({ settings: settingsFor("session-4") });
    try {
      const first = await client.add("idempotent fact", { idempotencyKey: "key-1" });
      const second = await client.add("idempotent fact", { idempotencyKey: "key-1" });
      expect(second.id).toBe(first.id);
    } finally {
      await client.close();
    }
  });

  it("raises ConflictError on a conflicting idempotent replay", async () => {
    const client = new MemoryClient({ settings: settingsFor("session-5") });
    try {
      await client.add("fact A", { idempotencyKey: "key-2" });
      let caught: unknown;
      try {
        await client.add("fact B (different body, same key)", { idempotencyKey: "key-2" });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConflictError);
      expect((caught as ConflictError).statusCode).toBe(409);
    } finally {
      await client.close();
    }
  });

  it("recall returns ranked items with the resolved namespace", async () => {
    const client = new MemoryClient({ settings: settingsFor("session-6") });
    try {
      await client.add("paris is the capital of france");
      await client.add("tokyo is the capital of japan");

      const result = await client.recall("capital of france");

      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.content).toContain("paris");
      expect(result.namespace.workspace).toBe("ws-1");
      expect(result.namespace.session).toBe("session-6");
    } finally {
      await client.close();
    }
  });

  it("recall respects the limit", async () => {
    const client = new MemoryClient({ settings: settingsFor("session-7") });
    try {
      for (let i = 0; i < 5; i++) {
        await client.add(`note number ${i} about oranges`);
      }
      const result = await client.recall("oranges", { limit: 2 });
      expect(result.items).toHaveLength(2);
    } finally {
      await client.close();
    }
  });

  it("uses the settings-derived default recall limit when omitted", async () => {
    // omitting `limit` must resolve from `SdkSettings.defaultRecallLimit`, not a hardcoded
    // literal — proven end-to-end against the real server (which slices its results by the
    // `limit` it receives on the wire).
    const settings = resolveSdkSettings({
      baseUrl: server.baseUrl,
      identity: settingsFor("session-8").identity,
      defaultRecallLimit: 3,
    });
    const client = new MemoryClient({ settings });
    try {
      for (let i = 0; i < 5; i++) {
        await client.add(`note number ${i} about grapefruit`);
      }
      const result = await client.recall("grapefruit"); // no limit passed
      expect(result.items).toHaveLength(3);
    } finally {
      await client.close();
    }
  });

  it("context.discover round-trips", async () => {
    const client = new MemoryClient({ settings: settingsFor("session-10") });
    try {
      const view = await client.context.discover("session-10");
      expect(view.session_id).toBe("session-10");
      expect(view.indexes).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("isolates tenants by identity — even against the same server instance", async () => {
    const aliceClient = new MemoryClient({ settings: settingsFor("session-11") });
    try {
      await aliceClient.add("alice's secret note");
    } finally {
      await aliceClient.close();
    }

    const bobSettings = resolveSdkSettings({
      baseUrl: server.baseUrl,
      identity: {
        userId: "bob",
        workspaceId: "ws-1",
        namespaceId: "ns-1",
        sessionId: "session-12",
      },
    });
    const bobClient = new MemoryClient({ settings: bobSettings });
    try {
      const result = await bobClient.search("secret");
      expect(result.total).toBe(0);
    } finally {
      await bobClient.close();
    }
  });

  it("raises AuthenticationError from the real server on missing credentials", async () => {
    const noAuth = { headers: () => ({}) };
    const client = new MemoryClient({
      settings: resolveSdkSettings({ baseUrl: server.baseUrl }),
      auth: noAuth,
    });
    try {
      let caught: unknown;
      try {
        await client.search("anything");
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AuthenticationError);
      expect((caught as AuthenticationError).statusCode).toBe(401);
    } finally {
      await client.close();
    }
  });

  // ---- consolidate / ask / tier-scoped recall (net-new this phase) ---------------------------
  // Mirrors mu-sdk-python/tests/integration/test_memory_client_conformance.py test-for-test —
  // the SAME conformance server (real uvicorn, real TCP), proving cross-language wire parity.

  // NOTE on vocabulary: the conformance server's tenant state (`_memories`/`_facts`/
  // `_consolidated_ids`) is keyed by (workspace, namespace, user) — NOT session (see
  // `conformance_server/app.py::resolve_identity`'s `tenant_key`) — and this file runs every
  // `it()` against the SAME long-lived server instance (one `beforeAll`, not one-per-test as the
  // Python integration suite does). Every test below therefore uses subject/predicate/content
  // vocabulary that never repeats across tests in this file (same discipline the pre-existing
  // tests already follow: "oranges" vs "grapefruit" vs "paris"/"tokyo") so consolidate's
  // (subject, predicate) fact table and recall's content search never cross-pollute between
  // tests sharing this one server.

  it("consolidate extracts facts and reports real counts", async () => {
    const client = new MemoryClient({ settings: settingsFor("session-13") });
    try {
      await client.add("Elan uses FalkorDB", {
        subject: "Elan",
        predicate: "uses",
        object: "FalkorDB",
      });
      await client.add("Mira uses Postgres", {
        subject: "Mira",
        predicate: "uses",
        object: "Postgres",
      });

      const report = await client.consolidate();

      expect(report.facts_extracted).toBe(2);
      expect(report.added).toBe(2);
      expect(report.superseded).toBe(0);
    } finally {
      await client.close();
    }
  });

  it("consolidate supersedes a conflicting fact — invalidate-don't-delete (MemGC/Phi headline)", async () => {
    const client = new MemoryClient({ settings: settingsFor("session-14") });
    try {
      await client.add("Kavi hosts on FalkorDB", {
        subject: "Kavi",
        predicate: "hosts_on",
        object: "FalkorDB",
      });
      const first = await client.consolidate();
      expect(first.added).toBe(1);
      expect(first.superseded).toBe(0);

      await client.add("Kavi switched to Neo4j", {
        subject: "Kavi",
        predicate: "hosts_on",
        object: "Neo4j",
      });
      const second = await client.consolidate();
      expect(second.facts_extracted).toBe(1);
      expect(second.added).toBe(1);
      expect(second.superseded).toBe(1); // the FalkorDB fact must be reported as superseded
    } finally {
      await client.close();
    }
  });

  it("ask synthesizes an answer from the CURRENT consolidated fact only (contrast with recall)", async () => {
    const client = new MemoryClient({ settings: settingsFor("session-15") });
    try {
      await client.add("Talia prefers FalkorDB", {
        subject: "Talia",
        predicate: "prefers",
        object: "FalkorDB",
      });
      await client.consolidate();
      await client.add("Talia switched to Neo4j", {
        subject: "Talia",
        predicate: "prefers",
        object: "Neo4j",
      });
      await client.consolidate();

      const result = await client.ask("What does Talia prefer?");

      expect(result.answer).toContain("Neo4j");
      expect(result.answer).not.toContain("FalkorDB");
      expect(result.question).toBe("What does Talia prefer?");
    } finally {
      await client.close();
    }
  });

  it("recall(text, {tier}) narrows to exactly one channel end-to-end", async () => {
    const client = new MemoryClient({ settings: settingsFor("session-16") });
    try {
      await client.add("sprocket in stm", { tier: "stm" });
      await client.add("sprocket in ltm", { tier: "ltm" });

      const stmOnly = await client.recall("sprocket", { tier: "stm" });
      expect(stmOnly.items).toHaveLength(1);
      expect(stmOnly.items[0]?.tier).toBe("stm");
      expect(stmOnly.channels_run.stm).toBe(true);
      expect(stmOnly.channels_run.mtm).toBe(false);
      expect(stmOnly.channels_run.ltm).toBe(false);

      const ltmOnly = await client.recall("sprocket", { tier: "ltm" });
      expect(ltmOnly.items).toHaveLength(1);
      expect(ltmOnly.items[0]?.tier).toBe("ltm");
    } finally {
      await client.close();
    }
  });

  it("recall without a tier option is unchanged — backward-compat guard", async () => {
    const client = new MemoryClient({ settings: settingsFor("session-17") });
    try {
      await client.add("cogwheel in stm", { tier: "stm" });
      await client.add("cogwheel in ltm", { tier: "ltm" });

      const result = await client.recall("cogwheel");
      expect(result.items).toHaveLength(2);
    } finally {
      await client.close();
    }
  });
});
