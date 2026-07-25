import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      model: "src/model/index.ts",
      providers: "src/providers/index.ts",
      privacy: "src/privacy/index.ts",
      config: "src/config/index.ts",
      errors: "src/errors/index.ts",
      runtime: "src/runtime/index.ts",
      testing: "src/testing/index.ts",
      // Curated subpaths (src/public/*) rather than the internal module
      // barrels, so key-derivation helpers and span-assembly internals stay
      // out of the published surface.
      lifecycle: "src/public/lifecycle.ts",
      state: "src/public/state.ts",
      telemetry: "src/public/telemetry.ts",
      diagnostics: "src/public/diagnostics.ts",
      integration: "src/integration/index.ts",
      install: "src/install/index.ts",
    },
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    splitting: false,
  },
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    // src/cli.ts already starts with its own "#!/usr/bin/env node"; a banner
    // here would duplicate it, producing a second shebang line that isn't
    // valid JS and breaks the built binary (caught by tests/packaging).
    sourcemap: true,
    splitting: false,
  },
]);
