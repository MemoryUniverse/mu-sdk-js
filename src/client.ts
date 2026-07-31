/**
 * `MemoryClient` — the async wire client (mu-local-and-sdk-spec.md §2.3), a faithful mirror of
 * `mu-sdk-python/src/mu_sdk/client.py`.
 *
 * Exposes `add` (write), `search` (simple ranked list, mem0 muscle-memory), `recall` (the
 * MU-canonical rich multi-channel read — now with an optional `tier` option for tier-SCOPED
 * recall, net-new this phase), `get` (point read by id, net-new this phase, Stage D), `buildContext`
 * (the private-plane context-*window* helper, net-new this phase — `LocalMemory.context`'s wire
 * twin, design §2.5 REVIEW-2 FIX 1), `share` (the explicit private->shared CROSSING verb, net-new
 * this phase, design §2.5 REVIEW-2 FIX 4), `promote`/`demote` (net-new this phase — honest `501`,
 * build-queue item 5), `consolidate` (MTM->LTM DISTILL: invalidate-don't-delete SUPERSESSION +
 * bi-temporal SPO extraction), `ask` (MU's own SLM-powered synthesis over recalled context), and
 * `.context` (the `ContextApi` sub-client's read-only `discover` — the SHARED-plane governed-
 * transfer discovery sub-API, distinct from `buildContext`, see that method's docstring). No engine
 * algorithm, no store adapter — every verb that reaches the wire is one HTTP call through the
 * `Transport` port, wrapped by the retry/timeout/trace decorator stack (`./decorators.ts`), with a
 * typed error thrown via `./errorMapping.ts` on any non-2xx response; `promote`/`demote` make no
 * wire call at all (nothing to call yet — see their own docstrings).
 *
 * **Construction — two paths (Stage D, design §3/§4).**
 * 1. **`SdkConfig`-based** (`new MemoryClient({ mode: "local_server", endpoint: "..." })`, design
 *    §1.2's worked example) — the primary, byte-identical-across-modes construction surface.
 *    `mode="embedded"` throws `UnsupportedModeError` immediately (design §1.3: JS is server-only —
 *    "a JS process cannot host the Python engine"). `mode="local_server"`/`"remote"` build a
 *    `FetchTransport` against `endpoint`; auth is the explicit `auth=` if given, else — for
 *    `local_server` only — the per-process bearer token auto-loaded from disk (`./config.ts`'s
 *    `loadEngineServerAuth`, design §1.2 FIX 4), else (`remote`) the env/identity-based
 *    `resolveAuth` fallback. A populated `shared=` layers a SECOND transport/auth pair for the
 *    shared-plane-only verbs (`share`) — design §4's dual-plane composition.
 * 2. **Legacy `settings`/`transport`** (no `mode` given) — the PRE-Stage-D construction shape,
 *    preserved byte-for-byte for backward compatibility with this class's existing conformance-
 *    server-targeted verbs/tests. Unconditionally shared-plane-configured (mirrors
 *    `mu_sdk.client`'s own `_PRIVATE_PLANE_CONFIGURED = False` / `_SHARED_PLANE_CONFIGURED = True`
 *    module-level interim ruling), so every private-plane field on the net-new verbs is honestly
 *    REJECTED under this path — see `./config.ts#planeConfigFor`'s docstring.
 *
 * **Plane-gating (design §2.5 "Unified verb surface").** `get`/`buildContext`/`share` accept
 * plane-gated kwargs (`user`/`session` — private-plane; `visibility` — shared-plane), validated by
 * `./config.ts#validatePlaneFields` — the SAME rule `mu_contracts.validation.plane_gate.
 * validate_plane_fields` enforces on the Python side (ported, not imported — this SDK has no
 * Python dependency). A field supplied for a plane this instance has not configured is REJECTED
 * (`PlaneFieldRejectedError`), never silently dropped or accepted-and-ignored.
 *
 * **`local_server` targets the REAL `mu-engine-server` wire contract, not the conformance server.**
 * `mu-engine-server`'s actual routes (`mu-core/packages/mu-engine-server/src/mu_engine_server/
 * routes/{memories,context}.py`, grounded/verified by this task) differ from the conformance
 * server's placeholder shapes this class's pre-existing `add`/`recall`/etc. verbs target (e.g.
 * `GET /memories/{id}?user=&session=`, no `/v1` prefix, vs. the conformance server's
 * `GET /v1/memories/{id}`; `POST /v1/context/window` body field `query`, not `text`) — an
 * unreconciled gap the design spec itself flags as open (§2.5: "which existing DTO wins as
 * canonical per verb... is not decided by this section... tracked as its own Build-queue item").
 * `get`/`buildContext` therefore branch on whether this instance was constructed with
 * `mode="local_server"` (`#engineServerMode`) and send mu-engine-server's REAL shape in that case —
 * verified end-to-end against a real running `mu-engine-server` instance, see
 * `tests/integration/engineServerStageD.test.ts`. `add`/`recall`/`search`/`consolidate`/`ask`/
 * `.context.discover` are UNCHANGED (frozen verb bodies, still conformance-server/shared-plane
 * shaped) — reconciling THEM against `mu-engine-server` is out of this task's scope (D1's/a future
 * task's job), flagged here rather than silently left implicit.
 *
 * Cancellation (DEV-STANDARDS rule 1, JS analogue): every public verb accepts an optional
 * `signal?: AbortSignal` — the caller's own cancellation token. It is threaded, untouched, through
 * the trace/timeout/retry stack and into `FetchTransport`; firing it aborts the in-flight
 * request/backoff-wait immediately with the caller's own abort reason, never reinterpreted as an
 * `SdkTimeoutError`. `close()` is idempotent and safe to call from a `finally` block.
 */

