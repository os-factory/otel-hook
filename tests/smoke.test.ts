import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CANONICAL_SCHEMA_VERSION, VERSION } from "../src/index.js";

const packageJson = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "..", "package.json"), "utf8"),
) as { version: string };
const packageVersion = packageJson.version;

describe("package bootstrap", () => {
  it("exports package and schema versions", () => {
    expect(VERSION).toBe(packageVersion);
    expect(CANONICAL_SCHEMA_VERSION).toBe(1);
  });
});
