/**
 * Pure-unit: `mapWireError` status-code -> typed-exception mapping table
 * (api-mcp-surface-spec.md §2.4/§8). No I/O — `TransportResponse` is constructed directly.
 * Mirrors `mu-sdk-python/tests/unit/test_error_mapping.py` test-for-test.
 */
import { describe, expect, it } from "vitest";
import { mapWireError } from "../../src/errorMapping.js";
import {
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  NotFoundError,
  PrivateDataRejectedError,
  type RateLimitedError,
  ServerError,
  type ServiceUnavailableError,
  UnexpectedResponseError,
  ValidationError,
} from "../../src/errors.js";
import { TransportResponse } from "../../src/transport.js";

function response(
  statusCode: number,
  body: Record<string, unknown> | null = null,
): TransportResponse {
  return new TransportResponse(
    statusCode,
    { "X-Request-ID": "req-123" },
    body ?? { detail: "boom", request_id: "req-123" },
  );
}

describe("mapWireError", () => {
  it.each([
    [401, AuthenticationError],
    [403, AuthorizationError],
    [404, NotFoundError],
    [409, ConflictError],
    [422, ValidationError],
    [500, ServerError],
    [502, ServerError],
    [599, ServerError],
    [300, UnexpectedResponseError],
    [600, UnexpectedResponseError],
  ])("maps status %i to %s", (statusCode, expectedType) => {
    try {
      mapWireError(response(statusCode as number));
      throw new Error("expected mapWireError to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(expectedType);
      expect((error as { statusCode?: number }).statusCode).toBe(statusCode);
      expect((error as { requestId?: string }).requestId).toBe("req-123");
    }
  });

  it("does not throw on 2xx", () => {
    expect(() => mapWireError(response(200))).not.toThrow();
    expect(() => mapWireError(response(201))).not.toThrow();
    expect(() => mapWireError(response(204))).not.toThrow();
  });

  it("raises the specific PrivateDataRejectedError subclass on 403 + the mcp code", () => {
    expect(() =>
      mapWireError(response(403, { detail: "no", request_id: "r", code: "private_data_rejected" })),
    ).toThrow(PrivateDataRejectedError);
  });

  it("raises a generic AuthorizationError on 403 without the code", () => {
    try {
      mapWireError(response(403, { detail: "no", request_id: "r" }));
      throw new Error("expected mapWireError to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error).not.toBeInstanceOf(PrivateDataRejectedError);
    }
  });

  it("extracts Retry-After on 429", () => {
    const res = new TransportResponse(
      429,
      { "Retry-After": "2.5" },
      { detail: "slow down", request_id: "r" },
    );
    try {
      mapWireError(res);
      throw new Error("expected mapWireError to throw");
    } catch (error) {
      expect((error as RateLimitedError).retryAfterS).toBeCloseTo(2.5);
    }
  });

  it("extracts Retry-After on 503", () => {
    const res = new TransportResponse(
      503,
      { "Retry-After": "1" },
      { detail: "unavailable", request_id: "r" },
    );
    try {
      mapWireError(res);
      throw new Error("expected mapWireError to throw");
    } catch (error) {
      expect((error as ServiceUnavailableError).retryAfterS).toBeCloseTo(1.0);
    }
  });

  it("falls back to raw text on a malformed body and never crashes", () => {
    const res = new TransportResponse(500, {}, null, "oops");
    try {
      mapWireError(res);
      throw new Error("expected mapWireError to throw");
    } catch (error) {
      expect((error as ServerError).message).toContain("oops");
    }
  });
});