import { type SdkAuth, resolveAuth } from "./auth.js";
import type { SdkConfig } from "./config.js";
import { loadEngineServerAuth, planeConfigFor, validatePlaneFields } from "./config.js";
import { type RequestFunc, withRetry, withTimeout, withTrace } from "./decorators.js";
import { mapWireError } from "./errorMapping.js";
import {
  NotFoundError,
  SdkConfigError,
  SurfaceVerbNotImplementedError,
  UnsupportedModeError,
} from "./errors.js";
import {
  type AskRequest,
  type AskResult,
  type ConsolidateRequest,
  type ConsolidateResult,
  askRequestSchema,
  askResultSchema,
  consolidateRequestSchema,
  consolidateResultSchema,
} from "./models/consolidate.js";
import {
  type ContextIndexListView,
  type ContextView,
  contextIndexListViewSchema,
  contextViewSchema,
} from "./models/context.js";
import {
  type MemoryCreateRequest,
  type MemoryListResponse,
  type MemoryResponse,
  type MemoryTier,
  type MemoryWriteResult,
  type Visibility,
  memoryCreateRequestSchema,
  memoryListResponseSchema,
  memoryResponseSchema,
} from "./models/memory.js";
import {
  DEFAULT_RECALL_CHANNELS,
  type RecallChannels,
  type RecallMode,
  type RecallRequest,
  type RecallResult,
  recallRequestSchema,
  recallResultSchema,
} from "./models/recall.js";
import { type SdkSettings, type SdkSettingsInput, resolveSdkSettings } from "./settings.js";
import { FetchTransport, type Transport } from "./transport.js";

const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key"; // api-mcp-surface-spec.md §2.3

/** Every public verb accepts this — the AbortController analogue of task cancellation. */
export interface RequestSignalOption {
  signal?: AbortSignal | undefined;
}

export interface AddOptions extends RequestSignalOption {
  visibility?: Visibility;
  tier?: MemoryTier;
  importanceScore?: number;
  idempotencyKey?: string;
  localMemoryId?: string;
  subject?: string;
  predicate?: string;
  /** matches the frozen wire field name (Appendix A.1) exactly */
  object?: string;
  metadata?: Record<string, string>;
}

export interface SearchOptions extends RequestSignalOption {
  limit?: number;
  tier?: MemoryTier;
}

