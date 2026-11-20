import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    // Builds dist/ once up front; see the file for why that cannot be left to
    // the suites that need it.
    globalSetup: ["tests/global-setup.ts"],
    // Many tests wait on a child process: the built CLI (30s kill timeout in
    // tests/e2e/harness.ts) or the pinned Python reference (60s, in
    // tests/parity/harness/python-spans.ts). A test budget shorter than the
    // child it waits on fails on a loaded machine before the child's own
    // timeout can report anything. One budget above both, instead of
    // per-test overrides that drift.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      reporter: ["text", "json", "html"],
    },
  },
});
