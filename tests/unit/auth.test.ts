/**
 * Pure-unit: `SdkAuth` adapters + `resolveAuth` precedence. No I/O. Mirrors
 * `mu-sdk-python/tests/unit/test_auth.py` test-for-test.
 */
import { describe, expect, it } from "vitest";
import { ApiKeyAuth, BearerAuth, DemoHeaderAuth, resolveAuth } from "../../src/auth.js";
import { AuthenticationError } from "../../src/errors.js";
import { resolveSdkSettings } from "../../src/settings.js";

describe("ApiKeyAuth", () => {
  it("produces a bearer header", () => {
    const auth = new ApiKeyAuth("mu_live_abc123");
    expect(auth.headers()).toEqual({ Authorization: "Bearer mu_live_abc123" });
  });

  it("rejects an empty key", () => {
    expect(() => new ApiKeyAuth("")).toThrow(AuthenticationError);
  });
});

describe("BearerAuth", () => {
  it("produces a bearer header", () => {
    const auth = new BearerAuth("session-jwt");
    expect(auth.headers()).toEqual({ Authorization: "Bearer session-jwt" });
  });
});

describe("DemoHeaderAuth", () => {
  it("produces all four identity headers", () => {
    const auth = new DemoHeaderAuth({
      userId: "alice",
      workspaceId: "ws-1",
      namespaceId: "ns-1",
      sessionId: "sess-1",
    });
    expect(auth.headers()).toEqual({
      "X-Demo-User-Id": "alice",
      "X-Demo-Workspace-Id": "ws-1",
      "X-Demo-Namespace-Id": "ns-1",
      "X-Demo-Session-Id": "sess-1",
    });
  });

  it("rejects an incomplete identity", () => {
    expect(
      () =>
        new DemoHeaderAuth({
          userId: "alice",
          workspaceId: "ws-1",
          namespaceId: null,
          sessionId: null,
        }),
    ).toThrow(AuthenticationError);
  });
});

describe("resolveAuth", () => {
  it("prefers an apiKey over a demo identity", () => {
    const settings = resolveSdkSettings({
      apiKey: "mu_live_abc",
      identity: { userId: "alice", workspaceId: "ws-1", namespaceId: "ns-1", sessionId: "sess-1" },
    });
    expect(resolveAuth(settings)).toBeInstanceOf(ApiKeyAuth);
  });

  it("falls back to a demo identity", () => {
    const settings = resolveSdkSettings({
      identity: { userId: "alice", workspaceId: "ws-1", namespaceId: "ns-1", sessionId: "sess-1" },
    });
    expect(resolveAuth(settings)).toBeInstanceOf(DemoHeaderAuth);
  });

  it("raises when nothing is configured", () => {
    expect(() => resolveAuth(resolveSdkSettings())).toThrow(AuthenticationError);
  });
});
