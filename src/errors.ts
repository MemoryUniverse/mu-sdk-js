/**
 * The typed SDK error hierarchy — maps wire-observed failures (HTTP status + the frozen REST
 * error envelope `{detail, request_id}`, api-mcp-surface-spec.md §2.4) onto typed exceptions.
 *
 * Faithful mirror of `mu-sdk-python/src/mu_sdk/errors.py`. Deliberately a SEPARATE hierarchy from
 * any server-side taxonomy: the SDK is a CLIENT — it never reconstructs a server exception from a
 * wire response, it observes a status code + an envelope and maps to its OWN client-side type
 * (same pattern as the Python SDK / mem0.exceptions / stripe.error).
 *
 * Fail-loud discipline (DEV-STANDARDS rule 8): every non-2xx response raises here. Nothing is
 * swallowed; there is no silent fallback path in this module.
 */

/** Root of the mu-sdk client-side error hierarchy. */
export class SdkError extends Error {
  readonly requestId: string | undefined;
  readonly statusCode: number | undefined;

  constructor(
    message: string,
    options: { requestId?: string | undefined; statusCode?: number | undefined } = {},
  ) {
    super(message);
    this.name = this.constructor.name;
    this.requestId = options.requestId;
    this.statusCode = options.statusCode;
    // Restores the prototype chain broken by transpiling `Error` subclasses on some targets;
    // harmless (already correct) under this package's ES2022 target, kept for defensiveness.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  override toString(): string {
    return `${this.name}(message=${JSON.stringify(this.message)}, status_code=${this.statusCode ?? "null"}, request_id=${this.requestId ?? "null"})`;
  }
}

/**
 * Marker base for failures the retry logic (`withRetry`) is allowed to retry (network-level,
 * rate-limited, or a server-declared transient unavailability). Never thrown directly — always
 * one of the concrete subclasses below.
 */
export class TransientSdkError extends SdkError {}

/** A network-level failure (connect/read error, DNS, TLS) — no HTTP response was received. */
export class TransportError extends TransientSdkError {}

/**
 * The client-side timeout budget (`SdkSettings.timeoutS` or a per-call override) elapsed before a
 * response was received. Distinct from a 503 `ServiceUnavailableError` — this one never reached
 * the server, or the server never answered in time.
 */
export class SdkTimeoutError extends TransientSdkError {}

/** HTTP 429 — the gateway rate class was exceeded (api-mcp-surface-spec.md §2.7). */
export class RateLimitedError extends TransientSdkError {
  readonly retryAfterS: number | undefined;

  constructor(
    message: string,
    options: {
      requestId?: string | undefined;
      statusCode?: number | undefined;
      retryAfterS?: number | undefined;
    } = {},
  ) {
    super(message, options);
    this.retryAfterS = options.retryAfterS;
  }
}

/**
 * HTTP 503 — a named degrade surfaced as a fail-visible unavailability. The SDK never downgrades
 * this to a synthesized success (§4.8's "fail-visible rule" applies at the SDK boundary too).
 */
export class ServiceUnavailableError extends TransientSdkError {
  readonly retryAfterS: number | undefined;

  constructor(
    message: string,
    options: {
      requestId?: string | undefined;
      statusCode?: number | undefined;
      retryAfterS?: number | undefined;
    } = {},
  ) {
    super(message, options);
    this.retryAfterS = options.retryAfterS;
  }
}

/**
 * HTTP 401 — missing/invalid/revoked credential (mu-local-and-sdk-spec.md §7 T5: a bad API key
 * raises this; a revoked key mid-session maps from a non-enumerating 404 to this same type per
 * that spec's error table).
 */
export class AuthenticationError extends SdkError {}

/** HTTP 403 — the caller is authenticated but the operation is denied. */
export class AuthorizationError extends SdkError {}

/**
 * A PRIVATE-visibility write was rejected by the SHARED-only route. The SDK has no
 * private->shared leak path — this is the client-visible proof of that.
 */
export class PrivateDataRejectedError extends AuthorizationError {}

/**
 * HTTP 404 — including the deliberate single non-enumerating 404 a cross-tenant probe gets
 * (api-mcp-surface-spec.md §2.2/§2.4): the SDK cannot and must not distinguish "denied" from
 * "absent" from this exception alone.
 */
export class NotFoundError extends SdkError {}

