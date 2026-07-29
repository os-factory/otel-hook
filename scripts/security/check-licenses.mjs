#!/usr/bin/env node
// Scans every installed production+dev dependency's declared license against
// an explicit allowlist. No new dependency is added to do this (deliberately:
// a license scanner that itself drags in a large dependency tree is its own
// supply-chain surface); it just reads each package's own package.json.
//
// Usage: node scripts/security/check-licenses.mjs [--json]

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const NODE_MODULES = path.join(REPO_ROOT, "node_modules");

/**
 * SPDX identifiers permissive enough to ship inside this package without
 * separate legal review. Anything else fails the scan and must be reviewed
 * and added here deliberately, alongside the copyright-notice obligations it
 * brings (docs/compatibility-policy.md).
 */
const ALLOWED_LICENSES = new Set([
  "MIT",
  "ISC",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "CC0-1.0",
  "Unlicense",
  "Python-2.0",
  "BlueOak-1.0.0",
  // Weak-copyleft, dev-only transitive dependency (vitest -> vite ->
  // lightningcss); never bundled into dist/ or shipped to consumers.
  "MPL-2.0",
  // Dev-only transitive of semantic-release (@semantic-release/npm -> npm);
  // never bundled into dist/ or shipped to consumers.
  "Artistic-2.0",
  // Dev-only transitive of the SPDX license tooling pulled in by
  // semantic-release; attribution-only, never bundled into dist/.
  "CC-BY-3.0",
]);

const normalizeLicense = (license) => {
  if (typeof license === "string") {
    return license;
  }
  if (license !== null && typeof license === "object" && typeof license.type === "string") {
    return license.type;
  }
  return undefined;
};

/** A license expression may be an SPDX OR/AND expression; treat any single permissive term as satisfying it. */
const isAllowed = (expression) => {
  if (expression === undefined) {
    return false;
  }
  const terms = expression
    .replace(/[()]/g, " ")
    .split(/\s+(?:OR|AND)\s+/i)
    .map((term) => term.trim())
    .filter((term) => term.length > 0 && term !== "OR" && term !== "AND");
  return terms.length > 0 && terms.every((term) => ALLOWED_LICENSES.has(term));
};

const walkPackages = async (dir, scope, results) => {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name.startsWith("@")) {
      await walkPackages(path.join(dir, entry.name), `${entry.name}/`, results);
      continue;
    }
    const pkgPath = path.join(dir, entry.name, "package.json");
    try {
      const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
      results.set(`${scope}${entry.name}@${pkg.version ?? "unknown"}`, normalizeLicense(pkg.license));
    } catch {
      continue;
    }
  }
};

export const checkLicenses = async () => {
  const results = new Map();
  await walkPackages(NODE_MODULES, "", results);

  const violations = [];
  for (const [id, license] of results.entries()) {
    if (!isAllowed(license)) {
      violations.push({ id, license: license ?? "<none declared>" });
    }
  }
  violations.sort((a, b) => a.id.localeCompare(b.id));

  return { checked: results.size, violations, ok: violations.length === 0 };
};

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  const json = process.argv.includes("--json");
  const result = await checkLicenses();
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`checked ${result.checked} installed package(s)\n`);
    for (const violation of result.violations) {
      process.stderr.write(`DISALLOWED LICENSE: ${violation.id} -> ${violation.license}\n`);
    }
    if (result.ok) {
      process.stdout.write("all licenses allowed\n");
    }
  }
  process.exitCode = result.ok ? 0 : 1;
}
