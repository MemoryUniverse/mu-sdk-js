/**
 * Pure-unit: `resolveSdkSettings` env-var loading (`MU_` prefix, `__` nesting). No I/O beyond
 * reading process-scoped environment variables. Mirrors
 * `mu-sdk-python/tests/unit/test_settings.py` test-for-test.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isIdentityComplete, resolveSdkSettings } from "../../src/settings.js";

const MU_ENV_KEYS = [
  "MU_BASE_URL",
  "MU_API_KEY",
  "MU_TIMEOUT_S",
  "MU_MAX_RETRIES",
  "MU_DEFAULT_PAGE_LIMIT",
  "MU_DEFAULT_RECALL_LIMIT",
  "MU_IDENTITY__USER_ID",
  "MU_IDENTITY__WORKSPACE_ID",
  "MU_IDENTITY__NAMESPACE_ID",
  "MU_IDENTITY__SESSION_ID",
];

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(MU_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of MU_ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of MU_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("resolveSdkSettings", () => {
  it("defaults require no environment", () => {
    const settings = resolveSdkSettings();
    expect(settings.baseUrl).toBe("https://api.memory-universe.dev");
    expect(settings.timeoutS).toBe(30.0);
    expect(settings.maxRetries).toBe(3);
    expect(settings.apiKey ?? null).toBeNull();
    expect(isIdentityComplete(settings.identity)).toBe(false);
    expect(settings.defaultPageLimit).toBe(10);
    expect(settings.defaultRecallLimit).toBe(10);
  });

  it("makes defaultRecallLimit independently configurable from defaultPageLimit", () => {
    const settings = resolveSdkSettings({ defaultPageLimit: 25, defaultRecallLimit: 40 });
    expect(settings.defaultPageLimit).toBe(25);
    expect(settings.defaultRecallLimit).toBe(40);
  });

  it.each([0, 101])("bounds defaultRecallLimit (rejects %i)", (badLimit) => {
    expect(() => resolveSdkSettings({ defaultRecallLimit: badLimit })).toThrow();
  });

  it("reads baseUrl and apiKey from the environment", () => {
    process.env.MU_BASE_URL = "http://127.0.0.1:9999";
    process.env.MU_API_KEY = "mu_live_from_env";
    const settings = resolveSdkSettings();
    expect(settings.baseUrl).toBe("http://127.0.0.1:9999");
    expect(settings.apiKey).toBe("mu_live_from_env");
  });

  it("reads a nested identity from the environment", () => {
    process.env.MU_IDENTITY__USER_ID = "alice";
    process.env.MU_IDENTITY__WORKSPACE_ID = "ws-1";
    process.env.MU_IDENTITY__NAMESPACE_ID = "ns-1";
    process.env.MU_IDENTITY__SESSION_ID = "sess-1";
    const settings = resolveSdkSettings();
    expect(isIdentityComplete(settings.identity)).toBe(true);
    expect(settings.identity.userId).toBe("alice");
  });

  it("rejects an unknown field passed explicitly", () => {
    expect(() => resolveSdkSettings({ totallyUnknownField: "x" } as never)).toThrow();
  });

  it.each([0, -1.0])("requires timeoutS to be positive (rejects %d)", (badTimeout) => {
    expect(() => resolveSdkSettings({ timeoutS: badTimeout })).toThrow();
  });

  it("returns a frozen settings object (readonly, TS analogue of pydantic frozen=True)", () => {
    const settings = resolveSdkSettings();
    expect(Object.isFrozen(settings)).toBe(true);
    expect(Object.isFrozen(settings.identity)).toBe(true);
  });

  it("lets explicit constructor overrides win over the environment", () => {
    process.env.MU_BASE_URL = "http://from-env.example";
    const settings = resolveSdkSettings({ baseUrl: "http://from-override.example" });
    expect(settings.baseUrl).toBe("http://from-override.example");
  });
});
