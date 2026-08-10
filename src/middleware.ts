/**
 * Optional, opt-in auto-inject / auto-capture middleware (AGENT-INTEGRATION-AUDIT-AND-PLAN §4
 * Phase 5) — the "mem0-style middleware at the SDK layer" for agents that EMBED the SDK rather than
 * run `claude`/`codex` capture hooks. Faithful mirror of `mu-sdk-python/src/mu_sdk/middleware.py`.
 *
 * **What it is.** A THIN, framework-agnostic wrapper an application puts around its own outbound LLM
 * call so that — WITHOUT the app ever calling `add`/`recall`/`buildContext` explicitly — the SDK:
 *
 * - **before** the LLM call: recalls the relevant prior context for the `(user, session)` and
 *   prepends the rendered window to the prompt (`MemoryClient#buildContext` by default, or
 *   `MemoryClient#recall` when `injectMode="recall"`);
 * - **after** the LLM call: captures the user turn and the assistant turn back into the store
 *   (`MemoryClient#add`).
 *
 * **What it is NOT.** It adds NO new memory logic and NO new wire calls — every before/after step is
 * one of `MemoryClient`'s OWN canonical verbs (`buildContext`/`recall`/`add`), which already run over
 * the REAL transport the client was constructed with (`mode="local_server"` over HTTP to a real
 * `mu-engine-server`; JS has no embedded engine — design §1.3). This module holds no store, embedder,
 * or engine — it only ORCHESTRATES the client's existing verbs.
 *
 * **Opt-in by construction.** Nothing here auto-wires into `MemoryClient`'s core verbs — a plain
 * `MemoryClient` is completely unchanged. An app opts in by constructing a `MemoryMiddleware` around
 * its client and routing its LLM call through `run(...)` (or the `wrap(...)` decorator). `inject`/
 * `capture` are independent on/off switches, so an app can enable only auto-inject, only
 * auto-capture, or both.
 *
 * **Framework-agnostic.** The wrapper operates on a plain `string` prompt and a caller-supplied
 * `LlmCall` returning `string | Promise<string>` — nothing about a specific agent framework leaks in.
 * A caller whose framework speaks in message lists renders them to/from a string at its own boundary
 * (or supplies a custom `render`).
 *
 * Cancellation-safety note: this layer adds no `try/catch` around the client verbs or the caller's
 * `LlmCall`, so an `AbortError` from a threaded `AbortSignal` (were one added) would propagate
 * untouched — consistent with the SDK's cancellation discipline (`./decorators.ts`).
 */

import type { MemoryClient } from "./client.js";

/**
 * How relevant memory is fetched before the LLM call:
 * - `"context"` — `MemoryClient#buildContext` (a deterministically-rendered context WINDOW, the
 *   default; the whole window's `text` is injected verbatim).
 * - `"recall"` — `MemoryClient#recall` (the ranked multi-channel read; each hit's `content` is
 *   joined into a bullet list before injection).
 */
export type InjectMode = "context" | "recall";

/** The app's own outbound LLM call. Takes the (possibly memory-augmented) prompt, returns the
 * assistant text — SYNC (`string`) or ASYNC (`Promise<string>`) are both accepted. */
export type LlmCall = (prompt: string) => string | Promise<string>;

/** Per-call tenancy override — wins over the config defaults for that one turn. */
export interface TurnTenancy {
  user?: string;
  session?: string;
}

/** The default injection template — prepend the recalled context as a clearly-labelled block above
 * the original prompt. Overridable via `MiddlewareConfig.render`. */
export function defaultRender(contextText: string, prompt: string): string {
  return `Relevant memory from earlier:\n${contextText}\n\n${prompt}`;
}

/**
 * The opt-in knobs. Every field is optional; unset fields fall back to the documented defaults
 * (`resolveConfig`). `user`/`session` set here are the DEFAULT tenancy for every turn; a per-call
 * `{ user, session }` overrides them (so one middleware instance can serve many `(user, session)`
 * pairs).
 */
export interface MiddlewareConfig {
  user?: string;
  session?: string;
  /** Master switch for the BEFORE step. `false` -> `before()` returns the prompt untouched and the
   * client is never contacted for a read. Default `true`. */
  inject?: boolean;
  /** Master switch for the AFTER step. `false` -> `after()` is a no-op. Default `true`. */
  capture?: boolean;
  /** `"context"` (default) or `"recall"` — see `InjectMode`. */
  injectMode?: InjectMode;
  injectLimit?: number;
  injectMaxChars?: number;
  /** Capture the user's ORIGINAL prompt (never the augmented one — see `run()`). Default `true`. */
  captureUser?: boolean;
  /** Capture the assistant's returned turn. Default `true`. */
  captureAssistant?: boolean;
  /** `(contextText, originalPrompt) -> augmentedPrompt`. Called only when there is non-empty context
   * to inject; an empty store leaves the original prompt unchanged. Default `defaultRender`. */
  render?: (contextText: string, prompt: string) => string;
}

interface ResolvedConfig {
  user: string | undefined;
  session: string | undefined;
  inject: boolean;
  capture: boolean;
  injectMode: InjectMode;
  injectLimit: number;
  injectMaxChars: number | undefined;
  captureUser: boolean;
  captureAssistant: boolean;
  render: (contextText: string, prompt: string) => string;
}

