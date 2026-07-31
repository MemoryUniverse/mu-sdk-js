/**
 * Pure-unit: `./config.ts`'s plane-gating port (`validatePlaneFields`/`planeConfigFor`) and the
 * token auto-load (`loadEngineServerAuth`/`resolveTokenPath`) — real filesystem (`node:fs`
 * `mkdtempSync`/`writeFileSync`, never mocked), no network. Mirrors the coverage a Python
 * `mu_contracts.validation.plane_gate`/`mu_engine_server.auth.load_token` unit suite would give
 * their own counterparts.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_TOKEN_PATH,
  TOKEN_PATH_ENV_VAR,
  loadEngineServerAuth,
  planeConfigFor,
  resolveTokenPath,
  validatePlaneFields,
} from "../../src/config.js";
import { EngineServerTokenNotFoundError, PlaneFieldRejectedError } from "../../src/errors.js";

describe("planeConfigFor", () => {
  it("legacy (mode=undefined) construction is unconditionally shared-plane, never private", () => {
    expect(planeConfigFor(undefined, undefined)).toEqual({
      privateConfigured: false,
      sharedConfigured: true,
    });
  });

  it("mode=embedded is private-plane-configured, shared-plane-NOT (no shared=)", () => {
    expect(planeConfigFor("embedded", undefined)).toEqual({
      privateConfigured: true,
      sharedConfigured: false,
    });
  });

  it("mode=local_server is private-plane-configured, shared-plane-NOT by default", () => {
    expect(planeConfigFor("local_server", undefined)).toEqual({
      privateConfigured: true,
      sharedConfigured: false,
    });
  });

  it("mode=local_server + populated shared= is DUAL-plane", () => {
    expect(
      planeConfigFor("local_server", { endpoint: "http://x", auth: { headers: () => ({}) } }),
    ).toEqual({ privateConfigured: true, sharedConfigured: true });
  });

  it("mode=remote is shared-plane-configured, private-plane-NOT", () => {
    expect(planeConfigFor("remote", undefined)).toEqual({
      privateConfigured: false,
      sharedConfigured: true,
    });
  });
});

describe("validatePlaneFields", () => {
  it("undefined/null fields never trigger a rejection, regardless of plane configuration", () => {
    expect(() =>
      validatePlaneFields(
        { user: undefined, visibility: null },
        { privateConfigured: false, sharedConfigured: false },
      ),
    ).not.toThrow();
  });

  it("a supplied private-plane field is rejected when private is not configured", () => {
    expect(() =>
      validatePlaneFields({ user: "ada" }, { privateConfigured: false, sharedConfigured: true }),
    ).toThrow(PlaneFieldRejectedError);
  });

  it("a supplied shared-plane field is rejected when shared is not configured", () => {
    expect(() =>
      validatePlaneFields(
        { visibility: "shared" },
        { privateConfigured: true, sharedConfigured: false },
      ),
    ).toThrow(PlaneFieldRejectedError);
  });

  it("the rejection carries field/plane/reason", () => {
    try {
      validatePlaneFields({ session: "s1" }, { privateConfigured: false, sharedConfigured: true });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PlaneFieldRejectedError);
      const rejected = error as PlaneFieldRejectedError;
      expect(rejected.field).toBe("session");
      expect(rejected.plane).toBe("private");
    }
  });

  it("a supplied field passes through untouched when its plane IS configured", () => {
    expect(() =>
      validatePlaneFields(
        { user: "ada", visibility: "shared" },
        { privateConfigured: true, sharedConfigured: true },
      ),
    ).not.toThrow();
  });

  it("a field name in neither PRIVATE_PLANE_FIELDS nor SHARED_PLANE_FIELDS is never gated", () => {
    expect(() =>
      validatePlaneFields(
        { tier: "stm", metadata: { k: "v" } },
        { privateConfigured: false, sharedConfigured: false },
      ),
    ).not.toThrow();
  });
});

describe("resolveTokenPath", () => {
  const originalEnv = process.env[TOKEN_PATH_ENV_VAR];

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[TOKEN_PATH_ENV_VAR];
    } else {
      process.env[TOKEN_PATH_ENV_VAR] = originalEnv;
    }
  });

  it("explicit arg wins over env", () => {
    process.env[TOKEN_PATH_ENV_VAR] = "/env/path";
    expect(resolveTokenPath("/explicit/path")).toBe("/explicit/path");
  });

  it("env wins over the default when no explicit arg is given", () => {
    process.env[TOKEN_PATH_ENV_VAR] = "/env/path";
    expect(resolveTokenPath()).toBe("/env/path");
  });

  it("falls back to the documented default (~/.memory-universe/engine-server.token)", () => {
    delete process.env[TOKEN_PATH_ENV_VAR];
    expect(resolveTokenPath()).toBe(DEFAULT_TOKEN_PATH);
  });
});

describe("loadEngineServerAuth", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "mu-sdk-js-token-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads a real token file and produces a BearerAuth sending it as Authorization", () => {
    const tokenPath = path.join(dir, "engine-server.token");
    writeFileSync(tokenPath, "  s3cr3t-token  \n", { mode: 0o600 });

    const auth = loadEngineServerAuth(tokenPath);

    expect(auth.headers()).toEqual({ Authorization: "Bearer s3cr3t-token" });
  });

  it("throws EngineServerTokenNotFoundError when the file does not exist", () => {
    const missing = path.join(dir, "never-written");
    expect(() => loadEngineServerAuth(missing)).toThrow(EngineServerTokenNotFoundError);
  });

  it("throws EngineServerTokenNotFoundError when the file is blank", () => {
    const tokenPath = path.join(dir, "blank-token");
    writeFileSync(tokenPath, "   \n", { mode: 0o600 });
    expect(() => loadEngineServerAuth(tokenPath)).toThrow(EngineServerTokenNotFoundError);
  });
});
