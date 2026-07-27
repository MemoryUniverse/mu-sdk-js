/**
 * The `Transport` port — the seam that makes `fetch` swappable/testable (DEV-STANDARDS rule 5:
 * "repository pattern for all data access" generalized to the one external dependency this SDK
 * has: the HTTP client). `MemoryClient` never calls `fetch` directly outside `FetchTransport`;
 * every other module talks to the `Transport` interface.
 *
 * Faithful mirror of `mu-sdk-python/src/mu_sdk/transport.py`, ported from `httpx.AsyncClient` onto
 * the platform `fetch` (native in Node >=18, no dependency needed). Keeps the "one client, reused"
 * shape (a single base-url + default-headers configuration) but behind a protocol so a conformance
 * test can swap in a deterministic fake transport for pure-unit tests (never for integration tests
 * — those use the real `FetchTransport` over real TCP, DEV-STANDARDS "zero mocks").
 */

import { SdkTimeoutError, TransportError } from "./errors.js";
import type { SdkSettings } from "./settings.js";

/** The transport-agnostic response envelope every `Transport` implementation returns. */
export class TransportResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  readonly jsonBody: unknown;
  readonly text: string;

  constructor(
    statusCode: number,
    headers: Record<string, string> = {},
    jsonBody: unknown = null,
    text = "",
  ) {
    this.statusCode = statusCode;
    this.headers = headers;
    this.jsonBody = jsonBody;
    this.text = text;
  }

  /** Case-insensitive header lookup (HTTP header names are case-insensitive). */
  header(name: string): string | undefined {
    const lowered = name.toLowerCase();
    for (const [key, value] of Object.entries(this.headers)) {
      if (key.toLowerCase() === lowered) return value;
    }
    return undefined;
  }
}

export type QueryParams = Record<string, string | number | boolean | undefined>;

export interface TransportRequestOptions {
  params?: QueryParams;
  jsonBody?: unknown;
  headers?: Record<string, string>;
  /** Per-call timeout override, in seconds. Defaults to `SdkSettings.timeoutS`. */
  timeoutS?: number;
  /** Caller-driven cancellation (the AbortController analogue of `asyncio.CancelledError`
   * propagation): if this signal fires, the in-flight request is aborted and the SAME abort
   * reason propagates unwrapped — never converted into `SdkTimeoutError`. */
  signal?: AbortSignal;
}

/**
 * The port. `FetchTransport` is the shipped adapter; a test may bind a fake for pure-unit
 * coverage of error-mapping/retry logic without a real socket.
 */
export interface Transport {
  request(
    method: string,
    path: string,
    options?: TransportRequestOptions,
  ): Promise<TransportResponse>;
  close(): Promise<void>;
}

/** The `fetch`-compatible function signature `FetchTransport` depends on (injectable for tests). */
export type FetchLike = typeof fetch;

function buildUrl(baseUrl: string, path: string, params?: QueryParams): string {
  const url = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/**
 * The shipped `Transport` adapter — one configuration (base url + default headers), fully async,
 * cancellation-safe: a caller-supplied `AbortSignal` firing propagates its own abort reason
 * unwrapped (never reinterpreted as `SdkTimeoutError`); only the internally-derived per-attempt
 * timeout signal is mapped to `SdkTimeoutError`.
 */
export class FetchTransport implements Transport {
  readonly #settings: SdkSettings;
  readonly #fetchImpl: FetchLike;

  constructor(settings: SdkSettings, options: { fetchImpl?: FetchLike } = {}) {
    this.#settings = settings;
    this.#fetchImpl = options.fetchImpl ?? fetch;
  }

  async request(
    method: string,
    path: string,
    options: TransportRequestOptions = {},
  ): Promise<TransportResponse> {
    const url = buildUrl(this.#settings.baseUrl, path, options.params);
    const timeoutS = options.timeoutS ?? this.#settings.timeoutS;
    const timeoutSignal = AbortSignal.timeout(timeoutS * 1000);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;

    const headers: Record<string, string> = {
      "User-Agent": this.#settings.userAgent,
      ...options.headers,
    };
    let body: string | undefined;
    if (options.jsonBody !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.jsonBody);
    }

    let response: Response;
    try {
      response = await this.#fetchImpl(url, { method, headers, body, signal });
    } catch (exc) {
      if (options.signal?.aborted) {
        // Outer cancellation — propagate the caller's own abort reason untouched (the fetch
        // analogue of never swallowing `asyncio.CancelledError`).
        throw exc;
      }
      if (timeoutSignal.aborted) {
        throw new SdkTimeoutError(`request timed out: ${method} ${path}`);
      }
      throw new TransportError(`transport failure: ${method} ${path}: ${String(exc)}`);
    }

    const text = await response.text();
    let jsonBody: unknown = null;
    if (text.length > 0) {
      try {
        jsonBody = JSON.parse(text);
      } catch {
        jsonBody = null;
      }
    }

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    return new TransportResponse(response.status, responseHeaders, jsonBody, text);
  }

  async close(): Promise<void> {
    // `fetch` holds no explicit client handle to release (unlike `httpx.AsyncClient`'s
    // connection pool) — this exists for `Transport`-port symmetry and so tests injecting a fake
    // transport have a real teardown hook to assert against.
  }
}
