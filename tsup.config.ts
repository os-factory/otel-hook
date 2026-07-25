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
    banner: { js: "#!/usr/bin/env node" },
    sourcemap: true,
    splitting: false,
  },
]);
