/**
 * `SdkAuth` — the pluggable auth port (mu-local-and-sdk-spec.md §2.4).
 *
 * Faithful mirror of `mu-sdk-python/src/mu_sdk/auth.py`. Three adapters, one-to-one with the
 * server-side `AuthPort` adapters: `demo` | `bearer`, plus the SERVER-mode API-key credential.
 * `MemoryClient` resolves ONE of these at construction from `SdkSettings` — never hardcodes a
 * header literal outside this module.
 */

import { AuthenticationError } from "./errors.js";
import { type SdkIdentity, type SdkSettings, isIdentityComplete } from "./settings.js";

/** Produces the request headers attached to every call. */
export interface SdkAuth {
  headers(): Record<string, string>;
}

/**
 * DEFAULT for SERVER mode — an issued API key presented as a bearer credential
 * (mu-local-and-sdk-spec.md §2.4).
 */
export class ApiKeyAuth implements SdkAuth {
  readonly #key: string;

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new AuthenticationError("MU API key not provided.");
    }
    this.#key = apiKey;
  }

  headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.#key}` };
  }
}

/**
 * Interactive/user JWT (session tokens) — same header shape as `ApiKeyAuth`, different credential
 * source (mu-local-and-sdk-spec.md §2.4).
 */
export class BearerAuth implements SdkAuth {
  readonly #token: string;

  constructor(token: string) {
    if (!token) {
      throw new AuthenticationError("MU bearer token not provided.");
    }
    this.#token = token;
  }

  headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.#token}` };
  }
}

/**
 * Loopback-dev-ONLY transport identity headers (api-mcp-surface-spec.md §2.2:
 * `X-Demo-User-Id` / `X-Demo-Workspace-Id` / `X-Demo-Namespace-Id` / `X-Demo-Session-Id`).
 * `auth_mode="demo"` performs NO authentication server-side — this adapter exists to drive the
 * conformance server / a local dev `mu-server` instance, never a public bind.
 */
export class DemoHeaderAuth implements SdkAuth {
  readonly #userId: string;
  readonly #workspaceId: string;
  readonly #namespaceId: string;
  readonly #sessionId: string;

  constructor(identity: SdkIdentity) {
    if (!isIdentityComplete(identity)) {
      throw new AuthenticationError(
        "DemoHeaderAuth requires a complete identity " +
          "(userId, workspaceId, namespaceId, sessionId).",
      );
    }
    this.#userId = identity.userId as string;
    this.#workspaceId = identity.workspaceId as string;
    this.#namespaceId = identity.namespaceId as string;
    this.#sessionId = identity.sessionId as string;
  }

  headers(): Record<string, string> {
    return {
      "X-Demo-User-Id": this.#userId,
      "X-Demo-Workspace-Id": this.#workspaceId,
      "X-Demo-Namespace-Id": this.#namespaceId,
      "X-Demo-Session-Id": this.#sessionId,
    };
  }
}

/**
 * Default auth resolution: an API key wins (SERVER mode); otherwise a complete demo identity
 * (local/dev mode); otherwise fail loud at construction (DEV-STANDARDS rule 8).
 */
export function resolveAuth(settings: SdkSettings): SdkAuth {
  if (settings.apiKey) {
    return new ApiKeyAuth(settings.apiKey);
  }
  if (isIdentityComplete(settings.identity)) {
    return new DemoHeaderAuth(settings.identity);
  }
  throw new AuthenticationError(
    "No credentials configured: set `apiKey` (SERVER mode) or a complete " +
      "`identity` (local/dev demo mode) on SdkSettings.",
  );
}
