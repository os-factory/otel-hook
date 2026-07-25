import { readFileSync } from "node:fs";
import path from "node:path";

const FIXTURES_ROOT = path.join(process.cwd(), "tests/fixtures/codex");

export const loadHookFixture = (name: string): unknown =>
  JSON.parse(readFileSync(path.join(FIXTURES_ROOT, "hooks", name), "utf8")) as unknown;

export const transcriptFixturePath = (name: string): string =>
  path.join(FIXTURES_ROOT, "transcripts", name);
