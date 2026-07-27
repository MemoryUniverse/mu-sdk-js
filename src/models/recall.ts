/**
 * Recall DTOs — the wire shapes for `MemoryClient#recall()`.
 *
 * Faithful mirror of `mu-sdk-python/src/mu_sdk/models/recall.py`. Authority:
 * `recall-service-design.md` §1.1 (l.78-125) — `RecallChannels`/`RecallMode`/`RecallQuery`/
 * `RecallItemView`/`RecallResult`. The WIRE request this SDK sends is `RecallRequest` below —
 * identical fields MINUS `namespace` (tenancy is header/token-derived, never client-body-declared
 * — same rule as `MemoryCreateRequest`, see `./memory.ts`). The response, `RecallResult`, DOES
 * carry the resolved `Namespace` back since that is the server confirming what it resolved, not
 * the client asserting it.
 *
 * Route: `POST /v1/memories/recall` (net-new route, `/v1`-prefixed per api-mcp-surface-spec.md
 * §2.1) with `RecallRequest` as the JSON body — a POST (not GET) because `channels`/`mode`/
 * `persona` are too rich for a querystring.
 */

import { z } from "zod";
import { visibilitySchema } from "./memory.js";

/** Which channels a recall runs (recall-service-design.md:78-82). A degraded recall drops one;
 * `RecallResult.channels_run` reports what actually ran. */
export const recallChannelsSchema = z
  .object({
    stm: z.boolean().default(true),
    mtm: z.boolean().default(true),
    ltm: z.boolean().default(true),
  })
  .strict();

export type RecallChannels = z.infer<typeof recallChannelsSchema>;

export const DEFAULT_RECALL_CHANNELS: RecallChannels = { stm: true, mtm: true, ltm: true };

/** recall-service-design.md:84-87. */
export const recallModeSchema = z.enum([
  "ranked", // default: full 3-channel ranked list
  "answer", // recall -> LLM synthesis (ask path)
  "inject", // recall -> rendered additionalContext bundle
]);
export type RecallMode = z.infer<typeof recallModeSchema>;

/**
 * The wire request body for `POST /v1/memories/recall`. Mirrors `RecallQuery`
 * (recall-service-design.md:89-98) minus `namespace` (see module docstring).
 */
export const recallRequestSchema = z
  .object({
    text: z.string().min(1),
    limit: z.number().int().min(1).max(100).default(10),
    channels: recallChannelsSchema.default(DEFAULT_RECALL_CHANNELS),
    mode: recallModeSchema.default("ranked"),
    persona: z.string().nullable().optional(),
    max_tokens: z.number().int().nullable().optional(),
    correlation_id: z.string().nullable().optional(),
  })
  .strict();

export type RecallRequest = z.infer<typeof recallRequestSchema>;

/**
 * η — the tenancy partition key on a resolved recall (mirrors
 * `mu_contracts.domain.model.memory.Namespace`, structured 5-field form; `agent`/`region` are
 * deliberately NOT fields — see that module's docstring). This SDK receives it read-only on
 * `RecallResult`; it never constructs or sends one.
 */
export const namespaceSchema = z
  .object({
    org: z.string(),
    workspace: z.string(),
    user: z.string(),
    session: z.string(),
    visibility: visibilitySchema,
  })
  .strict();

export type Namespace = z.infer<typeof namespaceSchema>;

/** The one closed union of degrade reasons across every subsystem (CANONICAL §2). Full 49-value
 * mirror of `DegradeReason(StrEnum)` in
 * `mu-core/packages/mu-contracts/src/mu_contracts/domain/events.py:168-237` — every member,
 * including the RESERVED/not-yet-emitted ones (`e2e_*`, `hosted_e2e_storage_only`,
 * `key_rotation_pending`), since they are still part of the closed wire type and a missing
 * member here would make `recallResultSchema.parse()` throw on a valid degraded recall instead
 * of returning a `RecallResult`. Keep in lockstep with the Python enum — do not hand-add values
 * here without adding them there first. */
