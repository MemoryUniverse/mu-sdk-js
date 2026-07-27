/**
 * Starts a REAL uvicorn instance of the SAME Python conformance server the Python SDK's own
 * integration suite runs against (`mu-sdk-python/tests/conformance_server/app.py`) — DEV-STANDARDS
 * "integration tests use the real system, zero mocks": this SDK's real `fetch` (via
 * `FetchTransport`) makes real HTTP requests over real TCP to this real ASGI server. Reusing the
 * identical server the Python SDK tests against is the whole point: it PROVES cross-language wire
 * compatibility (both clients hit the same process, over the same versioned wire contract).
 *
 * Spawns `uv run uvicorn tests.conformance_server.app:app` from the `mu-sdk-python` sibling repo
 * on an OS-assigned port (`--port 0`), reads the bound port off uvicorn's own stdout log line, and
 * tears the process down (SIGTERM, real graceful shutdown) after each test file.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const PYTHON_SDK_ROOT = path.resolve(import.meta.dirname, "../../../mu-sdk-python");
const BOUND_ADDRESS_RE = /Uvicorn running on http:\/\/127\.0\.0\.1:(\d+)/;
const START_TIMEOUT_MS = 20_000;

export interface ConformanceServer {
  baseUrl: string;
  stop(): Promise<void>;
}

function assertPythonSdkRootExists(): void {
  if (!existsSync(PYTHON_SDK_ROOT)) {
    throw new Error(
      `mu-sdk-python not found at ${PYTHON_SDK_ROOT} — the JS conformance suite reuses that repo's real conformance_server/app.py under a real uvicorn; it cannot run without it.`,
    );
  }
}

/**
 * Boots the real conformance server and resolves once uvicorn reports it is actually listening
 * (parsed from its own stdout, not a fixed sleep). Rejects if it fails to start within the
 * timeout, or exits early (e.g. `uv`/`uvicorn` missing from the sibling repo's environment).
 */
export async function startConformanceServer(): Promise<ConformanceServer> {
  assertPythonSdkRootExists();

  const child: ChildProcessWithoutNullStreams = spawn(
    "uv",
    ["run", "uvicorn", "tests.conformance_server.app:app", "--host", "127.0.0.1", "--port", "0"],
    { cwd: PYTHON_SDK_ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );

  const baseUrl = await new Promise<string>((resolve, reject) => {
    let settled = false;
    let stderrBuffer = "";

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(
        new Error(
          `conformance server did not report a bound port within ${START_TIMEOUT_MS}ms.\n` +
            `stderr so far:\n${stderrBuffer}`,
        ),
      );
    }, START_TIMEOUT_MS);

    const onData = (chunk: Buffer): void => {
      stderrBuffer += chunk.toString("utf8");
      const match = BOUND_ADDRESS_RE.exec(stderrBuffer);
      if (match?.[1] && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    };
    // uvicorn logs its "Uvicorn running on ..." banner to stderr by default.
    child.stderr.on("data", onData);
    child.stdout.on("data", onData);

    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(`conformance server exited early (code ${code}) before it started serving.`),
      );
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
      // Fallback if the graceful shutdown hangs — never leaves an orphaned uvicorn process.
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 5_000).unref();
    });
  };

  return { baseUrl, stop };
}