const DEFAULT_INJECT_LIMIT = 10;

function resolveConfig(config: MiddlewareConfig): ResolvedConfig {
  return {
    user: config.user,
    session: config.session,
    inject: config.inject ?? true,
    capture: config.capture ?? true,
    injectMode: config.injectMode ?? "context",
    injectLimit: config.injectLimit ?? DEFAULT_INJECT_LIMIT,
    injectMaxChars: config.injectMaxChars,
    captureUser: config.captureUser ?? true,
    captureAssistant: config.captureAssistant ?? true,
    render: config.render ?? defaultRender,
  };
}

/**
 * Wraps a REAL `MemoryClient` with the before/after auto-memory behavior (module docstring).
 *
 * Typical use:
 * ```ts
 * const mw = new MemoryMiddleware(client, { user: "ada", session: "s1" });
 * const answer = await mw.run(userPrompt, myLlmCall);   // inject -> llm -> capture
 * ```
 * or as a decorator over the app's LLM function:
 * ```ts
 * const chat = mw.wrap(myLlmCall);
 * const answer = await chat(userPrompt);                // same, per-call { user, session } allowed
 * ```
 * Every store interaction is delegated to `client`'s own verbs — this class constructs/closes
 * nothing itself (the client's lifecycle stays the caller's).
 */
export class MemoryMiddleware {
  readonly #client: MemoryClient;
  readonly #config: ResolvedConfig;

  constructor(client: MemoryClient, config: MiddlewareConfig = {}) {
    this.#client = client;
    this.#config = resolveConfig(config);
  }

  get client(): MemoryClient {
    return this.#client;
  }

  /** Per-call `{ user, session }` win over the config defaults; either falls back to the config
   * value (which itself may be `undefined`, letting the client apply its own default). */
  #resolveTenancy(tenancy: TurnTenancy): { user: string | undefined; session: string | undefined } {
    return {
      user: tenancy.user ?? this.#config.user,
      session: tenancy.session ?? this.#config.session,
    };
  }

  /** Read the relevant prior context for `(user, session)` and render it to a single string.
   * Returns `""` when injection is disabled or the store has nothing. */
  async fetchContext(prompt: string, tenancy: TurnTenancy = {}): Promise<string> {
    if (!this.#config.inject) return "";
    const { user, session } = this.#resolveTenancy(tenancy);
    if (this.#config.injectMode === "context") {
      const view = await this.#client.buildContext(prompt, {
        user,
        session,
        limit: this.#config.injectLimit,
        ...(this.#config.injectMaxChars !== undefined
          ? { maxChars: this.#config.injectMaxChars }
          : {}),
      });
      return view.text;
    }
    const result = await this.#client.recall(prompt, {
      user,
      session,
      limit: this.#config.injectLimit,
    });
    return result.items.map((item) => `- ${item.content}`).join("\n");
  }

  /** The BEFORE step: return `prompt` with the recalled context prepended via `config.render`, or
   * `prompt` UNCHANGED when injection is off / the store is empty. */
  async before(prompt: string, tenancy: TurnTenancy = {}): Promise<string> {
    const contextText = await this.fetchContext(prompt, tenancy);
    if (contextText.trim() === "") return prompt;
    return this.#config.render(contextText, prompt);
  }

  /** The AFTER step: capture the user turn and/or the assistant turn (per the `captureUser`/
   * `captureAssistant` switches). A no-op when capture is disabled; empty strings are skipped. */
  async after(userText: string, assistantText: string, tenancy: TurnTenancy = {}): Promise<void> {
    if (!this.#config.capture) return;
    const { user, session } = this.#resolveTenancy(tenancy);
    if (this.#config.captureUser && userText) {
      await this.#client.add(userText, { user, session });
    }
    if (this.#config.captureAssistant && assistantText) {
      await this.#client.add(assistantText, { user, session });
    }
  }

  /**
   * The whole wrap in one call: inject-before -> `llmCall(augmented)` -> capture-after -> return the
   * assistant text.
   *
   * The captured user turn is the ORIGINAL `prompt`, never the memory-augmented one — the injected
   * context is a retrieval aid for THIS turn, not new content to re-store (re-storing it would
   * compound recalled memory back into the store every turn).
   */
  async run(prompt: string, llmCall: LlmCall, tenancy: TurnTenancy = {}): Promise<string> {
    const augmentedPrompt = await this.before(prompt, tenancy);
    const assistantText = await llmCall(augmentedPrompt);
    await this.after(prompt, assistantText, tenancy);
    return assistantText;
  }

  /** Decorator form: return a memory-augmented version of `llmCall`. The returned function has the
   * shape `(prompt, { user?, session? }?) => Promise<string>` and runs the full inject->call->capture
   * wrap (`run`) on every invocation. */
  wrap(llmCall: LlmCall): (prompt: string, tenancy?: TurnTenancy) => Promise<string> {
    return (prompt: string, tenancy: TurnTenancy = {}): Promise<string> =>
      this.run(prompt, llmCall, tenancy);
  }
}
