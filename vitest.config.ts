import { defineConfig } from "vitest/config";

// vitest 2.x: no multi-project config block (that landed in 3.x) — `test:unit` /
// `test:integration` / `test:all` (package.json) select via CLI path args instead. Shared
// settings below cover both suites: the conformance server (real uvicorn) + client
// retry-backoff tests both take real wall-clock time, and only a couple of uvicorn processes
// should ever run at once on this RAM-constrained shared box.
export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
