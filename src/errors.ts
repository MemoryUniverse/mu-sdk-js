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
