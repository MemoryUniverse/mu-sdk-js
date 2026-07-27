/**
 * Cross-cutting decorators — retry/backoff, timeout, and trace-header injection
 * (DEV-STANDARDS rule 7: "anything repeated across many functions becomes a decorator, not
 * copy-paste"). Applied ONCE, at `MemoryClient` construction, around the single request
 * choke-point (`MemoryClient#rawRequest`) — every public verb (`add`/`search`/`recall`/
 * `context.discover`) funnels through that one wrapped call, so the cross-cutting behavior is
 * never duplicated per verb.
 *
 * Faithful mirror of `mu-sdk-python/src/mu_sdk/decorators.py`. Composition (see `client.ts`):
 * `withTrace()(withTimeout(overallS)(withRetry(...)(rawRequest)))` — trace mints a request id ONCE
 * per logical call and it is reused across every retry; the overall timeout wraps the whole retry
 * loop (a generous ceiling, not per-attempt — the per-attempt timeout is enforced by
 * `FetchTransport` itself via `SdkSettings.timeoutS`, mirroring `HttpxTransport`'s own configured
 * client timeout).
 *
 * Cancellation-safety (the JS analogue of "never swallow `asyncio.CancelledError`"): every wrapper
 * threads the caller's `AbortSignal` through untouched. If that signal fires — during a fetch, or
 * during a retry backoff sleep — its OWN abort reason propagates unwrapped; only the two
 * SDK-internal timeout signals (`FetchTransport`'s per-attempt one, `withTimeout`'s overall one)
 * are ever translated into `SdkTimeoutError`.
 */

import { SdkTimeoutError, TransientSdkError } from "./errors.js";
import type { TransportRequestOptions, TransportResponse } from "./transport.js";

export type RequestFunc = (
  method: string,
  path: string,
  options?: TransportRequestOptions,
) => Promise<TransportResponse>;

/** Rejects when `signal` aborts (with the signal's own reason); resolves after `ms` otherwise. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(signal?.reason);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Wait strategy: honor a server-declared `Retry-After` (surfaced on
 * `RateLimitedError.retryAfterS` / `ServiceUnavailableError.retryAfterS`) when present, capped at
 * `backoffMaxS`; otherwise exponential backoff (`backoffBaseS * 2^(attempt-1)`, same capped).
 */
function computeWaitS(
  error: unknown,
  attempt: number,
  backoffBaseS: number,
  backoffMaxS: number,
): number {
  const retryAfterS = (error as { retryAfterS?: number }).retryAfterS;
  if (typeof retryAfterS === "number") {
    return Math.min(retryAfterS, backoffMaxS);
  }
  return Math.min(backoffBaseS * 2 ** (attempt - 1), backoffMaxS);
}

export interface RetryOptions {
  maxRetries: number;
  backoffBaseS: number;
  backoffMaxS: number;
}

/**
 * Retries only `TransientSdkError` subclasses (transport failure / local timeout / rate-limited /
 * service-unavailable) — never an authentication/validation/not-found error, which are permanent
 * per-call outcomes, not transient.
 */
export function withRetry(options: RetryOptions): (fn: RequestFunc) => RequestFunc {
  const { maxRetries, backoffBaseS, backoffMaxS } = options;
  return (fn) =>
    async (method, path, requestOptions = {}) => {
      for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        try {
          return await fn(method, path, requestOptions);
        } catch (error) {
          if (!(error instanceof TransientSdkError) || attempt === maxRetries + 1) {
            throw error;
          }
          const waitS = computeWaitS(error, attempt, backoffBaseS, backoffMaxS);
          await sleep(waitS * 1000, requestOptions.signal);
        }
      }
      // unreachable: the loop above either returns or throws on its final attempt.
      throw new Error("unreachable: retry loop exited without a result");
    };
}

/**
 * A hard wall-clock ceiling for the whole call (i.e. including any retries wrapped INSIDE this
 * decorator — see the module docstring's composition order). Cancellation-safe: a caller-supplied
 * `AbortSignal` firing propagates its own abort reason unconverted; only THIS decorator's own
 * internally-derived timeout signal maps to `SdkTimeoutError`.
 */
export function withTimeout(timeoutS: number): (fn: RequestFunc) => RequestFunc {
  return (fn) =>
    async (method, path, options = {}) => {
      const callerSignal = options.signal;
      const timeoutSignal = AbortSignal.timeout(timeoutS * 1000);
      const combinedSignal = callerSignal
        ? AbortSignal.any([callerSignal, timeoutSignal])
        : timeoutSignal;
      try {
        return await fn(method, path, { ...options, signal: combinedSignal });
      } catch (error) {
        if (callerSignal?.aborted) {
          throw error; // outer cancellation — propagate untouched
        }
        if (timeoutSignal.aborted) {
          throw new SdkTimeoutError(`${method} ${path} exceeded the ${timeoutS}s budget`);
        }
        throw error;
      }
    };
}

/**
 * Mints `X-Request-ID`/`X-Turn-ID` once per logical call if the caller did not already supply
 * them (api-mcp-surface-spec.md §2.3: "minted if absent"), threading them through every retry of
 * that same call via the closed-over `headers` option.
 */
export function withTrace(): (fn: RequestFunc) => RequestFunc {
  return (fn) =>
    async (method, path, options = {}) => {
      const headers: Record<string, string> = { ...options.headers };
      if (!headers["X-Request-ID"]) headers["X-Request-ID"] = crypto.randomUUID();
      if (!headers["X-Turn-ID"]) headers["X-Turn-ID"] = crypto.randomUUID();
      return fn(method, path, { ...options, headers });
    };
}
