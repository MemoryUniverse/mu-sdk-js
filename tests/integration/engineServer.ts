/**
 * Starts a REAL `mu-engine-server` instance (`mu-core/packages/mu-engine-server`) — the Stage C
 * server `mode="local_server"` targets (design §1.2) — over the REAL dev-stack stores (valkey
 * 16379 / qdrant 16333 / falkordb 16380 / SLM 11435, already up per this task's CONTEXT PACK).
 * DEV-STANDARDS "zero mocks": this SDK's real `fetch` (via `FetchTransport`) makes real HTTP
 * requests over real TCP to this real ASGI server, backed by real Redis/Qdrant/FalkorDB clients
 * (`mu_engine_server.composition.EngineContainer`), same shape as `conformanceServer.ts` spawns the
 * Python conformance server for the shared-plane/`mode="remote"` leg.
 *
 * Spawns `tests/integration/engine_server_launcher.py` (this repo's own file — `mu-engine-server`
 * ships no module-level `app` singleton yet, `mu_engine_server/app.py`'s own docstring: "Handoff
 * note for C4 ... not resolved here") under `uv run python`, from the `mu-core` workspace root (so
 * `uv` resolves `mu-contracts`/`mu-engine`/`mu-engine-server` from the workspace, mirroring how
 * `conformanceServer.ts` runs `uv run uvicorn ...` from the `mu-sdk-python` sibling repo). The
 * launcher mints a per-process bearer token at a caller-given path (the SAME contract `make up`
 * will follow in Stage E, `mu_engine_server/auth.py`'s documented default resolution) and reports
 * it back over stdout; this module picks the port itself (a free loopback port, `getFreePort()`)
 * so it is known BEFORE the child process starts, and confirms actual readiness by polling the
 * socket directly (see `waitUntilListening` — more reliable than parsing a startup banner line,
 * which can race the real bind).
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";

const MU_CORE_ROOT = path.resolve(import.meta.dirname, "../../../mu-core");
const LAUNCHER_SCRIPT = path.resolve(import.meta.dirname, "engine_server_launcher.py");
const START_TIMEOUT_MS = 60_000; // real embedder + real store clients — slower than the fake conformance server

export interface EngineServer {
  baseUrl: string;
  token: string;
  tokenPath: string;
  stop(): Promise<void>;
}

function assertPrereqsExist(): void {
  if (!existsSync(MU_CORE_ROOT)) {
    throw new Error(
      `mu-core not found at ${MU_CORE_ROOT} — the JS engine-server integration suite runs the real mu-engine-server package from that workspace; it cannot run without it.`,
    );
  }
  if (!existsSync(LAUNCHER_SCRIPT)) {
    throw new Error(`engine_server_launcher.py missing at ${LAUNCHER_SCRIPT}`);
  }
}

/** Reserves a free loopback TCP port by binding then immediately releasing it (the standard
 * "ask the OS for port 0, read back what it picked" trick) — used here so the port is known to
 * THIS process before the Python child is even spawned. */
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (address === null || typeof address === "string") {
        reject(new Error("could not resolve a free port"));
        return;
      }
      const { port } = address;
      srv.close(() => resolve(port));
    });
  });
}

/** Polls a real TCP connect (via `fetch`) until the server accepts the connection — any HTTP
 * response (even 401/404) counts as "listening"; only a connection-refused/reset keeps polling. */
async function waitUntilListening(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await fetch(`${baseUrl}/memories/__readiness_probe__`, {
        signal: AbortSignal.timeout(1_000),
      });
      return; // any response at all (401/404/whatever) proves the socket is live and routed
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(
    `mu-engine-server did not become reachable at ${baseUrl} within ${timeoutMs}ms: ${String(lastError)}`,
  );
}

/**
 * Boots a real `mu-engine-server` bound to a fresh per-process bearer token at `tokenPath`
 * (defaults to a caller-supplied temp path — this module never writes to the real
 * `~/.memory-universe/engine-server.token` unless explicitly told to, so it never collides with a
 * developer's own `make up` instance).
 */
export async function startEngineServer(tokenPath: string): Promise<EngineServer> {
  assertPrereqsExist();
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const child: ChildProcessWithoutNullStreams = spawn(
    "uv",
    ["run", "python", LAUNCHER_SCRIPT, "--token-path", tokenPath, "--port", String(port)],
    { cwd: MU_CORE_ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );

  let stderrBuffer = "";
  let stdoutBuffer = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBuffer += chunk.toString("utf8");
  });
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBuffer += chunk.toString("utf8");
  });

  let exitedEarly: number | null = null;
  child.on("exit", (code) => {
    exitedEarly = code;
  });

  try {
    await waitUntilListening(baseUrl, START_TIMEOUT_MS);
  } catch (error) {
    child.kill("SIGKILL");
    throw new Error(
      `${String(error)}\nexit code (if any): ${exitedEarly}\nstdout:\n${stdoutBuffer}\nstderr:\n${stderrBuffer}`,
    );
  }

  if (exitedEarly !== null) {
    throw new Error(
      `mu-engine-server exited early (code ${exitedEarly}) before it became reachable.\n` +
        `stdout:\n${stdoutBuffer}\nstderr:\n${stderrBuffer}`,
    );
  }

  // The launcher prints `ENGINE_SERVER_STARTING http://127.0.0.1:<port> token=<token>` — parsed
  // here purely to hand the minted token back to the caller (readiness itself was already
  // confirmed above via a real socket poll, not this banner).
  const tokenMatch = /token=(\S+)/.exec(stdoutBuffer);
  const token = tokenMatch?.[1];
  if (!token) {
    child.kill("SIGKILL");
    throw new Error(`could not parse minted token from launcher stdout:\n${stdoutBuffer}`);
  }

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 5_000).unref();
    });
  };

  return { baseUrl, token, tokenPath, stop };
}
