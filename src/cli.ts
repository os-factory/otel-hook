#!/usr/bin/env node

import { VERSION } from "./index.js";

const args = new Set(process.argv.slice(2));

if (args.has("--version") || args.has("-v")) {
  process.stdout.write(`${VERSION}\n`);
} else {
  process.stdout.write("otel-hook: provider-neutral coding-agent telemetry\n");
}
