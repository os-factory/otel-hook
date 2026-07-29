#!/usr/bin/env node
/**
 * Keep the runtime VERSION constant aligned with the release version that
 * semantic-release already wrote into package.json.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const version = process.argv[2] ?? JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;

if (typeof version !== "string" || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`sync-version: invalid version ${JSON.stringify(version)}`);
  process.exit(1);
}

const versionPath = path.join(root, "src/version.ts");
const next = `/**
 * Package version, kept in its own module so the CLI can report it without
 * importing the whole library barrel (and every provider adapter with it).
 *
 * Updated by \`scripts/release/sync-version.mjs\` during semantic-release.
 */
export const VERSION = ${JSON.stringify(version)};
`;

writeFileSync(versionPath, next);
console.log(`sync-version: wrote VERSION=${version} to src/version.ts`);