export interface RecallOptions extends RequestSignalOption {
  limit?: number;
  channels?: RecallChannels;
  mode?: RecallMode;
  persona?: string;
  maxTokens?: number;
  correlationId?: string;
  /** Net-new this phase: sent as the `?tier=` QUERY param (never a body field) and always wins
   * server-side over `channels` — tier-SCOPED recall narrowed to exactly one real channel (the
   * demo server's `_effective_tier_filter`). `undefined` (the default) leaves channel selection to
   * `channels`/`mode` as before — no behaviour change for an existing caller that doesn't pass
   * `tier`. */
  tier?: MemoryTier;
}

export interface ConsolidateOptions extends RequestSignalOption {
  limit?: number;
}

export interface AskOptions extends RequestSignalOption {
  limit?: number;
}

/** Private-plane fields (`./config.ts#PRIVATE_PLANE_FIELDS`), plane-gated — see `get()`'s
 * docstring. Meaningful (sent as real query params) only when `mode="local_server"`. */
export interface GetOptions extends RequestSignalOption {
  user?: string;
  session?: string;
}

/** Private-plane fields, plane-gated — see `buildContext()`'s docstring. Meaningful (sent as real
 * body fields) only when `mode="local_server"`. */
export interface BuildContextOptions extends RequestSignalOption {
  user?: string;
  session?: string;
  limit?: number;
  maxChars?: number;
}

/** `visibility` is the one shared-plane field this verb needs — plane-gated, see `share()`'s
 * docstring. Required (unlike `AddOptions.visibility`, which defaults to `"shared"`): `share()`
 * has no sensible default target visibility. */
export interface ShareOptions extends RequestSignalOption {
  visibility: Visibility;
}

/** `promote()`/`demote()` accept but never use these — matching the documented future request
 * shape (`{to_tier, manager_mode?}`); there is no request to build yet (both always throw
 * `SurfaceVerbNotImplementedError`, see their own docstrings). */
export interface PromoteOptions extends RequestSignalOption {
  toTier: MemoryTier;
}

/**
 * The `context` sub-client — `discover` only this phase (see `./models/context.ts` module
 * docstring for the tracked-gap rationale on `index`/`propose`/`inbox`/`decide`/`accept`/
 * `revoke`).
 */
export class ContextApi {
  readonly #execute: RequestFunc;

  /** @internal constructed by `MemoryClient`; not intended for direct instantiation. */
  constructor(execute: RequestFunc) {
    this.#execute = execute;
  }

  /**
   * `POST /v1/context/discover` (api-mcp-surface-spec.md §4.5, l.180); the SDK method shape is
   * `ContextApi.discover(sessionId) -> ContextIndexListView` (api-sdk-mcp-surface-design.md:447).
   */
  async discover(
    sessionId: string,
    options: RequestSignalOption = {},
  ): Promise<ContextIndexListView> {
    const response = await this.#execute("POST", "/v1/context/discover", {
      jsonBody: { session_id: sessionId },
      signal: options.signal,
    });
    return contextIndexListViewSchema.parse(response.jsonBody);
  }
}

export interface MemoryClientOptions extends Partial<SdkConfig> {
  /** A pre-resolved `SdkSettings` (via `resolveSdkSettings(...)`); defaults to
   * `resolveSdkSettings()` (documented defaults <- `MU_*` env). LEGACY path — ignored when `mode`
   * is given (Stage D construction takes over; see module docstring). */
  settings?: SdkSettings;
  /** Injectable `Transport` — swappable/testable (never mocked in integration tests, see
   * `./transport.ts` module docstring). Defaults to `FetchTransport`. Honored on BOTH construction
   * paths (a test may inject a fake transport even under `mode="local_server"` construction). */
  transport?: Transport;
}

/**
 * Async SDK. Constructs with a `SdkSettings` tree (apiKey / demo identity / baseUrl / timeouts /
 * retries — never a hardcoded literal, DEV-STANDARDS rule 3) and an optional injected `Transport`.
 */
