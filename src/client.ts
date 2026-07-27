/**
 * `MemoryClient` — the async wire client (mu-local-and-sdk-spec.md §2.3), a faithful mirror of
 * `mu-sdk-python/src/mu_sdk/client.py`.
 *
 * Exposes exactly the four verbs this phase's brief scopes: `add` (write), `search` (simple
 * ranked list, mem0 muscle-memory), `recall` (the MU-canonical rich multi-channel read), and
 * `.context` (the `ContextApi` sub-client's read-only `discover`). No engine algorithm, no store
 * adapter — every verb is one HTTP call through the `Transport` port, wrapped by the
 * retry/timeout/trace decorator stack (`./decorators.ts`), with a typed error thrown via
 * `./errorMapping.ts` on any non-2xx response.
 *
 * Cancellation (DEV-STANDARDS rule 1, JS analogue): every public verb accepts an optional
 * `signal?: AbortSignal` — the caller's own cancellation token. It is threaded, untouched, through
 * the trace/timeout/retry stack and into `FetchTransport`; firing it aborts the in-flight
 * request/backoff-wait immediately with the caller's own abort reason, never reinterpreted as an
 * `SdkTimeoutError`. `close()` is idempotent and safe to call from a `finally` block.
 */

import { type SdkAuth, resolveAuth } from "./auth.js";
import { type RequestFunc, withRetry, withTimeout, withTrace } from "./decorators.js";
import { mapWireError } from "./errorMapping.js";
import { type ContextIndexListView, contextIndexListViewSchema } from "./models/context.js";
import {
  type MemoryCreateRequest,
  type MemoryListResponse,
  type MemoryResponse,
  type MemoryTier,
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

export interface MemoryClientOptions {
  /** A pre-resolved `SdkSettings` (via `resolveSdkSettings(...)`); defaults to
   * `resolveSdkSettings()` (documented defaults <- `MU_*` env). */
  settings?: SdkSettings;
  /** Injectable `Transport` — swappable/testable (never mocked in integration tests, see
   * `./transport.ts` module docstring). Defaults to `FetchTransport`. */
  transport?: Transport;
  auth?: SdkAuth;
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

  /**
   * @internal The ONE request choke-point every public verb funnels through, wrapped by the
   * trace/timeout/retry decorator stack (see module docstring). Exposed (not `#private`) so the
   * integration suite can drive it directly — mirroring the Python SDK's `MemoryClient._execute`
   * test seam (`tests/integration/test_retry_conformance.py`).
   */
  readonly _execute: RequestFunc;

  constructor(options: MemoryClientOptions = {}) {
    this.#settings = options.settings ?? resolveSdkSettings();
    const auth = options.auth ?? resolveAuth(this.#settings);
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
      signal: options.signal,
    });
    return recallResultSchema.parse(response.jsonBody);
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
