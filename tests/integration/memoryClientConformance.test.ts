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
});
