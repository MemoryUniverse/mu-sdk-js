/**
 * Pure-unit tests for `MemoryMiddleware` — the orchestration + opt-in-gating logic, driven through
 * a real `MemoryClient` wired to a fake `Transport` (the SAME sanctioned pattern `client.test.ts`
 * uses: "mocks ONLY in pure unit tests; the real wire round-trip is covered by integration, zero
 * mocks there"). The REAL store-touching proof (auto-inject a recalled fact + auto-capture both
 * turns against a live `mu-engine-server` over real Redis/Qdrant/FalkorDB) lives in
 * `tests/integration/middlewareAutoInjectCapture.test.ts`.
 *
 * Faithful mirror of `mu-sdk-python/tests/unit/test_middleware.py`.
 */
import { describe, expect, it } from "vitest";
import type { SdkAuth } from "../../src/auth.js";
import { MemoryClient } from "../../src/client.js";
import { MemoryMiddleware, defaultRender } from "../../src/middleware.js";
import type {
  Transport,
  TransportRequestOptions,
  TransportResponse as TransportResponseType,
} from "../../src/transport.js";
import { TransportResponse } from "../../src/transport.js";

interface RecordedCall {
  method: string;
  path: string;
  jsonBody: unknown;
}

/** A `Transport` fake that dispatches a canned, schema-valid response per verb path and records
 * every request — so a unit test can assert exactly which verbs the middleware issued (and with
 * what body) without a real socket. Not a store: it stands in for the wire only. */
class RecordingTransport implements Transport {
  readonly calls: RecordedCall[] = [];

  constructor(
    private readonly contextText = "",
    private readonly recallContents: string[] = [],
  ) {}

  async request(
    method: string,
    path: string,
    options: TransportRequestOptions = {},
  ): Promise<TransportResponseType> {
    this.calls.push({ method, path, jsonBody: options.jsonBody });
    if (path === "/v1/context/window") {
      return new TransportResponse(200, {}, { text: this.contextText, items: [] });
    }
    if (path === "/v1/memories/recall") {
      return new TransportResponse(
        200,
        {},
        {
          namespace: {
            org: "o",
            workspace: "w",
            user: "u",
            session: "s",
            visibility: "private",
          },
          items: this.recallContents.map((content, i) => ({
            memory_id: `m${i}`,
            content,
            tier: "stm",
            channel: "stm",
            fused_score: 1,
          })),
          channels_run: { stm: true, mtm: true, ltm: true },
          generated_at: new Date().toISOString(),
        },
      );
    }
    if (path === "/memories") {
      return new TransportResponse(
        200,
        {},
        {
          memory_id: "m1",
          content_hash: "h1",
          promoted: false,
          tiers_written: ["stm"],
          namespace: "ns",
        },
      );
    }
    throw new Error(`RecordingTransport: unexpected path ${path}`);
  }

  async close(): Promise<void> {
    return;
  }
}

const NULL_AUTH: SdkAuth = { headers: () => ({}) };

/** A real `MemoryClient` in `local_server` mode (so `user`/`session` private-plane fields are
 * accepted) wired to the fake transport — no network, no store. */
function client(transport: Transport): MemoryClient {
  return new MemoryClient({
    mode: "local_server",
    endpoint: "http://unit-test.invalid",
    auth: NULL_AUTH,
    transport,
  });
}

/** A `Transport` whose `request` must NEVER be reached — any call is a gating bug. */
class ExplodingTransport implements Transport {
  async request(method: string, path: string): Promise<TransportResponseType> {
    throw new Error(`middleware issued a wire call while gated OFF: ${method} ${path}`);
  }
  async close(): Promise<void> {
    return;
  }
}

