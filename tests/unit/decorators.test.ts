/**
 * Pure-unit: the retry/timeout/trace stack (`../../src/decorators.ts`). Uses a fake function (NOT
 * a mock of `fetch`/`Transport` internals — a plain async function standing in for the request
 * choke-point) to exercise retry counts, backoff-on-transient-only, timeout, trace-header
 * injection, and cancellation-safety in isolation. Mirrors
 * `mu-sdk-python/tests/unit/test_decorators.py` test-for-test.
 */
import { describe, expect, it } from "vitest";
import { type RequestFunc, withRetry, withTimeout, withTrace } from "../../src/decorators.js";
import {
  AuthenticationError,
  RateLimitedError,
  SdkTimeoutError,
  TransportError,
} from "../../src/errors.js";
import { TransportResponse } from "../../src/transport.js";

describe("withRetry", () => {
  it("succeeds after transient failures", async () => {
    let calls = 0;
    const flaky: RequestFunc = async () => {
      calls += 1;
      if (calls < 3) throw new TransportError("boom");
      return new TransportResponse(200);
    };
    const wrapped = withRetry({ maxRetries: 5, backoffBaseS: 0.001, backoffMaxS: 0.01 })(flaky);
    const result = await wrapped("GET", "/x");
    expect(result.statusCode).toBe(200);
    expect(calls).toBe(3);
  });

  it("exhausts and rethrows the transient error", async () => {
    let calls = 0;
    const alwaysFails: RequestFunc = async () => {
      calls += 1;
      throw new TransportError("still boom");
    };
    const wrapped = withRetry({ maxRetries: 2, backoffBaseS: 0.001, backoffMaxS: 0.01 })(
      alwaysFails,
    );
    await expect(wrapped("GET", "/x")).rejects.toBeInstanceOf(TransportError);
    expect(calls).toBe(3); // 1 initial attempt + 2 retries
  });

  it("never retries a permanent error", async () => {
    let calls = 0;
    const permanentFailure: RequestFunc = async () => {
      calls += 1;
      throw new AuthenticationError("bad creds");
    };
    const wrapped = withRetry({ maxRetries: 5, backoffBaseS: 0.001, backoffMaxS: 0.01 })(
      permanentFailure,
    );
    await expect(wrapped("GET", "/x")).rejects.toBeInstanceOf(AuthenticationError);
    expect(calls).toBe(1); // never retried
  });

  it("honors and caps a server-declared Retry-After", async () => {
    let calls = 0;
    const rateLimitedThenOk: RequestFunc = async () => {
      calls += 1;
      if (calls === 1) throw new RateLimitedError("slow down", { retryAfterS: 100.0 }); // far above cap
      return new TransportResponse(200);
    };
    const wrapped = withRetry({ maxRetries: 2, backoffBaseS: 0.01, backoffMaxS: 0.2 })(
      rateLimitedThenOk,
    );
    const started = Date.now();
    const result = await wrapped("GET", "/x");
    const elapsedS = (Date.now() - started) / 1000;
    expect(result.statusCode).toBe(200);
    // would be ~100s if the server hint weren't capped at backoffMaxS
    expect(elapsedS).toBeLessThan(2.0);
  });
});

describe("withTimeout", () => {
  it("raises SdkTimeoutError and does not leak the raw AbortError", async () => {
    // A realistic `RequestFunc` (like `FetchTransport`) honors the `signal` it is given — this
    // fake does the same, rejecting with the signal's own abort reason when it fires, exactly
    // as `fetch` does. `withTimeout` is responsible for translating THAT into `SdkTimeoutError`.
    const slow: RequestFunc = (_method, _path, options) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(new TransportResponse(200)), 1000);
        options?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(options.signal?.reason);
        });
      });
    const wrapped = withTimeout(0.01)(slow);
    await expect(wrapped("GET", "/x")).rejects.toBeInstanceOf(SdkTimeoutError);
  });

  it("does not swallow an outer AbortSignal cancellation", async () => {
    const controller = new AbortController();
    let started = false;
    const slow: RequestFunc = (_method, _path, options) =>
      new Promise((resolve, reject) => {
        started = true;
        const timer = setTimeout(() => resolve(new TransportResponse(200)), 10_000);
        options?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(options.signal?.reason);
        });
      });
    const wrapped = withTimeout(30.0)(slow); // generous budget: only the OUTER abort should fire
    const promise = wrapped("GET", "/x", { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(started).toBe(true);
    controller.abort(new Error("caller cancelled"));
    await expect(promise).rejects.toThrow("caller cancelled");
  });
});

describe("withTrace", () => {
  it("mints a request id once and reuses it across retries", async () => {
    const seenIds: (string | undefined)[] = [];
    let calls = 0;
    const flaky: RequestFunc = async (_method, _path, options) => {
      calls += 1;
      seenIds.push(options?.headers?.["X-Request-ID"]);
      if (seenIds.length < 3) throw new TransportError("boom");
      return new TransportResponse(200);
    };
    const wrapped = withTrace()(
      withRetry({ maxRetries: 5, backoffBaseS: 0.001, backoffMaxS: 0.01 })(flaky),
    );
    await wrapped("GET", "/x");
    expect(seenIds).toHaveLength(3);
    expect(new Set(seenIds).size).toBe(1); // the SAME id across every retry attempt
    expect(seenIds[0]).toBeDefined();
    expect(calls).toBe(3);
  });

  it("respects a caller-supplied request id", async () => {
    const seen: (string | undefined)[] = [];
    const once: RequestFunc = async (_method, _path, options) => {
      seen.push(options?.headers?.["X-Request-ID"]);
      return new TransportResponse(200);
    };
    const wrapped = withTrace()(once);
    await wrapped("GET", "/x", { headers: { "X-Request-ID": "caller-id" } });
    expect(seen).toEqual(["caller-id"]);
  });
});
