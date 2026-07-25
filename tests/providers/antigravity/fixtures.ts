import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FIXTURES_DIR = fileURLToPath(new URL("../../fixtures/antigravity/", import.meta.url));

/** Parse a synthetic fixture file. See `tests/fixtures/antigravity/README.md` for provenance. */
export const loadAntigravityFixture = (name: string): unknown =>
  JSON.parse(readFileSync(`${FIXTURES_DIR}${name}`, "utf8")) as unknown;
