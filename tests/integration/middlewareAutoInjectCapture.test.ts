/**
 * ACCEPTANCE PROOF for `MemoryMiddleware` (AGENT-INTEGRATION-AUDIT-AND-PLAN §4 Phase 5), JS side —
 * an app that makes NO explicit `add`/`recall`/`buildContext` calls still accrues and reuses memory
 * across turns, proven against a REAL running `mu-engine-server` over the REAL dev stores
 * (`./engineServer.ts` spawns it — real Valkey/Qdrant/FalkorDB clients; DEV-STANDARDS "zero mocks":
 * real `fetch`, real TCP, real ASGI server, real stores). The JS SDK has no embedded mode (design
 * §1.3), so the real path here is `mode="local_server"` against the live engine-server — the JS
 * analogue of the Python SDK's embedded acceptance test.
 *
 * Shape (mirrors the plan's VERIFY): one `(user, session)`, a deterministic STUB "LLM" (a fixed
 * function — the LLM is NOT under test, the MEMORY middleware is), across two turns:
 * - Turn 1 STATES a fact; the middleware auto-captures it (no app-side `add`).
 * - Turn 2 ASKS about it; the middleware auto-injects the fact into turn 2's prompt from the REAL
 *   store (no app-side `recall`/`buildContext`).
 *
 * Then two independent assertions:
 * 1. auto-inject: turn 2's prompt (as the stub actually received it) carries the fact recalled from
 *    the real store, plus the render marker proving it arrived via injection.
 * 2. auto-capture: an INDEPENDENT real read straight off the engine (`client.recall`, NOT through
 *    the middleware) surfaces BOTH turns' user text — the exchange really landed in the store.
 *
 * Slow (spins up a real embedder + real store clients) — run via `npm run test:integration`, never
 * part of `npm test`/`test:unit`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryClient } from "../../src/client.js";
import { MemoryMiddleware } from "../../src/middleware.js";
import { type EngineServer, startEngineServer } from "./engineServer.js";

const SETUP_TIMEOUT_MS = 90_000;

let dir: string;
let server: EngineServer;
let client: MemoryClient;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "mu-sdk-js-middleware-it-"));
  server = await startEngineServer(path.join(dir, "engine-server.token"));
  client = new MemoryClient({
    mode: "local_server",
    endpoint: server.baseUrl,
    tokenPath: server.tokenPath,
  });
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await client.close();
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("MemoryMiddleware over a REAL mu-engine-server (mode=local_server)", () => {
  it(
    "auto-injects turn 1's fact into turn 2 and auto-captures both turns (real stores)",
    async () => {
      const uid = Math.random().toString(36).slice(2, 10);
      const factValue = `staging-eu-${uid}`;
      const user = "ada";
      const session = `chat-${uid}`;

      const seenPrompts: string[] = [];
      const stubLlm = (prompt: string): string => {
        seenPrompts.push(prompt);
        const injected = prompt.includes("Relevant memory from earlier");
        if (prompt.toLowerCase().includes("what is my deploy target")) {
          return injected && prompt.includes(factValue)
            ? `Your deploy target is ${factValue}.`
            : "I don't have any earlier context about your deploy target.";
        }
        return "Noted.";
      };

      const mw = new MemoryMiddleware(client, { user, session });
      const chat = mw.wrap(stubLlm);

      // Turn 1: state the fact. App makes NO add/recall call — only chat(...).
      await chat(`Please remember: my deploy target is ${factValue}.`);
      expect(seenPrompts[0]).toBe(`Please remember: my deploy target is ${factValue}.`); // empty store -> nothing injected on turn 1

      // Turn 2: ask about it. App STILL makes NO recall call; turn 2's OWN text has no fact.
      const turn2Prompt = `What is my deploy target? (ref ${uid})`;
      expect(turn2Prompt).not.toContain(factValue);
      const turn2Answer = await chat(turn2Prompt);

      // (1) AUTO-INJECT: the stub saw turn 2 with the fact spliced in from the REAL store.
      const turn2Seen = seenPrompts[seenPrompts.length - 1] ?? "";
      expect(turn2Seen).toContain(factValue);
      expect(turn2Seen).toContain("Relevant memory from earlier");
      expect(turn2Seen).not.toBe(turn2Prompt);
      expect(turn2Answer).toContain(factValue);

      // (2) AUTO-CAPTURE: an INDEPENDENT real read off the engine (not via the middleware) finds
      // BOTH turns' user text in the store.
      const readback = await client.recall(`deploy target ${uid}`, {
        user,
        session,
        limit: 25,
      });
      const contents = readback.items.map((i) => i.content);
      expect(contents.some((c) => c.includes(factValue))).toBe(true);
      expect(contents.some((c) => c.includes(`ref ${uid}`))).toBe(true);
    },
    SETUP_TIMEOUT_MS,
  );
});
