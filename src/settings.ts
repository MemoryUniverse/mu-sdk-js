/**
 * Central `SdkSettings` tree for the SDK — the ONE place config is read (DEV-STANDARDS rule 3:
 * "No hardcoding — anything... everything flows from the central config").
 *
 * Faithful mirror of `mu-sdk-python/src/mu_sdk/settings.py`. Precedence (highest wins): explicit
 * constructor overrides > `MU_*` environment variables > documented defaults — mirroring
 * `pydantic-settings`' resolution order. Env prefix `MU_` (nested via `__`), e.g. `MU_BASE_URL`,
 * `MU_API_KEY`, `MU_IDENTITY__USER_ID`, `MU_MAX_RETRIES`.
 *
 * `SdkSettings` objects are frozen (`Object.freeze`) after construction — the TS analogue of the
 * Python model's `frozen=True`.
 */

import { z } from "zod";

/**
 * The demo-auth identity quadruple (api-mcp-surface-spec.md §2.2: `X-Demo-User-Id`,
 * `X-Demo-Workspace-Id`, `X-Demo-Namespace-Id`, `X-Demo-Session-Id`). These are the
 * loopback-dev-only transport identity headers `DemoHeaderAuth` sends; the resolved namespace on
 * a request is ALWAYS derived server-side from these headers (or the bearer token's claims),
 * never accepted as a client-supplied body field.
 */
export const sdkIdentitySchema = z
  .object({
    userId: z.string().nullable().optional(),
    workspaceId: z.string().nullable().optional(),
    namespaceId: z.string().nullable().optional(),
    sessionId: z.string().nullable().optional(),
  })
  .strict();

export type SdkIdentity = z.infer<typeof sdkIdentitySchema>;

const emptyIdentity: SdkIdentity = {};

/** Port of `SdkIdentity.is_complete()` (Python) — a free function, TS objects have no methods. */
export function isIdentityComplete(identity: SdkIdentity): boolean {
  return Boolean(
    identity.userId && identity.workspaceId && identity.namespaceId && identity.sessionId,
  );
}

const sdkSettingsSchema = z
  .object({
    // -- transport --
    baseUrl: z.string().min(1).default("https://api.memory-universe.dev"),
    timeoutS: z.number().gt(0).default(30.0),
    connectTimeoutS: z.number().gt(0).nullable().optional(),

    // -- resilience (retry/backoff) --
    maxRetries: z.number().int().min(0).max(10).default(3),
    backoffBaseS: z.number().gt(0).default(0.5),
    backoffMaxS: z.number().gt(0).default(8.0),

    // -- auth --
    apiKey: z.string().nullable().optional(),
    identity: sdkIdentitySchema.default(emptyIdentity),

    // -- misc --
    userAgent: z.string().min(1).default("mu-sdk-js/0.1.0"),
    defaultPageLimit: z.number().int().min(1).max(100).default(10),
    // Independent from `defaultPageLimit`: `search()` is the simple ranked-list read (mem0
    // muscle-memory verb) while `recall()` is the richer multi-channel read — they are tuned
    // separately server-side, so the SDK gives each its own knob rather than coupling them.
    defaultRecallLimit: z.number().int().min(1).max(100).default(10),
  })
  .strict();

/** Raw constructor input — every field optional, mirroring `SdkSettings(**kwargs)`. */
export type SdkSettingsInput = z.input<typeof sdkSettingsSchema>;

export type SdkSettings = Readonly<z.infer<typeof sdkSettingsSchema>>;

const _ENV_PREFIX = "MU_";

function envString(name: string): string | undefined {
  const value = process.env[`${_ENV_PREFIX}${name}`];
  return value === undefined || value === "" ? undefined : value;
}

function envNumber(name: string): number | undefined {
  const raw = envString(name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Reads the `MU_*` / `MU_IDENTITY__*` environment variables into a partial settings shape. */
function readEnvSettings(): SdkSettingsInput {
  const identity: SdkIdentity = {
    userId: envString("IDENTITY__USER_ID"),
    workspaceId: envString("IDENTITY__WORKSPACE_ID"),
    namespaceId: envString("IDENTITY__NAMESPACE_ID"),
    sessionId: envString("IDENTITY__SESSION_ID"),
  };
  const hasIdentity = Object.values(identity).some((v) => v !== undefined);

  const env: SdkSettingsInput = {};
  const baseUrl = envString("BASE_URL");
  if (baseUrl !== undefined) env.baseUrl = baseUrl;
  const timeoutS = envNumber("TIMEOUT_S");
  if (timeoutS !== undefined) env.timeoutS = timeoutS;
  const connectTimeoutS = envNumber("CONNECT_TIMEOUT_S");
  if (connectTimeoutS !== undefined) env.connectTimeoutS = connectTimeoutS;
  const maxRetries = envNumber("MAX_RETRIES");
  if (maxRetries !== undefined) env.maxRetries = maxRetries;
  const backoffBaseS = envNumber("BACKOFF_BASE_S");
  if (backoffBaseS !== undefined) env.backoffBaseS = backoffBaseS;
  const backoffMaxS = envNumber("BACKOFF_MAX_S");
  if (backoffMaxS !== undefined) env.backoffMaxS = backoffMaxS;
  const apiKey = envString("API_KEY");
  if (apiKey !== undefined) env.apiKey = apiKey;
  const userAgent = envString("USER_AGENT");
  if (userAgent !== undefined) env.userAgent = userAgent;
  const defaultPageLimit = envNumber("DEFAULT_PAGE_LIMIT");
  if (defaultPageLimit !== undefined) env.defaultPageLimit = defaultPageLimit;
  const defaultRecallLimit = envNumber("DEFAULT_RECALL_LIMIT");
  if (defaultRecallLimit !== undefined) env.defaultRecallLimit = defaultRecallLimit;
  if (hasIdentity) env.identity = identity;
  return env;
}

/**
 * Resolves the effective `SdkSettings`: documented defaults <- `MU_*` env vars <- explicit
 * `overrides` (explicit constructor kwargs win, mirroring `pydantic-settings`' precedence: init
 * kwargs take priority over the environment). Throws a zod `ZodError` on an invalid/unknown field
 * (the runtime analogue of pydantic's `extra="forbid"` + bounds validation).
 */
export function resolveSdkSettings(overrides: SdkSettingsInput = {}): SdkSettings {
  const merged: SdkSettingsInput = {
    ...readEnvSettings(),
    ...overrides,
    identity: { ...readEnvSettings().identity, ...overrides.identity },
  };
  const parsed = sdkSettingsSchema.parse(merged);
  return Object.freeze({ ...parsed, identity: Object.freeze({ ...parsed.identity }) });
}
