import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FIXTURES_DIR = fileURLToPath(new URL("../../../fixtures/contracts/antigravity/", import.meta.url));

/**
 * Parse a synthetic Antigravity contract fixture.
 *
 * Provenance sidecars live beside the fixtures. They are reconstructions of
 * antigravity.google/docs/hooks, not captured transcripts.
 */
export const loadAntigravityFixture = (name: string): unknown =>
  JSON.parse(readFileSync(`${FIXTURES_DIR}${name}`, "utf8")) as unknown;
