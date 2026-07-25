import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DIVERGENCE_MANIFEST } from "./divergence-manifest.js";

const PARITY_DIR = path.resolve(import.meta.dirname);

describe("divergence manifest hygiene", () => {
  it("every manifest entry is referenced by at least one *.parity.test.ts file", async () => {
    const files = (await readdir(PARITY_DIR)).filter((file) => file.endsWith(".parity.test.ts"));
    expect(files.length).toBeGreaterThan(0);

    const contents = await Promise.all(
      files.map((file) => readFile(path.join(PARITY_DIR, file), "utf8")),
    );
    const combined = contents.join("\n");

    const unreferenced = DIVERGENCE_MANIFEST.filter((entry) => !combined.includes(entry.id));
    expect(unreferenced.map((entry) => entry.id)).toEqual([]);
  });

  it("every manifest entry has a non-empty citation and a dimension", () => {
    for (const entry of DIVERGENCE_MANIFEST) {
      expect(entry.citation.length).toBeGreaterThan(0);
      expect(["usage", "lifecycle", "privacy", "aggregation"]).toContain(entry.dimension);
    }
  });

  it("manifest ids are unique and sequential", () => {
    const ids = DIVERGENCE_MANIFEST.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
