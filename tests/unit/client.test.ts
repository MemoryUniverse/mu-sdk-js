/**
 * Pure-unit: `MemoryClient`'s request CONSTRUCTION for the net-new verbs (`consolidate`/`ask`,
 * `recall(tier=...)`) against a fake `Transport` (records the call, returns a canned response) —
 * never a mock of `fetch` itself (DEV-STANDARDS: mocks ONLY in pure unit tests; the real wire
 * round-trip is covered by `tests/integration/memoryClientConformance.test.ts` against the real
 * conformance server, zero mocks there). Mirrors
 * `mu-sdk-python/tests/unit/test_client.py` test-for-test.
 */
import { describe, expect, it } from "vitest";
import { MemoryClient } from "../../src/client.js";
import { resolveSdkSettings } from "../../src/settings.js";
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
}

/** A minimal `Transport` fake: returns one canned `TransportResponse` per call and records every
 * request it was asked to make, so a test can assert on exactly what `MemoryClient` sent over the
 * wire without a real socket. */
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
    });
    return this.response;
  }

  async close(): Promise<void> {
    return;
  }
}

function settings() {
  return resolveSdkSettings({
    baseUrl: "http://unit-test.invalid",
    identity: { userId: "alice", workspaceId: "ws-1", namespaceId: "ns-1", sessionId: "s-1" },
    maxRetries: 0,
  });
}

function transportWith(jsonBody: unknown): RecordingTransport {
  return new RecordingTransport(new TransportResponse(200, {}, jsonBody));
}

describe("MemoryClient — consolidate/ask/recall(tier) request construction", () => {
  it("consolidate() posts to the net-new route with the limit body", async () => {
    const now = new Date().toISOString();
    const transport = transportWith({
      facts_extracted: 2,
      added: 1,
      superseded: 1,
      generated_at: now,
    });
    const client = new MemoryClient({ settings: settings(), transport });
    try {
      const result = await client.consolidate({ limit: 25 });
      expect(result.superseded).toBe(1);
      expect(transport.calls[0]?.method).toBe("POST");
      expect(transport.calls[0]?.path).toBe("/v1/memories/consolidate");
      expect(transport.calls[0]?.jsonBody).toEqual({ limit: 25 });
    } finally {
      await client.close();
    }
  });

  it("consolidate() defaults limit to 50 when omitted", async () => {
    const now = new Date().toISOString();
    const transport = transportWith({
      facts_extracted: 0,
      added: 0,
      superseded: 0,
      generated_at: now,
    });
    const client = new MemoryClient({ settings: settings(), transport });
    try {
      await client.consolidate();
      expect(transport.calls[0]?.jsonBody).toEqual({ limit: 50 });
    } finally {
      await client.close();
    }
  });

  it("ask() posts to the net-new route and returns the synthesized answer", async () => {
    const now = new Date().toISOString();
    const transport = transportWith({
      question: "Where does Ada work?",
      answer: "Acme",
      generated_at: now,
    });
    const client = new MemoryClient({ settings: settings(), transport });
    try {
      const result = await client.ask("Where does Ada work?");
      expect(result.answer).toBe("Acme");
      expect(transport.calls[0]?.method).toBe("POST");
      expect(transport.calls[0]?.path).toBe("/v1/memories/ask");
      expect((transport.calls[0]?.jsonBody as { question: string }).question).toBe(
        "Where does Ada work?",
      );
    } finally {
      await client.close();
    }
  });

  it("recall(text, {tier}) sends it as a query param, not a body field", async () => {
    const now = new Date().toISOString();
    const transport = transportWith({
      namespace: {
        org: "org-1",
        workspace: "ws-1",
        user: "alice",
        session: "s-1",
        visibility: "shared",
      },
      items: [],
      channels_run: { stm: true, mtm: false, ltm: false },
      generated_at: now,
    });
    const client = new MemoryClient({ settings: settings(), transport });
    try {
      await client.recall("find me", { tier: "stm" });
      expect(transport.calls[0]?.params).toEqual({ tier: "stm" });
      expect(transport.calls[0]?.jsonBody).not.toHaveProperty("tier");
    } finally {
      await client.close();
    }
  });

  it("recall(text) without tier sends no query params — backward-compat", async () => {
    const now = new Date().toISOString();
    const transport = transportWith({
      namespace: {
        org: "org-1",
        workspace: "ws-1",
        user: "alice",
        session: "s-1",
        visibility: "shared",
      },
      items: [],
      channels_run: { stm: true, mtm: true, ltm: true },
      generated_at: now,
    });
    const client = new MemoryClient({ settings: settings(), transport });
    try {
      await client.recall("find me");
      expect(transport.calls[0]?.params).toBeUndefined();
    } finally {
      await client.close();
    }
  });
});
