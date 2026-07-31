/**
 * `SdkConfig` — the ONE config object that picks the transport (design §3/§4, build-plan Stage D
 * item D2). TS twin of `mu-sdk-python`'s (not-yet-landed, D1, parallel) `mu_sdk.config.SdkConfig` —
 * **identical field set MINUS `storage`/`embedder`/`model`** (design §3's TS sample: "JS never owns
 * stores directly; storage config is set on the `mu-engine-server` container's own config, not
 * passed from the JS caller").
 *
 * **JS is server-only (design §1.3).** `mode: "embedded"` is REJECTED at `MemoryClient`
 * construction (`UnsupportedModeError`, `./errors.ts`) — see `../client.ts`'s constructor, not this
 * module (this module only declares the config SHAPE; the mode-embedded-is-an-error RULE lives at
 * the one place a `SdkConfig` actually gets consumed). `local_server`/`remote` differ ONLY in
 * `endpoint`+`auth` — never in code path (design §1.2) — both are plain wire clients from this
 * module's point of view.
 *
 * **Token auto-load (design §1.2 FIX 4).** `mode="local_server"` with no explicit `auth=` reads the
 * per-process bearer token `make up` mints to `~/.memory-universe/engine-server.token` (mode 0600,
 * the SAME file `mu_engine_server.auth.DEFAULT_TOKEN_PATH`/`get_token_path` resolve server-side,
 * `mu-core/packages/mu-engine-server/src/mu_engine_server/auth.py:65-81`) — this module's
 * `loadEngineServerAuth` is the CLIENT-side read of that same contract (Node `fs`, synchronous,
 * mirroring `load_token`'s strip-and-reject-blank behaviour); an absent/blank token file surfaces
 * the NAMED `EngineServerTokenNotFoundError`, never a bare `ENOENT`.
 *
 * **Plane-gating (design §2.5).** `PRIVATE_PLANE_FIELDS`/`SHARED_PLANE_FIELDS`/
 * `validatePlaneFields`/`planeConfigFor` below are a faithful TS PORT (never an import — this SDK
 * has no dependency on any Python package) of `mu_contracts.validation.plane_gate` — the SAME rule
 * `LocalMemory` (mu-local) and `MemoryClient` (mu-sdk-python) enforce, reimplemented here so
 * `../client.ts`'s net-new `get`/`buildContext`/`share` can apply the identical "a field supplied
 * for a plane that isn't configured is a REJECTION, not a silent no-op" discipline.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { SdkAuth } from "./auth.js";
import { BearerAuth } from "./auth.js";
import { EngineServerTokenNotFoundError, PlaneFieldRejectedError } from "./errors.js";

/** design §1.2's transport-adapter triad. JS only ever legitimately CONSTRUCTS a client with
 * `"local_server"`/`"remote"` — `"embedded"` is still a valid VALUE of this type (so a caller can
 * pass it and get the documented `UnsupportedModeError`, rather than a type error hiding the
 * intended fail-loud behaviour behind a compile error) but `MemoryClient` always rejects it. */
export type SdkMode = "embedded" | "local_server" | "remote";

/** design §3's `manager_mode` field — mirrors `mu_engine.lifecycle.mode_gate.ManagerMode`
 * (`MANUAL`/`MANAGED`/`HYBRID`, ported as lowercase string-enum values matching that `StrEnum`'s
 * own wire values). A client-level ROUTING HINT only (design §3 table: "the SDK/client carry
 * `manager_mode` as a routing hint on the wire; the ENGINE enforces"), not itself an authorization
 * decision. */
export type ManagerMode = "manual" | "managed" | "hybrid";

