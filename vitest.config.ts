import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    // Builds dist/ once up front; see the file for why that cannot be left to
    // the suites that need it.
    globalSetup: ["tests/global-setup.ts"],
    // The e2e and parity suites spawn the built CLI several times per test; the
    // 5s default fails them on a loaded machine though each spawn is correct.
    testTimeout: 30_000,
    coverage: {
      reporter: ["text", "json", "html"],
    },
  },
});
