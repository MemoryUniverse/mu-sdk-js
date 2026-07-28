/**
 * Pure-unit: zod runtime validation for the SDK's wire DTOs. No I/O. Mirrors
 * `mu-sdk-python/tests/unit/test_models.py` test-for-test.
 */
import { describe, expect, it } from "vitest";
import {
  askRequestSchema,
  askResultSchema,
  consolidateRequestSchema,
  consolidateResultSchema,
} from "../../src/models/consolidate.js";
import { contextIndexListViewSchema } from "../../src/models/context.js";
import {
  memoryCreateRequestSchema,
  memoryListResponseSchema,
  memoryResponseSchema,
} from "../../src/models/memory.js";
import {
  degradeReasonSchema,
  namespaceSchema,
  recallChannelsSchema,
  recallItemViewSchema,
  recallMemoryIds,
  recallModeSchema,
  recallRequestSchema,
  recallResultSchema,
} from "../../src/models/recall.js";

describe("MemoryCreateRequest", () => {
  it("round trips and omits namespace", () => {
    const request = memoryCreateRequestSchema.parse({ content: "hello", visibility: "shared" });
    // tenancy is header/auth-derived, never client-body-declared
    expect("namespace" in request).toBe(false);
    expect(request.content).toBe("hello");
    expect(request.visibility).toBe("shared");
    expect(request.tier).toBe("stm"); // default
  });

  it("rejects unknown fields", () => {
    expect(() =>
      memoryCreateRequestSchema.parse({
        content: "x",
        visibility: "shared",
        unknown_field: "boom",
      }),
    ).toThrow();
  });

  it("rejects empty content", () => {
    expect(() => memoryCreateRequestSchema.parse({ content: "", visibility: "shared" })).toThrow();
  });
});

describe("MemoryResponse", () => {
  const now = new Date().toISOString();

  it("parses the full frozen shape", () => {
    const response = memoryResponseSchema.parse({
      id: "mem-1",
      content: "hello",
      content_type: "text",
      tier: "stm",
      state: "active",
      importance_score: 0.5,
      access_count: 0,
      created_at: now,
      updated_at: now,
      namespace: "mu/ws/ns/shared/*/session",
    });
    // string form, see module docstring
    expect(response.namespace).toBe("mu/ws/ns/shared/*/session");
    expect(response.metadata).toEqual({});
    expect(response.parent_ids).toEqual([]);
  });
});

describe("MemoryListResponse", () => {
  it("holds typed items", () => {
    const now = new Date().toISOString();
    const listing = memoryListResponseSchema.parse({
      memories: [
        {
          id: "mem-1",
          content: "hi",
          content_type: "text",
          tier: "stm",
          state: "active",
          importance_score: 0.5,
          access_count: 0,
          created_at: now,
          updated_at: now,
          namespace: "mu/ws/ns/shared/*/session",
        },
      ],
      total: 1,
    });
    expect(listing.memories).toHaveLength(1);
    expect(listing.memories[0]?.id).toBe("mem-1");
  });
});

describe("RecallRequest", () => {
  it("has documented defaults", () => {
    const request = recallRequestSchema.parse({ text: "find me" });
    expect(request.limit).toBe(10);
    expect(request.mode).toBe("ranked");
    expect(request.channels).toEqual(recallChannelsSchema.parse({}));
  });
});

