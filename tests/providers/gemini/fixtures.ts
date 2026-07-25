import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, "../../fixtures/gemini");

/** Load a synthetic Gemini CLI hook fixture by file name, without its `.json` suffix. */
export const loadGeminiFixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(fixturesDir, `${name}.json`), "utf8"));
