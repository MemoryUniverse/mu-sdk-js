/**
 * Context (governed-transfer) DTOs — the wire shape for `MemoryClient.context.discover()`.
 *
 * Faithful mirror of `mu-sdk-python/src/mu_sdk/models/context.py`. Authority:
 * `ContextApi.discover(session_id) -> ContextIndexListView` (api-sdk-mcp-surface-design.md §5.6,
 * l.447) and the `ContextIndex` shape (governance-transfer-core-spec.md §5, l.283-294). Route:
 * `POST /v1/context/discover` (api-mcp-surface-spec.md §4.5, l.180).
 *
 * **Scope note (tracked gap, not a silent stub — DEV-STANDARDS "no silent stubs that look
 * finished"):** the full governed-transfer FSM (`index`/`propose`/`inbox`/`decide`/`accept`/
 * `revoke`) is explicitly out of THIS phase's brief, exactly as in the Python SDK. Only the
 * read-only `discover` verb is implemented here.
 *
 * `symbolic_facts`/`allowed_memory_ids` are Python `tuple[str, ...]` on the wire model; TS has no
 * fixed-arity tuple-of-unknown-length type, so these are typed `readonly string[]` here — the
 * natural TS equivalent, not a silent behavior change (both serialize to a JSON array on the
 * wire).
 */

import { z } from "zod";

/**
 * The read-only projection of a `ContextIndex` (governance-transfer-core-spec.md:283-294) a peer
 * session can discover. `object_ref` (a `ShareableRef`) and `policy` are deliberately omitted —
 * they belong to the write-side FSM this phase does not build (see module docstring).
 */
export const contextIndexViewSchema = z
  .object({
    index_id: z.string().min(1),
    transfer_class: z.string(), // TransferClass enum value, carried as string (see docstring)
    summary_ref: z.string().nullable().optional(),
    symbolic_facts: z.array(z.string()).default([]),
    allowed_memory_ids: z.array(z.string()).default([]),
    created_at: z.coerce.date(),
  })
  .strict();

export type ContextIndexView = z.infer<typeof contextIndexViewSchema>;

/** `ContextApi.discover(sessionId) -> ContextIndexListView` (api-sdk-mcp-surface-design.md:447). */
export const contextIndexListViewSchema = z
  .object({
    session_id: z.string().min(1),
    indexes: z.array(contextIndexViewSchema),
    generated_at: z.coerce.date(),
  })
  .strict();

export type ContextIndexListView = z.infer<typeof contextIndexListViewSchema>;
