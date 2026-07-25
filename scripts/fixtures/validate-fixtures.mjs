#!/usr/bin/env node
// Validates every fixture under fixtures/** against its provenance sidecar.
//
// Usage:
//   node scripts/fixtures/validate-fixtures.mjs           # check, exit 1 on any violation
//   node scripts/fixtures/validate-fixtures.mjs --fix     # rewrite sha256 fields to match content
//   node scripts/fixtures/validate-fixtures.mjs --json    # machine-readable report on stdout, no exit-code text noise
//
// A fixture is any `*.json` file under fixtures/parity/** that is not itself a
// `*.provenance.json` sidecar. Every fixture must have a sibling
// `<name>.provenance.json` matching fixtures/provenance.schema.json, whose
// `sha256` field equals the SHA-256 of the fixture file's exact bytes.
//
// This script never reads outside the repository's fixtures/ directory, never
// makes network calls, and never writes anything unless --fix is passed.

import { createHash } from "node:crypto";
import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const FIXTURES_ROOT = path.join(REPO_ROOT, "fixtures", "parity");

const REQUIRED_FIELDS = [
  "fixture",
  "sourceContract",
  "provider",
  "capturedDate",
  "author",
  "sanitization",
  "licenseBasis",
  "sha256",
];

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Patterns that must never appear in a synthetic fixture's raw text. These are
 * defense-in-depth checks, not a substitute for author review: a real home
 * directory, a private key marker, or a live-looking API token has no reason
 * to exist in an invented payload.
 */
const FORBIDDEN_PATTERNS = [
  { name: "unix home directory", pattern: /\/home\/[a-z0-9_-]+/i },
  { name: "macOS home directory", pattern: /\/Users\/[a-z0-9_-]+/i },
  { name: "windows user profile", pattern: /C:\\Users\\[a-z0-9_-]+/i },
  { name: "PEM private key marker", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "AWS access key id", pattern: /AKIA[0-9A-Z]{16}/ },
  { name: "generic bearer token", pattern: /\bBearer [A-Za-z0-9._-]{20,}/ },
];

const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

const isFixtureFile = (name) => name.endsWith(".json") && !name.endsWith(".provenance.json");

const walk = async (dir) => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
};

const validateSchemaShape = (record, provenancePath) => {
  const issues = [];
  for (const field of REQUIRED_FIELDS) {
    if (typeof record[field] !== "string" || record[field].length === 0) {
      issues.push(`${provenancePath}: missing or empty required field "${field}"`);
    }
  }
  if (typeof record.sha256 === "string" && !SHA256_PATTERN.test(record.sha256)) {
    issues.push(`${provenancePath}: sha256 "${record.sha256}" is not 64 lowercase hex characters`);
  }
  if (typeof record.provider === "string" && !PROVIDER_ID_PATTERN.test(record.provider)) {
    issues.push(`${provenancePath}: provider "${record.provider}" must be lowercase and hyphenated`);
  }
  if (typeof record.capturedDate === "string" && !DATE_PATTERN.test(record.capturedDate)) {
    issues.push(`${provenancePath}: capturedDate "${record.capturedDate}" must be an ISO 8601 date (YYYY-MM-DD)`);
  }
  const allowedKeys = new Set([...REQUIRED_FIELDS, "providerVersionObserved", "notes"]);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      issues.push(`${provenancePath}: unexpected field "${key}"`);
    }
  }
  return issues;
};

const scanForbiddenContent = (text, fixturePath) => {
  const issues = [];
  for (const { name, pattern } of FORBIDDEN_PATTERNS) {
    if (pattern.test(text)) {
      issues.push(`${fixturePath}: matches forbidden pattern "${name}" — remove real-looking data from synthetic fixtures`);
    }
  }
  return issues;
};

export const validateFixtures = async ({ fix = false } = {}) => {
  const allFiles = await walk(FIXTURES_ROOT).catch(() => []);
  const fixtureFiles = allFiles.filter((file) => isFixtureFile(path.basename(file))).sort();

  const issues = [];
  const fixed = [];
  let checked = 0;

  for (const fixturePath of fixtureFiles) {
    const relFixture = path.relative(REPO_ROOT, fixturePath);
    const provenancePath = fixturePath.replace(/\.json$/, ".provenance.json");
    const relProvenance = path.relative(REPO_ROOT, provenancePath);

    const raw = await readFile(fixturePath, "utf8");
    issues.push(...scanForbiddenContent(raw, relFixture));

    let provenanceRaw;
    try {
      provenanceRaw = await readFile(provenancePath, "utf8");
    } catch {
      issues.push(`${relFixture}: missing required sidecar ${relProvenance}`);
      continue;
    }

    let record;
    try {
      record = JSON.parse(provenanceRaw);
    } catch (error) {
      issues.push(`${relProvenance}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }

    issues.push(...scanForbiddenContent(provenanceRaw, relProvenance));

    const expectedFixtureName = path.basename(fixturePath);
    if (record.fixture !== expectedFixtureName) {
      issues.push(
        `${relProvenance}: fixture field "${record.fixture}" does not match sidecar's own fixture name "${expectedFixtureName}"`,
      );
    }

    const actualHash = sha256Hex(Buffer.from(raw, "utf8"));
    if (record.sha256 !== actualHash) {
      if (fix) {
        record.sha256 = actualHash;
        await writeFile(provenancePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
        fixed.push(relProvenance);
      } else {
        issues.push(
          `${relProvenance}: sha256 "${record.sha256 ?? "<missing>"}" does not match fixture content (expected ${actualHash}); ` +
            `run with --fix after reviewing the change, never blindly`,
        );
      }
    }

    issues.push(...validateSchemaShape(record, relProvenance));
    checked += 1;
  }

  return {
    checked,
    fixed,
    issues,
    ok: issues.length === 0,
  };
};

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  const fix = process.argv.includes("--fix");
  const json = process.argv.includes("--json");
  const result = await validateFixtures({ fix });

  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`checked ${result.checked} fixture(s)\n`);
    for (const path_ of result.fixed) {
      process.stdout.write(`fixed sha256: ${path_}\n`);
    }
    for (const issue of result.issues) {
      process.stderr.write(`VIOLATION: ${issue}\n`);
    }
    if (result.ok) {
      process.stdout.write("all fixtures valid\n");
    }
  }

  process.exitCode = result.ok ? 0 : 1;
}