describe("RecallResult", () => {
  it("projects memory_ids content-free", () => {
    const namespace = namespaceSchema.parse({
      org: "org-1",
      workspace: "ws-1",
      user: "u-1",
      session: "s-1",
      visibility: "shared",
    });
    const item = recallItemViewSchema.parse({
      memory_id: "mem-1",
      content: "hi",
      tier: "stm",
      channel: "stm",
      fused_score: 1.0,
    });
    const result = recallResultSchema.parse({
      namespace,
      items: [item],
      channels_run: recallChannelsSchema.parse({}),
      generated_at: new Date().toISOString(),
    });
    expect(recallMemoryIds(result)).toEqual(["mem-1"]);
  });

  it("parses a degraded recall carrying a reason outside the old truncated 16-member subset", () => {
    const namespace = namespaceSchema.parse({
      org: "org-1",
      workspace: "ws-1",
      user: "u-1",
      session: "s-1",
      visibility: "shared",
    });
    const result = recallResultSchema.parse({
      namespace,
      items: [],
      channels_run: recallChannelsSchema.parse({}),
      degraded: "shared_recall_unavailable",
      generated_at: new Date().toISOString(),
    });
    expect(result.degraded).toBe("shared_recall_unavailable");
  });
});

describe("RecallMode", () => {
  it("only accepts the three documented modes", () => {
    expect(recallModeSchema.parse("ranked")).toBe("ranked");
    expect(recallModeSchema.parse("answer")).toBe("answer");
    expect(recallModeSchema.parse("inject")).toBe("inject");
    expect(() => recallModeSchema.parse("bogus")).toThrow();
  });
});

describe("DegradeReason", () => {
  it("accepts a previously-missing cross-visibility reason (regression: truncated 16-member enum)", () => {
    // Was absent from the old 16-member subset; a real degraded recall carrying this reason
    // used to make recallResultSchema.parse() throw a raw ZodError instead of returning a
    // valid RecallResult.
    expect(degradeReasonSchema.parse("shared_recall_unavailable")).toBe(
      "shared_recall_unavailable",
    );
  });

  it("accepts a RESERVED-but-still-closed-union member", () => {
    expect(degradeReasonSchema.parse("e2e_client_side_recall")).toBe("e2e_client_side_recall");
  });

  it("rejects a reason string not in the canonical union", () => {
    expect(() => degradeReasonSchema.parse("not_a_real_reason")).toThrow();
  });

  it("carries all 49 canonical values (mu-contracts DegradeReason, events.py:168-237)", () => {
    expect(degradeReasonSchema.options).toHaveLength(49);
  });
});

describe("ContextIndexListView", () => {
  it("allows empty indexes", () => {
    const view = contextIndexListViewSchema.parse({
      session_id: "s-1",
      indexes: [],
      generated_at: new Date().toISOString(),
    });
    expect(view.indexes).toEqual([]);
  });
});

describe("ConsolidateRequest", () => {
  it("defaults limit to 50", () => {
    const request = consolidateRequestSchema.parse({});
    expect(request.limit).toBe(50);
  });

  it("rejects unknown fields", () => {
    expect(() => consolidateRequestSchema.parse({ limit: 10, unknown_field: "boom" })).toThrow();
  });

  it("rejects a limit outside [1, 500]", () => {
    expect(() => consolidateRequestSchema.parse({ limit: 0 })).toThrow();
    expect(() => consolidateRequestSchema.parse({ limit: 501 })).toThrow();
  });
});

describe("ConsolidateResult", () => {
  it("carries genuine engine counts", () => {
    // the MemGC/Phi headline: invalidate-don't-delete SUPERSESSION
    const result = consolidateResultSchema.parse({
      facts_extracted: 2,
      added: 1,
      superseded: 1,
      generated_at: new Date().toISOString(),
    });
    expect(result.superseded).toBe(1);
  });
});

describe("AskRequest", () => {
  it("rejects an empty question", () => {
    expect(() => askRequestSchema.parse({ question: "" })).toThrow();
  });

  it("defaults limit to 10", () => {
    const request = askRequestSchema.parse({ question: "Where does Ada work?" });
    expect(request.limit).toBe(10);
  });
});

describe("AskResult", () => {
  it("carries the synthesized answer", () => {
    const result = askResultSchema.parse({
      question: "Where does Ada work?",
      answer: "Acme",
      generated_at: new Date().toISOString(),
    });
    expect(result.answer).toBe("Acme");
  });
});
