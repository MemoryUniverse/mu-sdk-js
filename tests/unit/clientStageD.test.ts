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
