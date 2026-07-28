/**
 * Consolidate + Ask DTOs — the wire shapes for `MemoryClient#consolidate()` / `#ask()`.
 *
 * Faithful mirror of `mu-sdk-python/src/mu_sdk/models/consolidate.py`. Authority: NET-NEW this
 * phase (task brief: "New wire routes (consolidate/ask) are net-new — the REST contract isn't
 * fully pinned yet, that's tracked"). `mu-contracts` ships no `rest_schema` for either verb yet
 * (same documented gap `models/memory.ts`/`models/recall.ts` cite), so this SDK declares its own
 * zod mirror of the wire contract the Python SDK already pinned against the demo server
 * (`demos/server/src/demo_server/schemas.py::ConsolidateRequestBody`/`ConsolidateResultOut`/
 * `AskRequestBody`/`AskResultOut`, read directly before writing this file — field-for-field
 * parity with `mu_sdk.models.consolidate`).
 *
 * Route: `POST /v1/memories/consolidate` (MTM->LTM DISTILL: invalidate-don't-delete SUPERSESSION +
 * bi-temporal SPO extraction) and `POST /v1/memories/ask` (MU's own SLM-powered synthesis over
 * recalled context — contrast with the raw ranked list `recall`/`search` return). Neither request
 * body carries tenancy (`namespace`/`user`/`session`) — resolved server-side from the auth
 * identity, same rule as every other verb in this package (see `models/memory.ts` module
 * docstring).
 *
 * `ask()` requires the server to have a configured LLM/SLM; a heuristic-mode server's
 * `POST /v1/memories/ask` returns a NAMED 503 (`mu_local.errors.LlmNotConfiguredError`
 * server-side), which `../errorMapping.ts`'s `mapWireError` already turns into a
 * `ServiceUnavailableError` — no new SDK error-mapping case needed.
 */

import { z } from "zod";

/** The wire request body for `POST /v1/memories/consolidate`. */
export const consolidateRequestSchema = z
  .object({
    limit: z.number().int().min(1).max(500).default(50),
  })
  .strict();

export type ConsolidateRequest = z.infer<typeof consolidateRequestSchema>;

/**
 * The DISTILL sweep receipt — genuine engine counts (`facts_extracted`/`added`/`superseded`),
 * never an echo of the request. `superseded` is the invalidate-don't-delete SUPERSESSION count
 * (the MemGC/Phi headline capability): prior conflicting facts marked `state=superseded` +
 * `invalid_at` stamped, never deleted.
 */
export const consolidateResultSchema = z
  .object({
    facts_extracted: z.number().int().min(0),
    added: z.number().int().min(0),
    superseded: z.number().int().min(0),
    generated_at: z.coerce.date(),
  })
  .strict();

export type ConsolidateResult = z.infer<typeof consolidateResultSchema>;

/** The wire request body for `POST /v1/memories/ask`. */
export const askRequestSchema = z
  .object({
    question: z.string().min(1),
    limit: z.number().int().min(1).max(100).default(10),
  })
  .strict();

export type AskRequest = z.infer<typeof askRequestSchema>;

/**
 * The SLM-synthesized answer (never the raw recall items — use `recall()`/`search()` for
 * retrieval without synthesis).
 */
export const askResultSchema = z
  .object({
    question: z.string(),
    answer: z.string(),
    generated_at: z.coerce.date(),
  })
  .strict();

export type AskResult = z.infer<typeof askResultSchema>;