export const degradeReasonSchema = z.enum([
  // --- memory-layer ---
  "ltm_unavailable",
  "date_extraction_fallback",
  "ltm_graph_latency_cap",
  // --- daemon (S1/S2) ---
  "daemon_unreachable_spooled", // SYNC-CLASS
  "server_unreachable", // SYNC-CLASS when component="device_sync"
  "recall_core_down",
  "stale_injection",
  "ltm_extraction_deferred",
  "unsupported_host_format",
  "capture_schema_drift",
  // --- platform / workflow ---
  "temporal_unavailable",
  // --- PIPELINES ---
  "note_link_skipped",
  "fact_dropped",
  "backpressure_shed",
  "durable_substrate_down",
  // --- governance ---
  "revoke_cascade_disabled",
  "revoke_ack_pending",
  // --- rooms ---
  "room_log_unavailable",
  "room_subscriber_lagged",
  "room_transport_degraded",
  "bound_agent_unavailable",
  "presence_store_down",
  // --- surface ---
  "surface_component_down",
  // --- cross-visibility recall (federate-live, §7.9) ---
  "shared_recall_unavailable",
  "artifact_hydration_budget",
  // --- topology / hosting — RESERVED, NOT EMITTED (E2E tier deferred, §7.18) ---
  "e2e_client_side_recall",
  "e2e_no_server_embed",
  "e2e_no_server_consolidation",
  "hosted_e2e_storage_only",
  // --- device registry / sync (§7.11, §7.14-§7.17) ---
  "sync_backfill_window_exceeded", // SYNC-CLASS
  "device_wipe_ack_pending", // SYNC-CLASS
  "key_rotation_pending", // RESERVED with §7.18
  "sync_stalled", // SYNC-CLASS
  "sync_delta_dead_lettered", // SYNC-CLASS
  "primary_sync_lag", // SYNC-CLASS
  // --- gateway ---
  "gateway_upstream_unavailable",
  "gateway_region_unavailable",
  // --- S1 install-time self-check (§7.13) ---
  "host_wiring_absent",
  // --- storage-pluggable backends (operator-consumer, MetricSink only) ---
  "kv_nondurable",
  "recency_zset_unavailable",
  "llm_unavailable_heuristic",
  "vector_single_node",
  "relational_index_reduced",
  // --- model-layer (§7.2 ModelSettings; operator) ---
  "model_group_unavailable",
  "model_local_unavailable_fell_back",
  // --- engine-core conflict (§7.20 async conflict; operator) ---
  "conflict_adjudication_degraded",
  "conflict_pending_suppressed",
  "conflict_manual_backlog",
  // --- trust-ledger (§7.25; operator) ---
  "trust_ledger_unavailable",
]);
export type DegradeReason = z.infer<typeof degradeReasonSchema>;

/** One ranked hit (recall-service-design.md:100-112). `content` is hydrated by id at render —
 * never carried on a bus event; on the SDK this is simply the field the server returned. */
export const recallItemViewSchema = z
  .object({
    memory_id: z.string(),
    content: z.string(),
    tier: z.enum(["stm", "mtm", "ltm"]),
    channel: z.string(), // "stm" | "mtm" | "ltm" — provenance of the hit
    fused_score: z.number(),
    rerank_score: z.number().nullable().optional(),
    is_floor: z.boolean().default(false),
    artifact_ref: z.string().nullable().optional(),
  })
  .strict();

export type RecallItemView = z.infer<typeof recallItemViewSchema>;

/** The ranked read result (recall-service-design.md:114-124). */
export const recallResultSchema = z
  .object({
    namespace: namespaceSchema,
    items: z.array(recallItemViewSchema),
    channels_run: recallChannelsSchema,
    degraded: degradeReasonSchema.nullable().optional(),
    generated_at: z.coerce.date(),
  })
  .strict();

export type RecallResult = z.infer<typeof recallResultSchema>;

/**
 * The content-free projection (recall-service-design.md:122-124) — a free function mirroring
 * Python's `RecallResult.memory_ids` property (TS zod-parsed objects are plain data, not class
 * instances with methods).
 */
export function recallMemoryIds(result: RecallResult): string[] {
  return result.items.map((item) => item.memory_id);
}
