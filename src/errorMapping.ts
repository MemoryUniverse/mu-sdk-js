/**
 * Maps a `TransportResponse` onto the typed SDK error hierarchy (`./errors.ts`).
 *
 * Faithful mirror of `mu-sdk-python/src/mu_sdk/error_mapping.py`. The frozen REST error envelope
 * (api-mcp-surface-spec.md §2.4): unexpected failures are `{"detail": str, "request_id": str}`;
 * typed surface errors map to fixed status codes per that same section + mu-local-and-sdk-spec.md
 * §7 (bad/revoked API key -> a non-enumerating 404 mapped client-side to `AuthenticationError`).
 * This module is the ONE place that mapping happens — no verb re-implements its own status-code
 * switch.
 */

import {
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  NotFoundError,
  PrivateDataRejectedError,
  RateLimitedError,
  type SdkError,
  ServerError,
  ServiceUnavailableError,
  SurfaceVerbNotImplementedError,
  UnexpectedResponseError,
  ValidationError,
} from "./errors.js";
import type { TransportResponse } from "./transport.js";

const MCP_PRIVATE_DATA_REJECTED = "private_data_rejected";

function extractDetail(body: unknown): string | undefined {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    const detail = record.detail ?? record.message;
    if (typeof detail === "string") return detail;
  }
  return undefined;
}

function extractMcpCode(body: unknown): string | undefined {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const code = (body as Record<string, unknown>).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/**
 * `request_id` is a BODY field on the frozen REST envelope (api-mcp-surface-spec.md §2.4:
 * `{"detail": str, "request_id": str}`) — prefer it, falling back to the `X-Request-ID` trace
 * header if the body is missing/malformed.
 */
function extractRequestId(body: unknown, response: TransportResponse): string | undefined {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const requestId = (body as Record<string, unknown>).request_id;
    if (typeof requestId === "string") return requestId;
  }
  return response.header("X-Request-ID");
}

function parseRetryAfter(response: TransportResponse): number | undefined {
  const raw = response.header("Retry-After");
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Throws the matching typed `SdkError` for any non-2xx response; returns `undefined` on 2xx.
 * Fail-loud on anything unrecognized (`UnexpectedResponseError`) rather than best-effort guessing
 * (DEV-STANDARDS rule 8). The ONE mapping function every verb + the retry decorator funnels
 * through — never re-implemented per route.
 */
export function mapWireError(response: TransportResponse): void {
  const status = response.statusCode;
  if (status >= 200 && status < 300) return;

  const body = response.jsonBody;
  const detail = extractDetail(body) ?? (response.text || `HTTP ${status}`);
  const requestId = extractRequestId(body, response);

  let error: SdkError;
  if (status === 401) {
    error = new AuthenticationError(detail, { requestId, statusCode: status });
  } else if (status === 403) {
    error =
      extractMcpCode(body) === MCP_PRIVATE_DATA_REJECTED
        ? new PrivateDataRejectedError(detail, { requestId, statusCode: status })
        : new AuthorizationError(detail, { requestId, statusCode: status });
  } else if (status === 404) {
    // single non-enumerating 404: a cross-tenant probe and a bad/revoked API key both land here
    // (mu-local-and-sdk-spec.md §7) — mapped generically to `NotFoundError`; callers needing the
    // "was this an auth problem?" distinction rely on a future `ping()`, out of this phase's scope.
    error = new NotFoundError(detail, { requestId, statusCode: status });
  } else if (status === 409) {
    error = new ConflictError(detail, { requestId, statusCode: status });
  } else if (status === 422) {
    error = new ValidationError(detail, { requestId, statusCode: status });
  } else if (status === 429) {
    error = new RateLimitedError(detail, {
      requestId,
      statusCode: status,
      retryAfterS: parseRetryAfter(response),
    });
  } else if (status === 501) {
    // `promote`/`demote` (build-queue item 5) — see `SurfaceVerbNotImplementedError`'s docstring.
    // `MemoryClient#promote()`/`#demote()` throw this same class client-side WITHOUT ever reaching
    // this branch (no network call is made); this branch exists for the day a real server (Stage
    // C) actually serves a genuine wire 501 for some other not-yet-built verb.
    error = new SurfaceVerbNotImplementedError(detail, { requestId, statusCode: status });
  } else if (status === 503) {
    error = new ServiceUnavailableError(detail, {
      requestId,
      statusCode: status,
      retryAfterS: parseRetryAfter(response),
    });
  } else if (status >= 500 && status < 600) {
    error = new ServerError(detail, { requestId, statusCode: status });
  } else {
    error = new UnexpectedResponseError(detail, { requestId, statusCode: status });
  }
  throw error;
}