/**
 * Pass-through knobs mirroring `mu_engine.lifecycle.settings.LifecycleSettings` (Python,
 * `mu-core/packages/mu-engine/src/mu_engine/lifecycle/settings.py:114`) — config-SURFACE parity
 * with `SdkConfig` (design §3: "tier/salience knobs — pass-through to `LifecycleSettings`"), not
 * yet threaded into any request this SDK sends (no `mu-engine-server` route accepts a
 * caller-supplied lifecycle tree today — those knobs live server-side, in
 * `EngineServerSettings`/env). Named fields cover the ones design §3's own field table calls out;
 * an index signature keeps this open rather than a false claim of exhaustiveness over the MLM's
 * full tuning surface, since nothing here does anything yet on the JS side.
 */
export interface LifecycleSettings {
  enabled?: boolean;
  maintenanceIntervalS?: number;
  fullScanIntervalS?: number;
  batchSize?: number;
  sessionIdleS?: number;
  maxUsersPerSweep?: number;
  maxItemsPerUserSweep?: number;
  [key: string]: unknown;
}

/**
 * The shared (mu-server, remote) plane's own endpoint + auth, nested rather than a second set of
 * top-level `remote*` scalars (design §3/§4 MAJOR 4/MINOR 5 fix). Populating this on top of a
 * `mode="embedded"`/`"local_server"` construction is what makes a client DUAL-PLANE (design §4);
 * JS never constructs `mode="embedded"` (§1.3), so in practice this only ever layers onto
 * `mode="local_server"` here.
 */
export interface SharedPlaneConfig {
  endpoint: string;
  auth: SdkAuth;
}

/**
 * TS twin of `mu_sdk.config.SdkConfig` (Python, design §3) — identical field set MINUS
 * `storage`/`embedder`/`model` (module docstring: JS never owns stores). `mode` is always the
 * PRIVATE/local-plane transport choice (or `"remote"` for shared-plane-only); dual-plane is
 * expressed by ALSO populating `shared`, never a tuple on `mode` (design §4's corrected shape).
 */
export interface SdkConfig {
  mode: SdkMode;
  /** Required for `local_server`/`remote`; ignored for `embedded` (itself always rejected, §1.3). */
  endpoint?: string;
  shared?: SharedPlaneConfig;
  managerMode?: ManagerMode;
  lifecycle?: LifecycleSettings;
  timeoutS?: number;
  namespace?: string;
  workspace?: string;
  auth?: SdkAuth;
  /** JS-specific escape hatch (not in the Python field table — Node needs a way to point the
   * `local_server` token auto-load at a non-default path without an env var): overrides where
   * `loadEngineServerAuth` reads the bearer token from when `mode="local_server"` and no explicit
   * `auth=` is given. */
  tokenPath?: string;
}

// ── plane-gating (design §2.5; PORT of mu_contracts.validation.plane_gate, not an import) ───────

/** design §2.5 canonical `add` superset signature — the private-plane-gated field names. */
export const PRIVATE_PLANE_FIELDS: ReadonlySet<string> = new Set(["user", "session", "agent"]);

/** design §2.5 canonical `add` superset signature — the shared-plane-gated field names. */
export const SHARED_PLANE_FIELDS: ReadonlySet<string> = new Set([
  "visibility",
  "subject",
  "predicate",
  "object",
]);

/**
 * Reject any supplied field whose plane is not configured (design §2.5). `undefined`/`null` is
 * read as "not supplied" (mirrors Python's `value is None` check) — every plane-gated field on this
 * SDK's net-new verbs defaults to `undefined`. Throws on the FIRST offending field, in
 * `Object.entries` iteration order (mirrors Python dict insertion-order iteration) — "a rejection,
 * not an exhaustive multi-field report" (design §2.5).
 */
export function validatePlaneFields(
  fields: Record<string, unknown>,
  options: { privateConfigured: boolean; sharedConfigured: boolean },
): void {
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (SHARED_PLANE_FIELDS.has(name) && !options.sharedConfigured) {
      throw new PlaneFieldRejectedError(name, {
        plane: "shared",
        reason: "no shared plane is configured",
      });
    }
    if (PRIVATE_PLANE_FIELDS.has(name) && !options.privateConfigured) {
      throw new PlaneFieldRejectedError(name, {
        plane: "private",
        reason: "only a shared plane is configured",
      });
    }
  }
}

