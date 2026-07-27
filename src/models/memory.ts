/**
 * Memory DTOs — the wire shapes for `MemoryClient#add()` / `#search()`.
 *
 * Faithful mirror of `mu-sdk-python/src/mu_sdk/models/memory.py`. Authority:
 * `api-mcp-surface-spec.md` Appendix A.1 ("frozen — `shared/api.py`"). zod is the runtime
 * validator here exactly as pydantic is on the Python side — schemas below validate the LITERAL
 * wire JSON (snake_case field names), not a translated camelCase view; the SDK's public method
 * options objects (see `../client.ts`) use idiomatic camelCase and are mapped onto these wire
 * field names at the one request-construction boundary, the same way the Python client maps its
 * (already snake_case) kwargs onto `MemoryCreateRequest`'s fields.
 *
 * `namespace` is deliberately ABSENT from the create-request schema: tenancy is derived
 * server-side from the resolved auth identity (`X-Demo-*` headers / bearer claims), never
 * accepted as a client-supplied body field (api-mcp-surface-spec.md §2.2). `MemoryResponse`'s
 * `namespace` is the `to_prefix()` STRING form (Appendix A.1 literal citation) — a different
 * subsystem-spec era than the structured `Namespace` object used on `RecallResult`
 * (see `models/recall.ts`); both are honored as documented rather than silently unified.
 */

import { z } from "zod";

export const contentTypeSchema = z.enum(["text", "code", "url", "image", "transcript"]);
export type ContentType = z.infer<typeof contentTypeSchema>;

export const memoryTierSchema = z.enum(["stm", "mtm", "ltm"]);
export type MemoryTier = z.infer<typeof memoryTierSchema>;

export const polaritySchema = z.enum(["positive", "negative"]);
export type Polarity = z.infer<typeof polaritySchema>;

/** η's plane/partition axis (mirrors `mu_contracts.domain.model.memory.Visibility`). */
export const visibilitySchema = z.enum(["private", "shared"]);
export type Visibility = z.infer<typeof visibilitySchema>;

/**
 * `POST /memories` request body (api-mcp-surface-spec.md Appendix A.1, `api.py:103`).
 *
 * `subject`/`predicate`/`object` are carried here (not enumerated in the terse Appendix citation,
 * but required by the `MemoriesApi.upsert(...)` method signature in both
 * `api-sdk-mcp-surface-design.md` §5.6 and `api-mcp-surface-spec.md` §6 — a structured/triple
 * memory has to reach the server through *some* body field, and `MemoryResponse` already carries
 * `subject?/predicate?/object?` back out) — documented assumption, flagged rather than silently
 * guessed past (same assumption the Python SDK makes; see that module's docstring).
 */
export const memoryCreateRequestSchema = z
  .object({
    content: z.string().min(1),
    content_type: contentTypeSchema.default("text"),
    tier: memoryTierSchema.default("stm"),
    importance_score: z.number().min(0).max(1).default(0.5),
    visibility: visibilitySchema,
    local_memory_id: z.string().nullable().optional(),
    subject: z.string().nullable().optional(),
    predicate: z.string().nullable().optional(),
    object: z.string().nullable().optional(),
    metadata: z.record(z.string()).default({}),
  })
  .strict();

export type MemoryCreateRequest = z.infer<typeof memoryCreateRequestSchema>;

/** `MemoryResponse` (`api.py:38`) — the full frozen field list, Appendix A.1. */
export const memoryResponseSchema = z
  .object({
    id: z.string(),
    content: z.string(),
    content_type: contentTypeSchema,
    tier: memoryTierSchema,
    state: z.string(),
    importance_score: z.number().min(0).max(1),
    access_count: z.number().int().min(0),
    created_at: z.coerce.date(),
    updated_at: z.coerce.date(),
    // to_prefix() string form (Appendix A.1 literal citation — see module docstring above).
    namespace: z.string(),
    metadata: z.record(z.string()).default({}),
    source: z.string().nullable().optional(),
    speaker_kind: z.string().nullable().optional(),
    speaker_id: z.string().nullable().optional(),
    source_id: z.string().nullable().optional(),
    session_id: z.string().nullable().optional(),
    turn_id: z.string().nullable().optional(),
    entity_id: z.string().nullable().optional(),
    asserted_state: z.string().nullable().optional(),
    gds_pagerank: z.number().nullable().optional(),
    subject: z.string().nullable().optional(),
    predicate: z.string().nullable().optional(),
    object: z.string().nullable().optional(),
    object_kind: z.string().nullable().optional(),
    object_type: z.string().nullable().optional(),
    object_value: z.string().nullable().optional(),
    polarity: polaritySchema.nullable().optional(),
    predicate_cardinality: z.string().nullable().optional(),
    valid_at: z.coerce.date().nullable().optional(),
    invalid_at: z.coerce.date().nullable().optional(),
    expires_at: z.coerce.date().nullable().optional(),
    last_seen: z.coerce.date().nullable().optional(),
    mention_count: z.number().int().min(0).default(1),
    relevance_score: z.number().default(0),
    parent_ids: z.array(z.string()).default([]),
    child_ids: z.array(z.string()).default([]),
    content_hash: z.string().default(""),
  })
  .strict();

export type MemoryResponse = z.infer<typeof memoryResponseSchema>;

/** `MemoryListResponse` (`api.py:145`) — `GET /memories` response, the `.search()` shape. */
export const memoryListResponseSchema = z
  .object({
    memories: z.array(memoryResponseSchema),
    total: z.number().int().min(0),
    tier: memoryTierSchema.nullable().optional(),
  })
  .strict();

export type MemoryListResponse = z.infer<typeof memoryListResponseSchema>;
