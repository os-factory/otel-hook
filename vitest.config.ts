import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    // Builds dist/ once up front; see the file for why that cannot be left to
    // the suites that need it.
    globalSetup: ["tests/global-setup.ts"],
    coverage: {
      reporter: ["text", "json", "html"],
    },
  },
});
