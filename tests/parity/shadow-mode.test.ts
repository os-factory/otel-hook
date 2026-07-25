import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const RUNNER_SOURCE = await readFile(
  path.join(REPO_ROOT, "scripts", "parity", "python-reference.mjs"),
  "utf8",
);

describe("shadow-mode invariants for the python reference runner", () => {
  it("never points the reference package at a real OTLP endpoint", () => {
    expect(RUNNER_SOURCE).toContain('OTEL_EXPORTER_OTLP_ENDPOINT: ""');
  });

  it("never enables the reference package's network logs pipeline", () => {
    expect(RUNNER_SOURCE).toContain('IDE_OTEL_ENABLE_LOGS: "false"');
  });

  it("always runs the reference package under a throwaway temp directory, never the real user home", () => {
    expect(RUNNER_SOURCE).toContain("mkdtemp(path.join(tmpdir()");
    expect(RUNNER_SOURCE).not.toMatch(/os\.homedir\(\)/);
    expect(RUNNER_SOURCE).not.toMatch(/process\.env\.HOME(?!DIR)/);
  });

  it("always tears down the isolated hook-home directory after a session", () => {
    expect(RUNNER_SOURCE).toMatch(/rm\(hookHome, \{ recursive: true, force: true \}\)/);
  });

  it("pins provider identity via CLI flag rather than relying on process-tree detection", () => {
    expect(RUNNER_SOURCE).toContain("CLI_FLAG_BY_PROVIDER");
  });
});

describe("shadow-mode invariants for our own hook path", () => {
  it("does not import or reference any OTLP exporter from the differential test harness", async () => {
    const harnessFiles = [
      "tests/parity/harness/canonical-mapping.ts",
      "tests/parity/harness/python-spans.ts",
    ];
    for (const relPath of harnessFiles) {
      const source = await readFile(path.join(REPO_ROOT, relPath), "utf8");
      expect(source).not.toMatch(/exporter-trace-otlp/);
      expect(source).not.toMatch(/OTLPTraceExporter/);
    }
  });
});