/**
 * HTTP 409 — a conflicting idempotent replay (`Idempotency-Key` reused with a different body,
 * api-mcp-surface-spec.md §2.3) or a resolve-on-terminal-record conflict.
 */
export class ConflictError extends SdkError {}

/**
 * HTTP 422 — the request failed server-side validation (distinct from a client-side zod
 * `ZodError`, which is raised before any request is even sent).
 */
export class ValidationError extends SdkError {}

/**
 * HTTP 5xx other than 503 — an unexpected server failure. REST envelope is
 * `{"detail": str, "request_id": str}` (api-mcp-surface-spec.md §2.4); never leaks a stack trace
 * or internal exception name, by the server's own contract.
 */
export class ServerError extends SdkError {}

/**
 * The response did not match ANY known shape (bad status code range, non-JSON body where JSON
 * was expected, a missing required envelope field). Fail-loud rather than best-effort guessing
 * (DEV-STANDARDS rule 8).
 */
export class UnexpectedResponseError extends SdkError {}

/**
 * `promote`/`demote` have no engine/wire counterpart anywhere in the tree yet (build-queue item 5;
 * design §2.5's unified-verb-surface proposal): "the facade method raises `NotImplementedError`
 * (never a fake 200) until the engine counterpart lands" (api-mcp-surface-spec.md §4.3b).
 * `MemoryClient#promote()`/`#demote()` throw this NAMED error (`statusCode=501`) immediately, with
 * NO network call — there is nothing to call. Faithful mirror of
 * `mu_sdk.errors.SurfaceVerbNotImplementedError` (Python).
 *
 * Also mapped here by `./errorMapping.ts#mapWireError` from a genuine wire HTTP 501, for the day a
 * real server actually serves one — never a silent no-op or partial success on either path
 * (DEV-STANDARDS rule 8).
 */
export class SurfaceVerbNotImplementedError extends SdkError {}

/**
 * `MemoryClient({ mode: "embedded" })` is a construction-time error in the JS SDK — JS has no
 * engine to run in-process (design §1.3: "a JS process cannot host the Python engine... `mode=
 * "embedded"` is a construction-time error in the JS SDK"). Thrown BEFORE any settings/transport
 * are built; JS has exactly two real modes (`local_server`/`remote`), both wire clients.
 */
export class UnsupportedModeError extends SdkError {}

/**
 * `SdkConfig` (`./config.ts`) was given a shape that cannot be constructed into a working client —
 * e.g. `mode="local_server"`/`"remote"` with no `endpoint=`, or a `shared=` sub-object missing its
 * required `auth`. Distinct from a zod `ZodError` (which fires on a malformed VALUE for a field
 * that exists) — this is a missing-REQUIRED-combination error, the config-object analogue of
 * `mu_contracts`'s pydantic `required` field errors on `SharedPlaneConfig`/`SdkConfig` (Python).
 */
export class SdkConfigError extends SdkError {}

/**
 * A canonical-signature field (`./config.ts`'s `PRIVATE_PLANE_FIELDS`/`SHARED_PLANE_FIELDS`) was
 * supplied for a plane the caller has not configured (design §2.5: "Supplying a field that doesn't
 * apply to the currently-configured plane is a REJECTION, not a silent no-op"). Faithful mirror of
 * `mu_contracts.domain.errors.PlaneFieldRejectedError` (Python) — same field/plane/reason shape,
 * ported rather than imported (this SDK never imports `mu_contracts`' Python package; TS has its
 * own `./config.ts#validatePlaneFields` doing the identical check).
 */
export class PlaneFieldRejectedError extends SdkError {
  readonly field: string;
  readonly plane: string;

  constructor(field: string, options: { plane: string; reason: string }) {
    super(
      `field '${field}' requires the '${options.plane}' plane to be configured: ${options.reason}`,
    );
    this.field = field;
    this.plane = options.plane;
  }
}

/**
 * `mode="local_server"` with no explicit `auth=` auto-loads the per-process bearer token `make up`
 * mints to disk (design §1.2 FIX 4, §2.4/§11.2) — this is the NAMED failure when that file is
 * missing, unreadable, or blank, surfaced instead of a bare `ENOENT`/`fs` exception (DEV-STANDARDS
 * rule 8: fail-loud, never a silent fallback). Subclasses `AuthenticationError` — it IS an auth
 * failure, just one discovered before any request is even built.
 */
export class EngineServerTokenNotFoundError extends AuthenticationError {}