export class MemoryClient {
  readonly #settings: SdkSettings;
  readonly #transport: Transport;
  readonly #ownsTransport: boolean;
  readonly #contextApi: ContextApi;

  /** design §2.5 plane-gating (see module docstring + `./config.ts#planeConfigFor`). */
  readonly #privatePlaneConfigured: boolean;
  readonly #sharedPlaneConfigured: boolean;
  /** `true` only when constructed with `mode="local_server"` — `get`/`buildContext` branch on
   * this to send `mu-engine-server`'s REAL wire shape instead of the conformance-server shape
   * (see module docstring's "local_server targets the REAL mu-engine-server" section). */
  readonly #engineServerMode: boolean;
  /** Set only when `shared=` was populated at construction (design §4 dual-plane) — a SECOND
   * request pipeline bound to `shared.endpoint`/`shared.auth`, used by `share()`. `undefined` when
   * this instance is single-plane; `share()` falls back to `_execute` when `mode="remote"` (the
   * primary plane IS the shared plane in that case). */
  readonly #sharedExecute: RequestFunc | undefined;

  /**
   * @internal The ONE request choke-point every public verb funnels through, wrapped by the
   * trace/timeout/retry decorator stack (see module docstring). Exposed (not `#private`) so the
   * integration suite can drive it directly — mirroring the Python SDK's `MemoryClient._execute`
   * test seam (`tests/integration/test_retry_conformance.py`).
   */
  readonly _execute: RequestFunc;

