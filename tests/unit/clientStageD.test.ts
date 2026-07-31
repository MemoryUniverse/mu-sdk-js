/**
 * Pure-unit: Stage D construction (`SdkConfig`-based `MemoryClient` construction) and the net-new
 * `get`/`buildContext`/`share`/`promote`/`demote` verbs, against a fake `Transport` (records the
 * call, returns a canned response) — never a mock of `fetch` itself (DEV-STANDARDS: mocks ONLY in
 * pure unit tests). The real wire round-trip against a REAL running `mu-engine-server` is covered
 * by `tests/integration/engineServerStageD.test.ts`.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BearerAuth } from "../../src/auth.js";
import { MemoryClient } from "../../src/client.js";
import {
  PlaneFieldRejectedError,
  SdkConfigError,
  SurfaceVerbNotImplementedError,
  UnsupportedModeError,
} from "../../src/errors.js";
import type {
  Transport,
  TransportRequestOptions,
  TransportResponse as TransportResponseType,
} from "../../src/transport.js";
import { TransportResponse } from "../../src/transport.js";

interface RecordedCall {
  method: string;
  path: string;
  params: TransportRequestOptions["params"];
  jsonBody: unknown;
  headers: Record<string, string> | undefined;
}

class RecordingTransport implements Transport {
  readonly calls: RecordedCall[] = [];

  constructor(private readonly response: TransportResponseType) {}

  async request(
    method: string,
    path: string,
    options: TransportRequestOptions = {},
  ): Promise<TransportResponseType> {
    this.calls.push({
      method,
      path,
      params: options.params,
      jsonBody: options.jsonBody,
      headers: options.headers,
    });
    return this.response;
  }

  async close(): Promise<void> {
    return;
  }
}

function transportWith(status: number, jsonBody: unknown): RecordingTransport {
  return new RecordingTransport(new TransportResponse(status, {}, jsonBody));
}

const FAKE_AUTH = new BearerAuth("fake-bearer-token");

const MEMORY_RESPONSE_BODY = {
  id: "mem_1",
  content: "hello",
  content_type: "text",
  tier: "stm",
  state: "active",
  importance_score: 0.5,
  access_count: 0,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  namespace: "org/ws/user/session",
  metadata: {},
  mention_count: 1,
  relevance_score: 0,
  parent_ids: [],
  child_ids: [],
  content_hash: "",
};

describe("MemoryClient — mode=embedded construction", () => {
  it("throws UnsupportedModeError synchronously, before building anything", () => {
    expect(() => new MemoryClient({ mode: "embedded" })).toThrow(UnsupportedModeError);
  });
});

describe("MemoryClient — Stage D config construction", () => {
  it("mode=local_server with no endpoint throws SdkConfigError", () => {
    expect(() => new MemoryClient({ mode: "local_server", auth: FAKE_AUTH })).toThrow(
      SdkConfigError,
    );
  });

  it("mode=remote with no endpoint throws SdkConfigError", () => {
    expect(() => new MemoryClient({ mode: "remote", auth: FAKE_AUTH })).toThrow(SdkConfigError);
  });

  it("explicit auth= wins over token auto-load for mode=local_server", async () => {
    const transport = transportWith(200, MEMORY_RESPONSE_BODY);
    const client = new MemoryClient({
      mode: "local_server",
      endpoint: "http://unit-test.invalid",
      auth: FAKE_AUTH,
      transport,
    });
    try {
      await client.get("mem_1");
      expect(transport.calls[0]?.headers?.Authorization).toBe("Bearer fake-bearer-token");
    } finally {
      await client.close();
    }
  });
});

describe("MemoryClient — mode=local_server token auto-load (design §1.2 FIX 4)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "mu-sdk-js-clientstaged-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("auto-loads the bearer token from disk when no auth= is given", async () => {
    const tokenPath = path.join(dir, "engine-server.token");
    writeFileSync(tokenPath, "minted-token-abc123", { mode: 0o600 });
    const transport = transportWith(200, MEMORY_RESPONSE_BODY);

    const client = new MemoryClient({
      mode: "local_server",
      endpoint: "http://unit-test.invalid",
      tokenPath,
      transport,
    });
    try {
      await client.get("mem_1");
      expect(transport.calls[0]?.headers?.Authorization).toBe("Bearer minted-token-abc123");
    } finally {
      await client.close();
    }
  });

  it("throws EngineServerTokenNotFoundError at construction when the token file is absent", () => {
    const missing = path.join(dir, "never-written");
    expect(
      () =>
        new MemoryClient({
          mode: "local_server",
          endpoint: "http://unit-test.invalid",
          tokenPath: missing,
        }),
    ).toThrow(/engine-server token file/);
  });
});

describe("MemoryClient#get", () => {
  it("mode=local_server sends the REAL mu-engine-server shape: GET /memories/{id}?user=&session=", async () => {
    const transport = transportWith(200, MEMORY_RESPONSE_BODY);
    const client = new MemoryClient({
      mode: "local_server",
      endpoint: "http://unit-test.invalid",
      auth: FAKE_AUTH,
      transport,
    });
    try {
      const result = await client.get("mem_1", { user: "ada", session: "s1" });
      expect(result?.id).toBe("mem_1");
      expect(transport.calls[0]?.method).toBe("GET");
      expect(transport.calls[0]?.path).toBe("/memories/mem_1");
      expect(transport.calls[0]?.params).toEqual({ user: "ada", session: "s1" });
    } finally {
      await client.close();
    }
  });

  it("legacy construction sends the conformance-server shape: GET /v1/memories/{id}, no params", async () => {
    const transport = transportWith(200, MEMORY_RESPONSE_BODY);
    const client = new MemoryClient({ transport, auth: FAKE_AUTH });
    try {
      const result = await client.get("mem_1");
      expect(result?.id).toBe("mem_1");
      expect(transport.calls[0]?.method).toBe("GET");
      expect(transport.calls[0]?.path).toBe("/v1/memories/mem_1");
      expect(transport.calls[0]?.params).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  it("legacy construction rejects user=/session= — no private plane configured", async () => {
    const transport = transportWith(200, MEMORY_RESPONSE_BODY);
    const client = new MemoryClient({ transport, auth: FAKE_AUTH });
    try {
      await expect(client.get("mem_1", { user: "ada" })).rejects.toBeInstanceOf(
        PlaneFieldRejectedError,
      );
      expect(transport.calls).toHaveLength(0); // rejected BEFORE any network call
    } finally {
      await client.close();
    }
  });

  it("returns null on a 404, never throws NotFoundError", async () => {
    const transport = transportWith(404, { detail: "not found", request_id: "req-1" });
    const client = new MemoryClient({
      mode: "local_server",
      endpoint: "http://unit-test.invalid",
      auth: FAKE_AUTH,
      transport,
    });
    try {
      const result = await client.get("missing");
      expect(result).toBeNull();
    } finally {
      await client.close();
    }
  });
});

describe("MemoryClient#buildContext", () => {
  const CONTEXT_VIEW_BODY = { text: "assembled", items: [], degraded: null };

  it("mode=local_server sends the REAL mu-engine-server body field `query`, not `text`", async () => {
    const transport = transportWith(200, CONTEXT_VIEW_BODY);
    const client = new MemoryClient({
      mode: "local_server",
      endpoint: "http://unit-test.invalid",
      auth: FAKE_AUTH,
      transport,
    });
    try {
      await client.buildContext("find me", { user: "ada", session: "s1", limit: 5, maxChars: 200 });
      expect(transport.calls[0]?.method).toBe("POST");
      expect(transport.calls[0]?.path).toBe("/v1/context/window");
      expect(transport.calls[0]?.jsonBody).toEqual({
        query: "find me",
        limit: 5,
        user: "ada",
        session: "s1",
        max_chars: 200,
      });
    } finally {
      await client.close();
    }
  });

  it("legacy construction sends the conformance-server body field `text`", async () => {
    const transport = transportWith(200, CONTEXT_VIEW_BODY);
    const client = new MemoryClient({ transport, auth: FAKE_AUTH });
    try {
      await client.buildContext("find me", { limit: 5 });
      expect(transport.calls[0]?.jsonBody).toEqual({ text: "find me", limit: 5 });
    } finally {
      await client.close();
    }
  });
});

describe("MemoryClient#add — R3 reconciliation", () => {
  const WRITE_RESULT_BODY = {
    memory_id: "mem_1",
    content_hash: "abc123",
    promoted: false,
    tiers_written: ["stm"],
    namespace: "org/ws/user/session",
    events_emitted: [],
  };

  it("mode=local_server sends the REAL mu-engine-server AddRequest shape: {content, user, session} only", async () => {
    const transport = transportWith(201, WRITE_RESULT_BODY);
    const client = new MemoryClient({
      mode: "local_server",
      endpoint: "http://unit-test.invalid",
      auth: FAKE_AUTH,
      transport,
    });
    try {
      const result = await client.add("hello", { user: "ada", session: "s1" });
      expect(transport.calls[0]?.method).toBe("POST");
      expect(transport.calls[0]?.path).toBe("/memories");
      expect(transport.calls[0]?.jsonBody).toEqual({
        content: "hello",
        user: "ada",
        session: "s1",
      });
      expect(result).toEqual(WRITE_RESULT_BODY);
    } finally {
      await client.close();
    }
  });

  it("mode=local_server never sends tier/importance_score/visibility/subject/predicate/object/metadata (would 422 extra_forbidden on the real server)", async () => {
    const transport = transportWith(201, WRITE_RESULT_BODY);
    const client = new MemoryClient({
      mode: "local_server",
      endpoint: "http://unit-test.invalid",
      auth: FAKE_AUTH,
      transport,
    });
    try {
      await client.add("hello", {
        tier: "mtm",
        importanceScore: 0.9,
        idempotencyKey: "key-1",
        localMemoryId: "lm-1",
        metadata: { k: "v" },
      });
      expect(transport.calls[0]?.jsonBody).toEqual({ content: "hello" });
    } finally {
      await client.close();
    }
  });

  it("mode=local_server rejects visibility=/subject=/predicate=/object= — no shared plane configured", async () => {
    const transport = transportWith(201, WRITE_RESULT_BODY);
    const client = new MemoryClient({
      mode: "local_server",
      endpoint: "http://unit-test.invalid",
      auth: FAKE_AUTH,
      transport,
    });
    try {
      await expect(client.add("hello", { visibility: "shared" })).rejects.toBeInstanceOf(
        PlaneFieldRejectedError,
      );
      expect(transport.calls).toHaveLength(0);
    } finally {
      await client.close();
    }
  });

  it("legacy construction rejects user=/session= — no private plane configured", async () => {
    const transport = transportWith(201, MEMORY_RESPONSE_BODY);
    const client = new MemoryClient({ transport, auth: FAKE_AUTH });
    try {
      await expect(client.add("hello", { user: "ada" })).rejects.toBeInstanceOf(
        PlaneFieldRejectedError,
      );
      expect(transport.calls).toHaveLength(0);
    } finally {
      await client.close();
    }
  });

  it("legacy construction is unchanged: still sends MemoryCreateRequest, parses full MemoryResponse", async () => {
    const transport = transportWith(201, MEMORY_RESPONSE_BODY);
    const client = new MemoryClient({ transport, auth: FAKE_AUTH });
    try {
      const result = await client.add("hello", { visibility: "shared" });
      expect(transport.calls[0]?.path).toBe("/memories");
      expect(transport.calls[0]?.jsonBody).toMatchObject({
        content: "hello",
        visibility: "shared",
      });
      expect((result as { id: string }).id).toBe("mem_1");
    } finally {
      await client.close();
    }
  });
});

describe("MemoryClient#recall — R3 reconciliation", () => {
  const RECALL_RESULT_BODY = {
    namespace: {
      org: "local",
      workspace: "local",
      user: "ada",
      session: "s1",
      visibility: "shared",
    },
    items: [],
    channels_run: { stm: true, mtm: true, ltm: true },
    degraded: null,
    generated_at: new Date().toISOString(),
  };

  it("mode=local_server sends {text, user, session, tier, limit} as BODY fields, no query params", async () => {
    const transport = transportWith(200, RECALL_RESULT_BODY);
    const client = new MemoryClient({
      mode: "local_server",
      endpoint: "http://unit-test.invalid",
      auth: FAKE_AUTH,
      transport,
    });
    try {
      await client.recall("find me", { user: "ada", session: "s1", tier: "mtm", limit: 7 });
      expect(transport.calls[0]?.method).toBe("POST");
      expect(transport.calls[0]?.path).toBe("/v1/memories/recall");
      expect(transport.calls[0]?.params).toBeUndefined();
      expect(transport.calls[0]?.jsonBody).toEqual({
        text: "find me",
        limit: 7,
        tier: "mtm",
        user: "ada",
        session: "s1",
      });
    } finally {
      await client.close();
    }
  });

  it("mode=local_server never sends channels/mode/persona/max_tokens/correlation_id (real RecallRequest has no such fields)", async () => {
    const transport = transportWith(200, RECALL_RESULT_BODY);
    const client = new MemoryClient({
      mode: "local_server",
      endpoint: "http://unit-test.invalid",
      auth: FAKE_AUTH,
      transport,
    });
    try {
      await client.recall("find me", { persona: "p1", maxTokens: 100, correlationId: "c1" });
      expect(transport.calls[0]?.jsonBody).toEqual({ text: "find me", limit: 10 });
    } finally {
      await client.close();
    }
  });

  it("legacy construction rejects user=/session= — no private plane configured", async () => {
    const transport = transportWith(200, RECALL_RESULT_BODY);
    const client = new MemoryClient({ transport, auth: FAKE_AUTH });
    try {
      await expect(client.recall("find me", { user: "ada" })).rejects.toBeInstanceOf(
        PlaneFieldRejectedError,
      );
      expect(transport.calls).toHaveLength(0);
    } finally {
      await client.close();
    }
  });

  it("legacy construction is unchanged: tier still sent as a query param, not a body field", async () => {
    const transport = transportWith(200, RECALL_RESULT_BODY);
    const client = new MemoryClient({ transport, auth: FAKE_AUTH });
    try {
      await client.recall("find me", { tier: "stm" });
      expect(transport.calls[0]?.params).toEqual({ tier: "stm" });
      expect(transport.calls[0]?.jsonBody).not.toHaveProperty("tier");
    } finally {
      await client.close();
    }
  });
});

describe("MemoryClient#consolidate — R3 reconciliation", () => {
  it("mode=local_server parses the real ConsolidateView response (noop, no generated_at)", async () => {
    const transport = transportWith(200, { facts_extracted: 3, added: 2, superseded: 1, noop: 1 });
    const client = new MemoryClient({
      mode: "local_server",
      endpoint: "http://unit-test.invalid",
      auth: FAKE_AUTH,
      transport,
    });
    try {
      const result = await client.consolidate({ limit: 10, user: "ada", session: "s1" });
      expect(transport.calls[0]?.method).toBe("POST");
      expect(transport.calls[0]?.path).toBe("/v1/memories/consolidate");
      expect(transport.calls[0]?.jsonBody).toEqual({ limit: 10, user: "ada", session: "s1" });
      expect(result).toEqual({ facts_extracted: 3, added: 2, superseded: 1, noop: 1 });
    } finally {
      await client.close();
    }
  });

  it("legacy construction rejects user=/session= — no private plane configured", async () => {
    const transport = transportWith(200, {
      facts_extracted: 0,
      added: 0,
      superseded: 0,
      generated_at: new Date().toISOString(),
    });
    const client = new MemoryClient({ transport, auth: FAKE_AUTH });
    try {
      await expect(client.consolidate({ user: "ada" })).rejects.toBeInstanceOf(
        PlaneFieldRejectedError,
      );
      expect(transport.calls).toHaveLength(0);
    } finally {
      await client.close();
    }
  });

  it("legacy construction is unchanged: still parses ConsolidateResult (generated_at, no noop)", async () => {
    const now = new Date().toISOString();
    const transport = transportWith(200, {
      facts_extracted: 1,
      added: 1,
      superseded: 0,
      generated_at: now,
    });
    const client = new MemoryClient({ transport, auth: FAKE_AUTH });
    try {
      const result = await client.consolidate({ limit: 5 });
      expect(transport.calls[0]?.jsonBody).toEqual({ limit: 5 });
      expect((result as { generated_at: Date }).generated_at).toBeInstanceOf(Date);
    } finally {
      await client.close();
    }
  });
});

describe("MemoryClient#share — plane-gating", () => {
  it("mode=local_server with no shared= rejects visibility= — no shared plane configured", async () => {
    const transport = transportWith(200, MEMORY_RESPONSE_BODY);
    const client = new MemoryClient({
      mode: "local_server",
      endpoint: "http://unit-test.invalid",
      auth: FAKE_AUTH,
      transport,
    });
    try {
      await expect(client.share("mem_1", { visibility: "shared" })).rejects.toBeInstanceOf(
        PlaneFieldRejectedError,
      );
      expect(transport.calls).toHaveLength(0);
    } finally {
      await client.close();
    }
  });

  it("legacy construction (unconditionally shared-plane) sends the request", async () => {
    const transport = transportWith(200, MEMORY_RESPONSE_BODY);
    const client = new MemoryClient({ transport, auth: FAKE_AUTH });
    try {
      const result = await client.share("mem_1", { visibility: "shared" });
      expect(result.id).toBe("mem_1");
      expect(transport.calls[0]?.method).toBe("POST");
      expect(transport.calls[0]?.path).toBe("/v1/memories/mem_1/share");
      expect(transport.calls[0]?.jsonBody).toEqual({ visibility: "shared" });
    } finally {
      await client.close();
    }
  });

  it("mode=remote (shared plane IS the primary plane) sends the request via the primary transport", async () => {
    const transport = transportWith(200, MEMORY_RESPONSE_BODY);
    const client = new MemoryClient({
      mode: "remote",
      endpoint: "http://unit-test.invalid",
      auth: FAKE_AUTH,
      transport,
    });
    try {
      const result = await client.share("mem_1", { visibility: "shared" });
      expect(result.id).toBe("mem_1");
      expect(transport.calls[0]?.path).toBe("/v1/memories/mem_1/share");
    } finally {
      await client.close();
    }
  });
});

describe("MemoryClient#promote / #demote — honest 501, no network call", () => {
  it("promote() throws SurfaceVerbNotImplementedError(501) without touching the transport", async () => {
    const transport = transportWith(200, {});
    const client = new MemoryClient({ transport, auth: FAKE_AUTH });
    try {
      await expect(client.promote("mem_1", { toTier: "mtm" })).rejects.toMatchObject({
        constructor: SurfaceVerbNotImplementedError,
        statusCode: 501,
      });
      expect(transport.calls).toHaveLength(0);
    } finally {
      await client.close();
    }
  });

  it("demote() throws SurfaceVerbNotImplementedError(501) without touching the transport", async () => {
    const transport = transportWith(200, {});
    const client = new MemoryClient({ transport, auth: FAKE_AUTH });
    try {
      await expect(client.demote("mem_1", { toTier: "stm" })).rejects.toMatchObject({
        constructor: SurfaceVerbNotImplementedError,
        statusCode: 501,
      });
      expect(transport.calls).toHaveLength(0);
    } finally {
      await client.close();
    }
  });
});