describe("MemoryMiddleware", () => {
  it("defaultRender prepends a labelled block above the prompt", () => {
    const rendered = defaultRender("the fact", "the question");
    expect(rendered).toContain("the fact");
    expect(rendered.endsWith("the question")).toBe(true);
    expect(rendered.indexOf("the fact")).toBeLessThan(rendered.indexOf("the question"));
  });

  it("inject off leaves the prompt unchanged and issues no wire call", async () => {
    const mw = new MemoryMiddleware(client(new ExplodingTransport()), {
      inject: false,
      capture: false,
    });
    expect(await mw.before("hello", { user: "ada", session: "s1" })).toBe("hello");
  });

  it("fetchContext returns empty string when injection is off", async () => {
    const mw = new MemoryMiddleware(client(new ExplodingTransport()), { inject: false });
    expect(await mw.fetchContext("anything", { user: "ada", session: "s1" })).toBe("");
  });

  it("capture off is a no-op and issues no wire call", async () => {
    const mw = new MemoryMiddleware(client(new ExplodingTransport()), { capture: false });
    await expect(
      mw.after("user turn", "assistant turn", { user: "ada", session: "s1" }),
    ).resolves.toBeUndefined();
  });

  it("before() injects the context-window text via POST /v1/context/window", async () => {
    const transport = new RecordingTransport("RECALLED-FACT");
    const mw = new MemoryMiddleware(client(transport), { user: "ada", session: "s1" });
    const augmented = await mw.before("what is my fact?");
    expect(augmented).toContain("RECALLED-FACT");
    expect(augmented).toContain("Relevant memory from earlier");
    expect(transport.calls.map((c) => c.path)).toContain("/v1/context/window");
  });

  it("before() in recall mode joins hit contents via POST /v1/memories/recall", async () => {
    const transport = new RecordingTransport("", ["fact one", "fact two"]);
    const mw = new MemoryMiddleware(client(transport), {
      injectMode: "recall",
      user: "ada",
      session: "s1",
    });
    const augmented = await mw.before("q");
    expect(augmented).toContain("- fact one");
    expect(augmented).toContain("- fact two");
    expect(transport.calls.map((c) => c.path)).toContain("/v1/memories/recall");
  });

  it("after() captures both the user and assistant turns via POST /memories", async () => {
    const transport = new RecordingTransport();
    const mw = new MemoryMiddleware(client(transport), { user: "ada", session: "s1" });
    await mw.after("USER-TURN", "ASSISTANT-TURN");
    const adds = transport.calls.filter((c) => c.path === "/memories");
    expect(adds).toHaveLength(2);
    expect((adds[0]?.jsonBody as { content: string }).content).toBe("USER-TURN");
    expect((adds[1]?.jsonBody as { content: string }).content).toBe("ASSISTANT-TURN");
  });

  it("run() injects-before, calls the LLM with the augmented prompt, captures-after", async () => {
    // empty context text -> before() leaves the prompt unchanged (empty-store behavior)
    const transport = new RecordingTransport("");
    const mw = new MemoryMiddleware(client(transport), { user: "ada", session: "s1" });
    const seen: string[] = [];
    const answer = await mw.run("q1", (prompt) => {
      seen.push(prompt);
      return `answer to: ${prompt}`;
    });
    expect(seen).toEqual(["q1"]); // original prompt (no injection this turn)
    expect(answer).toBe("answer to: q1");
    // ordering: the read (context/window) happens before the writes (/memories)
    const paths = transport.calls.map((c) => c.path);
    expect(paths[0]).toBe("/v1/context/window");
    expect(paths.filter((p) => p === "/memories")).toHaveLength(2);
    // the captured USER turn is the ORIGINAL prompt, never an augmented one
    const firstAdd = transport.calls.find((c) => c.path === "/memories");
    expect((firstAdd?.jsonBody as { content: string }).content).toBe("q1");
  });

  it("run() supports an async LLM call", async () => {
    const mw = new MemoryMiddleware(client(new RecordingTransport("")), {
      user: "ada",
      session: "s1",
    });
    const answer = await mw.run("q2", async (prompt) => `async: ${prompt}`);
    expect(answer).toBe("async: q2");
  });

  it("wrap() returns a memory-augmented callable", async () => {
    const mw = new MemoryMiddleware(client(new RecordingTransport("")), {
      user: "ada",
      session: "s1",
    });
    const chat = mw.wrap((prompt) => `wrapped: ${prompt}`);
    expect(await chat("q3")).toBe("wrapped: q3");
  });

  it("per-call tenancy overrides the config defaults on the wire body", async () => {
    const transport = new RecordingTransport("");
    const mw = new MemoryMiddleware(client(transport), {
      user: "cfg-user",
      session: "cfg-session",
    });
    await mw.run("q", (p) => `a:${p}`, { user: "call-user", session: "call-session" });
    const add = transport.calls.find((c) => c.path === "/memories");
    expect((add?.jsonBody as { user: string; session: string }).user).toBe("call-user");
    expect((add?.jsonBody as { user: string; session: string }).session).toBe("call-session");
  });

  it("a custom render is used", async () => {
    const transport = new RecordingTransport("CTX");
    const mw = new MemoryMiddleware(client(transport), {
      user: "ada",
      session: "s1",
      render: (ctx, prompt) => `<<${ctx}>>${prompt}`,
    });
    expect(await mw.before("p")).toBe("<<CTX>>p");
  });
});
