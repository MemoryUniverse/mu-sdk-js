/**
 * Integration: `FetchTransport` against REAL sockets (no conformance app needed here — a refused
 * connection, a real timeout, and a real AbortController cancellation are all genuine network/
 * runtime conditions, not mocks). Mirrors
 * `mu-sdk-python/tests/integration/test_transport_real_network.py` test-for-test, plus a
 * cancellation-via-AbortController case the brief calls out explicitly (JS has no
 * `asyncio.CancelledError` analogue — `AbortController` is the idiomatic equivalent).
 */
import net from "node:net";
import { describe, expect, it } from "vitest";
import { SdkTimeoutError, TransportError } from "../../src/errors.js";
import { resolveSdkSettings } from "../../src/settings.js";
import { FetchTransport } from "../../src/transport.js";

/** Binds and immediately releases a port so nothing is listening there — a real
 * connection-refused, not a simulated one. */
async function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((err) => {
        if (err) reject(err);
        else if (port === undefined) reject(new Error("could not determine an ephemeral port"));
        else resolve(port);
      });
    });
    server.on("error", reject);
  });
}

describe("FetchTransport against real sockets", () => {
  it("raises TransportError on a real connection-refused", async () => {
    const port = await closedPort();
    const settings = resolveSdkSettings({ baseUrl: `http://127.0.0.1:${port}`, timeoutS: 2.0 });
    const transport = new FetchTransport(settings);
    try {
      await expect(transport.request("GET", "/health/live")).rejects.toBeInstanceOf(TransportError);
    } finally {
      await transport.close();
    }
  });

  it("times out on a real unroutable address", async () => {
    // TEST-NET-1 (RFC 5737): reserved for documentation, guaranteed unroutable -> real timeout.
    const settings = resolveSdkSettings({ baseUrl: "http://192.0.2.1", timeoutS: 0.2 });
    const transport = new FetchTransport(settings);
    try {
      await expect(transport.request("GET", "/health/live")).rejects.toBeInstanceOf(
        SdkTimeoutError,
      );
    } finally {
      await transport.close();
    }
  });

  it("propagates a real caller-driven AbortController cancellation unconverted", async () => {
    // A generous SDK timeout (30s) so ONLY the caller's own abort can possibly fire first —
    // proves the signal a caller passes in is honored end-to-end through FetchTransport, and
    // that cancellation is never reinterpreted as SdkTimeoutError (the JS analogue of never
    // swallowing `asyncio.CancelledError`).
    const settings = resolveSdkSettings({ baseUrl: "http://192.0.2.1", timeoutS: 30.0 });
    const transport = new FetchTransport(settings);
    const controller = new AbortController();
    try {
      const requestPromise = transport.request("GET", "/health/live", {
        signal: controller.signal,
      });
      queueMicrotask(() => controller.abort());
      await expect(requestPromise).rejects.not.toBeInstanceOf(SdkTimeoutError);
      await expect(requestPromise).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      await transport.close();
    }
  });
});
