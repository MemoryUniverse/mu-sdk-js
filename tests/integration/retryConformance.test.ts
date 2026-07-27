/**
 * Integration proof: a 429/503 response must actually trigger the SDK's real retry decorator
 * stack (`withRetry` wraps `MemoryClient["#rawRequest"]` directly, and `mapWireError` runs INSIDE
 * that function — see `../../src/client.ts` module docstring). Zero mocks: real `MemoryClient`,
 * real `fetch` transport, real TCP against the conformance server's `/test/flaky/{key}` route,
 * which fails the first `failTimes` requests for a given key server-side before succeeding.
 * Mirrors `mu-sdk-python/tests/integration/test_retry_conformance.py` test-for-test.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryClient } from "../../src/client.js";
import { RateLimitedError, ServiceUnavailableError } from "../../src/errors.js";
import { type SdkSettings, resolveSdkSettings } from "../../src/settings.js";
import { type ConformanceServer, startConformanceServer } from "./conformanceServer.js";

let server: ConformanceServer;

beforeAll(async () => {
  server = await startConformanceServer();
}, 20_000);

afterAll(async () => {
  await server.stop();
});

/** Short backoff so the test doesn't sleep for real multi-second backoff durations. `/test/flaky/*`
 * doesn't require auth, but `MemoryClient` still resolves an auth strategy eagerly, so a complete
 * identity is needed just to construct the client. */
function settings(): SdkSettings {
  return resolveSdkSettings({
    baseUrl: server.baseUrl,
    identity: { userId: "alice", workspaceId: "ws-1", namespaceId: "ns-1", sessionId: "session-1" },
    maxRetries: 3,
    backoffBaseS: 0.01,
    backoffMaxS: 0.05,
    timeoutS: 5.0,
  });
}

async function attemptsSeen(client: MemoryClient, key: string): Promise<number> {
  const response = await client._execute("GET", `/test/flaky/${key}/attempts`);
  const body = response.jsonBody as { attempts: number };
  return body.attempts;
}

describe("retry conformance (real Python server)", () => {
  it("retries a 503-then-200 to success", async () => {
    const client = new MemoryClient({ settings: settings() });
    try {
      const key = crypto.randomUUID();
      const response = await client._execute("GET", `/test/flaky/${key}`, {
        params: { fail_times: 2, status_code: 503 },
      });
      expect(response.statusCode).toBe(200);
      expect(response.jsonBody).toEqual({ attempts: 3 }); // 2 failures + the succeeding attempt

      // the server-side counter is ground truth that real retries actually fired, not just that
      // the call happened to succeed on the first try
      expect(await attemptsSeen(client, key)).toBe(3);
    } finally {
      await client.close();
    }
  });

  it("retries a 429-then-200 to success", async () => {
    const client = new MemoryClient({ settings: settings() });
    try {
      const key = crypto.randomUUID();
      const response = await client._execute("GET", `/test/flaky/${key}`, {
        params: { fail_times: 1, status_code: 429 },
      });
      expect(response.statusCode).toBe(200);
      expect(await attemptsSeen(client, key)).toBe(2);
    } finally {
      await client.close();
    }
  });

  it("exhausts retries on a persistent 503 and throws", async () => {
    // maxRetries=3 means 4 total attempts; a route that never recovers must still throw
    // ServiceUnavailableError after those are exhausted, proving the retry loop has a ceiling.
    const client = new MemoryClient({ settings: settings() });
    try {
      const key = crypto.randomUUID();
      let caught: unknown;
      try {
        await client._execute("GET", `/test/flaky/${key}`, {
          params: { fail_times: 999, status_code: 503 },
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ServiceUnavailableError);
      expect(await attemptsSeen(client, key)).toBe(4); // 1 initial + 3 retries, then gave up
    } finally {
      await client.close();
    }
  });

  it("exhausts retries on a persistent 429 and throws", async () => {
    const client = new MemoryClient({ settings: settings() });
    try {
      const key = crypto.randomUUID();
      let caught: unknown;
      try {
        await client._execute("GET", `/test/flaky/${key}`, {
          params: { fail_times: 999, status_code: 429 },
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(RateLimitedError);
      expect(await attemptsSeen(client, key)).toBe(4);
    } finally {
      await client.close();
    }
  });
});