  constructor(options: MemoryClientOptions = {}) {
    if (options.mode === "embedded") {
      // Construction-time error, BEFORE any settings/transport/auth is built — design §1.3: "a JS
      // process cannot host the Python engine... `mode="embedded"` is a construction-time error in
      // the JS SDK." No partially-constructed client ever escapes this branch.
      throw new UnsupportedModeError(
        'MemoryClient({ mode: "embedded" }) is not supported in mu-sdk-js — JS has no engine to ' +
          'run in-process (design §1.3). Use mode="local_server" against a running ' +
          'mu-engine-server, or mode="remote" against a hosted mu-server, instead.',
      );
    }

    const { privateConfigured, sharedConfigured } = planeConfigFor(options.mode, options.shared);
    this.#privatePlaneConfigured = privateConfigured;
    this.#sharedPlaneConfigured = sharedConfigured;
    this.#engineServerMode = options.mode === "local_server";

    let auth: SdkAuth;
    if (options.mode !== undefined) {
      // Stage D construction (design §3/§4): `local_server`/`remote` differ ONLY in
      // endpoint+auth — both build a plain `FetchTransport` against `options.endpoint`.
      if (!options.endpoint) {
        throw new SdkConfigError(
          `SdkConfig.mode=${JSON.stringify(options.mode)} requires endpoint= (design §3: "required for local_server / remote").`,
        );
      }
      this.#settings =
        options.settings ??
        resolveSdkSettings({
          baseUrl: options.endpoint,
          ...(options.timeoutS !== undefined ? { timeoutS: options.timeoutS } : {}),
        });
      if (options.auth) {
        auth = options.auth;
      } else if (options.mode === "local_server") {
        // design §1.2 FIX 4: auto-load the per-process bearer token `make up` mints to disk.
        auth = loadEngineServerAuth(options.tokenPath);
      } else {
        auth = resolveAuth(this.#settings);
      }
    } else {
      // LEGACY construction path (no `mode` given) — byte-for-byte the pre-Stage-D behaviour.
      this.#settings = options.settings ?? resolveSdkSettings();
      auth = options.auth ?? resolveAuth(this.#settings);
    }

    this.#transport = options.transport ?? new FetchTransport(this.#settings);
    this.#ownsTransport = options.transport === undefined;

    const rawRequest: RequestFunc = async (method, path, requestOptions = {}) => {
      const mergedHeaders = { ...auth.headers(), ...requestOptions.headers };
      const response = await this.#transport.request(method, path, {
        ...requestOptions,
        headers: mergedHeaders,
      });
      // Runs INSIDE the retried scope (`withRetry` wraps this function directly), so a
      // 429/503 response throws a `TransientSdkError` that `withRetry` can actually see and
      // retry — mapping it after `_execute` returns would be after every retry is already
      // exhausted. Every public verb's response is therefore guaranteed 2xx.
      mapWireError(response);
      return response;
    };

    // The overall wall-clock ceiling wraps every retry of one logical call: each attempt gets
    // the full per-attempt budget (enforced by `FetchTransport` itself via `settings.timeoutS`),
    // so the ceiling is generous rather than `timeoutS` alone (which would starve retries).
    const overallTimeoutS =
      this.#settings.timeoutS * (this.#settings.maxRetries + 1) + this.#settings.backoffMaxS;
    this._execute = withTrace()(
      withTimeout(overallTimeoutS)(
        withRetry({
          maxRetries: this.#settings.maxRetries,
          backoffBaseS: this.#settings.backoffBaseS,
          backoffMaxS: this.#settings.backoffMaxS,
        })(rawRequest),
      ),
    );
    this.#contextApi = new ContextApi(this._execute);

    // design §4 dual-plane: a populated `shared=` layers a SECOND transport/auth pair, used only
    // by `share()`. Built eagerly (not lazily) so a misconfigured `shared.auth` fails at
    // construction, not on the first `share()` call — the same "fail loud at construction, not on
    // first use" discipline the primary `auth` resolution above already follows.
    if (options.shared) {
      const sharedSettings = resolveSdkSettings({
        baseUrl: options.shared.endpoint,
        ...(options.timeoutS !== undefined ? { timeoutS: options.timeoutS } : {}),
      });
      const sharedTransport = new FetchTransport(sharedSettings);
      const sharedAuthPort = options.shared.auth;
      const sharedRawRequest: RequestFunc = async (method, path, requestOptions = {}) => {
        const mergedHeaders = { ...sharedAuthPort.headers(), ...requestOptions.headers };
        const response = await sharedTransport.request(method, path, {
          ...requestOptions,
          headers: mergedHeaders,
        });
        mapWireError(response);
        return response;
      };
      const sharedOverallTimeoutS =
        sharedSettings.timeoutS * (sharedSettings.maxRetries + 1) + sharedSettings.backoffMaxS;
      this.#sharedExecute = withTrace()(
        withTimeout(sharedOverallTimeoutS)(
          withRetry({
            maxRetries: sharedSettings.maxRetries,
            backoffBaseS: sharedSettings.backoffBaseS,
            backoffMaxS: sharedSettings.backoffMaxS,
          })(sharedRawRequest),
        ),
      );
    } else {
      this.#sharedExecute = undefined;
    }
  }

  get context(): ContextApi {
    return this.#contextApi;
  }

  // ---- write ----

  /**
   * `POST /memories` (api-mcp-surface-spec.md §4.3; Appendix A.1). Shared `POST /memories`
   * rejects `visibility=PRIVATE` server-side — the SDK has no private-to-shared leak path; a
   * PRIVATE write throws `PrivateDataRejectedError`, it is never silently coerced to SHARED.
   *
   * `idempotencyKey`, when given, is sent as the `Idempotency-Key` HEADER (api-mcp-surface-spec.md
   * §2.3 write-idempotency contract) — never duplicated into the JSON body.
   */
  async add(content: string, options: AddOptions = {}): Promise<MemoryResponse> {
    const request: MemoryCreateRequest = memoryCreateRequestSchema.parse({
      content,
      visibility: options.visibility ?? "shared",
      tier: options.tier ?? "stm",
      importance_score: options.importanceScore ?? 0.5,
      local_memory_id: options.localMemoryId,
      subject: options.subject,
      predicate: options.predicate,
      object: options.object,
      metadata: options.metadata ?? {},
    });
    const headers = options.idempotencyKey
      ? { [IDEMPOTENCY_KEY_HEADER]: options.idempotencyKey }
      : undefined;
    const response = await this._execute("POST", "/memories", {
      jsonBody: request,
      headers,
      signal: options.signal,
    });
    return memoryResponseSchema.parse(response.jsonBody);
  }

  // ---- read ----

  /**
   * `GET /memories?query=&limit=&tier=` — the simple ranked-list read (mem0 muscle-memory verb
   * name). For channel/mode/persona control use `.recall()` instead.
   */
  async search(query: string, options: SearchOptions = {}): Promise<MemoryListResponse> {
    const params: Record<string, string | number> = {
      query,
      limit: options.limit ?? this.#settings.defaultPageLimit,
    };
    if (options.tier !== undefined) params.tier = options.tier;
    const response = await this._execute("GET", "/memories", {
      params,
      signal: options.signal,
    });
    return memoryListResponseSchema.parse(response.jsonBody);
  }

  /**
   * `POST /v1/memories/recall` — the MU-canonical rich multi-channel read
   * (recall-service-design.md §1.1). Tenancy (`namespace`) is resolved server-side from the auth
   * identity, never sent by the client (see `./models/recall.ts` module docstring).
   *
   * `options.tier` (net-new this phase: `"stm"|"mtm"|"ltm"`), when given, is sent as the
   * `?tier=` QUERY param (not a body field) and always wins server-side over `channels` — see
   * `RecallOptions.tier`'s own docstring.
   */
  async recall(text: string, options: RecallOptions = {}): Promise<RecallResult> {
    const request: RecallRequest = recallRequestSchema.parse({
      text,
      limit: options.limit ?? this.#settings.defaultRecallLimit,
      channels: options.channels ?? DEFAULT_RECALL_CHANNELS,
      mode: options.mode ?? "ranked",
      persona: options.persona,
      max_tokens: options.maxTokens,
      correlation_id: options.correlationId,
    });
    const response = await this._execute("POST", "/v1/memories/recall", {
      jsonBody: request,
      params: options.tier !== undefined ? { tier: options.tier } : undefined,
      signal: options.signal,
    });
    return recallResultSchema.parse(response.jsonBody);
  }

  /**
   * Point-get by id (net-new this phase, Stage D, design §2.5: "`get` — kept, exists only on
   * `LocalMemory` today — TO BUILD on the wire/`MemoryClient` side so both transports expose it").
   *
   * `options.user`/`options.session` are private-plane fields, plane-gated exactly like `add`'s
   * `user`/`session` (`./config.ts#validatePlaneFields`) — REJECTED under legacy/`mode="remote"`
   * construction (no private plane configured), accepted and sent as real tenancy query params
   * under `mode="local_server"` (`mu-engine-server`'s actual `GET /memories/{id}?user=&session=`
   * contract, `mu_engine_server/routes/memories.py:48-66`).
   *
   * **Route/shape branches on `mode="local_server"`** (`#engineServerMode`, see module docstring's
   * "local_server targets the REAL mu-engine-server" section): `mu-engine-server` serves
   * `GET /memories/{id}` (no `/v1` prefix); every other construction path targets the conformance-
   * server's placeholder `GET /v1/memories/{id}`.
   *
   * Returns `null` on a 404 (not-found) rather than throwing `NotFoundError` — a point-get miss is
   * a perfectly normal outcome, mirroring `LocalMemory.get`'s `| None` miss signal.
   */
  async get(memoryId: string, options: GetOptions = {}): Promise<MemoryResponse | null> {
    validatePlaneFields(
      { user: options.user, session: options.session },
      {
        privateConfigured: this.#privatePlaneConfigured,
        sharedConfigured: this.#sharedPlaneConfigured,
      },
    );
    const path = this.#engineServerMode ? `/memories/${memoryId}` : `/v1/memories/${memoryId}`;
    const params: Record<string, string> = {};
    if (this.#engineServerMode) {
      if (options.user !== undefined) params.user = options.user;
      if (options.session !== undefined) params.session = options.session;
    }
    try {
      const response = await this._execute("GET", path, {
        params: Object.keys(params).length > 0 ? params : undefined,
        signal: options.signal,
      });
      return memoryResponseSchema.parse(response.jsonBody);
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  }

  /**
   * `LocalMemory.context(...)`'s WIRE TWIN (design §2.5 REVIEW-2 FIX 1, net-new this phase) — the
   * PRIVATE-plane context-*WINDOW* helper: deterministic recall + render, NO LLM synthesis.
   *
   * **Not the same verb as `.context.discover(...)`** (`ContextApi`, above) — REVIEW-2 FIX 1
   * (BLOCKER) is explicit that collapsing these two is unbuildable: they take different inputs,
   * return different DTOs (`ContextView` here vs. `ContextIndexListView` there), and live on
   * different planes (`.context.discover` is the SHARED-plane governed-transfer discovery sub-API,
   * plane-gated to a populated `shared=`/`mode="remote"`; this method is the PRIVATE-plane window
   * helper). The name collision is why this method is `buildContext`, not `context` — `.context`
   * already means the shared sub-client on this class and stays untouched by this addition.
   *
   * `options.user`/`options.session` are plane-gated identically to `get()`'s — see that method's
   * docstring. **Route/body branches on `mode="local_server"`**: `mu-engine-server`'s real
   * `POST /v1/context/window` body is `{query, user, session, limit, max_chars}`
   * (`mu_engine_server/schemas.py::ContextWindowRequest`) — note the field name `query`, NOT
   * `text`; every other construction path targets the conformance server's placeholder shape,
   * which uses `text` (see module docstring's flagged reconciliation gap).
   */
  async buildContext(text: string, options: BuildContextOptions = {}): Promise<ContextView> {
    validatePlaneFields(
      { user: options.user, session: options.session },
      {
        privateConfigured: this.#privatePlaneConfigured,
        sharedConfigured: this.#sharedPlaneConfigured,
      },
    );
    const limit = options.limit ?? this.#settings.defaultRecallLimit;
    const body: Record<string, unknown> = this.#engineServerMode
      ? { query: text, limit }
      : { text, limit };
    if (this.#engineServerMode) {
      if (options.user !== undefined) body.user = options.user;
      if (options.session !== undefined) body.session = options.session;
    }
    if (options.maxChars !== undefined) body.max_chars = options.maxChars;
    const response = await this._execute("POST", "/v1/context/window", {
      jsonBody: body,
      signal: options.signal,
    });
    return contextViewSchema.parse(response.jsonBody);
  }

  /**
   * `POST /v1/memories/{memoryId}/share` (design §2.5 REVIEW-2 FIX 4; §13 item 3) — the explicit
   * private->shared CROSSING verb: *"There is no auto-bridge in `mu-local`... the crossing is
   * always an explicit SDK write"* (mu-local-and-sdk-spec.md §4.3, preserved verbatim by design
   * §4's dual-plane worked example, which calls this exact method).
   *
   * Shared-plane-gated (`visibility` is one of `./config.ts`'s `SHARED_PLANE_FIELDS`) — REJECTED
   * unless this instance was constructed with a populated `shared=` or `mode="remote"`
   * (`./config.ts#planeConfigFor`); a no-op guard under legacy construction (unconditionally
   * shared-plane-configured there) since that path predates Stage D's plane toggle.
   *
   * Routes through the SECOND (`shared`) request pipeline when this instance is dual-plane
   * (`mode="local_server"` + populated `shared=`), or through the primary `_execute` when
   * `mode="remote"` is the ONLY plane (the primary plane IS the shared plane in that case). There
   * is no real shared-plane server to target yet (`mu-server` is COMMERCIAL/empty, design's own
   * T1b MINOR 7: "`mode="remote"` leg deferred") — this method's own wiring is real and tested via
   * plane-gating rejection + request construction against a fake transport; the live 200-path
   * needs a real `mu-server`, out of this task's reach.
   */
  async share(memoryId: string, options: ShareOptions): Promise<MemoryResponse> {
    validatePlaneFields(
      { visibility: options.visibility },
      {
        privateConfigured: this.#privatePlaneConfigured,
        sharedConfigured: this.#sharedPlaneConfigured,
      },
    );
    const execute = this.#sharedExecute ?? this._execute;
    const response = await execute("POST", `/v1/memories/${memoryId}/share`, {
      jsonBody: { visibility: options.visibility },
      signal: options.signal,
    });
    return memoryResponseSchema.parse(response.jsonBody);
  }

  // ---- lifecycle (TO BUILD, build-queue item 5 — honest 501, never a silent no-op) ----

  /**
   * `POST /v1/memories/{id}/promote` (api-mcp-surface-spec.md §4.3b) is DESIGNED but has NO
   * engine-side implementation anywhere in the tree yet. This is the wire twin of that exact
   * honesty: throws the NAMED `SurfaceVerbNotImplementedError` (`statusCode=501`) immediately,
   * with NO network call — there is nothing on the other end to call yet. Never a silent no-op or
   * a partial success (design §2.5, DEV-STANDARDS rule 8). Return type is annotated
   * `MemoryWriteResult` (the receipt shape `SDK-BUILD-DECISIONS.md` Decision B already assigns for
   * when this DOES get built) purely for future signature stability; this method never actually
   * returns.
   */
  async promote(memoryId: string, options: PromoteOptions): Promise<MemoryWriteResult> {
    throw new SurfaceVerbNotImplementedError(
      `MemoryClient#promote(memoryId=${JSON.stringify(memoryId)}, toTier=${JSON.stringify(options.toTier)}) is not implemented: no engine/wire counterpart exists yet (build-queue item 5). Use recall()/get() plus a manual add() until this lands.`,
      { statusCode: 501 },
    );
  }

  /**
   * See `promote()` — the identical honest-`501` twin for the opposite tier transition
   * (`POST /v1/memories/{id}/demote`), same reasoning, same NAMED error, same NO-network-call
   * discipline.
   */
  async demote(memoryId: string, options: PromoteOptions): Promise<MemoryWriteResult> {
    throw new SurfaceVerbNotImplementedError(
      `MemoryClient#demote(memoryId=${JSON.stringify(memoryId)}, toTier=${JSON.stringify(options.toTier)}) is not implemented: no engine/wire counterpart exists yet (build-queue item 5). Use recall()/get() plus a manual add() until this lands.`,
      { statusCode: 501 },
    );
  }

  /**
   * `POST /v1/memories/consolidate` (net-new this phase) — MTM->LTM DISTILL: extracts bi-temporal
   * SPO facts from the recent STM/MTM window and writes them into the LTM graph, applying
   * invalidate-don't-delete SUPERSESSION (the MemGC/Phi headline capability). Tenancy is resolved
   * server-side from the auth identity, same as every other verb.
   */
  async consolidate(options: ConsolidateOptions = {}): Promise<ConsolidateResult> {
    const request: ConsolidateRequest = consolidateRequestSchema.parse({
      limit: options.limit ?? 50,
    });
    const response = await this._execute("POST", "/v1/memories/consolidate", {
      jsonBody: request,
      signal: options.signal,
    });
    return consolidateResultSchema.parse(response.jsonBody);
  }

  /**
   * `POST /v1/memories/ask` (net-new this phase) — MU's own SLM-powered synthesis over recalled
   * context (contrast with the raw ranked list `recall()`/`search()` return). Throws
   * `ServiceUnavailableError` (mapped from the server's 503) when the server has no LLM/SLM
   * configured (heuristic mode) — never a silently-empty answer.
   */
  async ask(question: string, options: AskOptions = {}): Promise<AskResult> {
    const request: AskRequest = askRequestSchema.parse({
      question,
      limit: options.limit ?? this.#settings.defaultRecallLimit,
    });
    const response = await this._execute("POST", "/v1/memories/ask", {
      jsonBody: request,
      signal: options.signal,
    });
    return askResultSchema.parse(response.jsonBody);
  }

  // ---- lifecycle ----

  /**
   * Idempotent close. Only closes the transport this client constructed itself — an injected
   * `Transport` is owned by its caller (repository-pattern discipline).
   */
  async close(): Promise<void> {
    if (this.#ownsTransport) {
      await this.#transport.close();
    }
  }
}