/**
 * Resolves `{ privateConfigured, sharedConfigured }` from a `SdkConfig`'s `mode`/`shared` — the
 * SAME resolution design §4's worked example describes: `private_configured = mode in
 * ("embedded", "local_server")`, `shared_configured = (mode == "remote") or (shared is not None)`.
 * `mode` is optional here purely so `../client.ts`'s LEGACY (pre-Stage-D, `settings`/`transport`-
 * only) construction path can call this with `undefined` and get back `{ privateConfigured: false,
 * sharedConfigured: true }` — that class's own pre-Stage-D interim ruling (unconditionally
 * shared-plane, mirroring `mu_sdk.client`'s `_PRIVATE_PLANE_CONFIGURED`/`_SHARED_PLANE_CONFIGURED`
 * module constants), preserved for backward compatibility rather than silently changed by this
 * addition.
 */
export function planeConfigFor(
  mode: SdkMode | undefined,
  shared: SharedPlaneConfig | undefined,
): { privateConfigured: boolean; sharedConfigured: boolean } {
  if (mode === undefined) {
    return { privateConfigured: false, sharedConfigured: true };
  }
  return {
    privateConfigured: mode === "embedded" || mode === "local_server",
    sharedConfigured: mode === "remote" || shared !== undefined,
  };
}

// ── token auto-load (design §1.2 FIX 4) ──────────────────────────────────────────────────────────

/** Same default path `mu_engine_server.auth.DEFAULT_TOKEN_PATH` resolves server-side. */
export const DEFAULT_TOKEN_PATH: string = path.join(
  homedir(),
  ".memory-universe",
  "engine-server.token",
);

/** Same env var name `mu_engine_server.auth.TOKEN_PATH_ENV_VAR` uses server-side — read here
 * CLIENT-side so a developer who points the server at a non-default token path via this env var
 * gets the SDK auto-loading from the same place, with zero extra config. */
export const TOKEN_PATH_ENV_VAR = "MU_ENGINE_SERVER_TOKEN_PATH";

/** Resolution order: explicit arg > `MU_ENGINE_SERVER_TOKEN_PATH` env > default
 * (`~/.memory-universe/engine-server.token`) — mirrors `mu_engine_server.auth.get_token_path`. */
export function resolveTokenPath(explicit?: string): string {
  if (explicit) return explicit;
  const envOverride = process.env[TOKEN_PATH_ENV_VAR];
  if (envOverride) return envOverride;
  return DEFAULT_TOKEN_PATH;
}

/**
 * Reads and returns the per-process bearer token from disk, wrapped in a `BearerAuth`
 * (`./auth.ts`). Throws `EngineServerTokenNotFoundError` if the file is missing, unreadable, or
 * blank — a verifier with nothing to compare against can never succeed server-side either, so this
 * fails loud at load time (DEV-STANDARDS rule 8), mirroring `mu_engine_server.auth.load_token`'s
 * own "fail loud... rather than deferring to (and disguising itself inside) the first request's
 * 401" reasoning, from the CLIENT side.
 */
export function loadEngineServerAuth(tokenPath?: string): SdkAuth {
  const resolvedPath = resolveTokenPath(tokenPath);
  let raw: string;
  try {
    raw = readFileSync(resolvedPath, "utf8");
  } catch (error) {
    throw new EngineServerTokenNotFoundError(
      `engine-server token file not found or unreadable: ${resolvedPath} (${String(error)})`,
    );
  }
  const token = raw.trim();
  if (!token) {
    throw new EngineServerTokenNotFoundError(`engine-server token file is empty: ${resolvedPath}`);
  }
  return new BearerAuth(token);
}
