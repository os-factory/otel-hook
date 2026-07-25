import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const VALIDATOR = path.join(REPO_ROOT, "scripts", "fixtures", "validate-fixtures.mjs");

type ValidationReport = {
  readonly checked: number;
  readonly fixed: readonly string[];
  readonly issues: readonly string[];
  readonly ok: boolean;
};

const runValidator = async (): Promise<ValidationReport> => {
  try {
    const { stdout } = await execFileAsync(process.execPath, [VALIDATOR, "--json"], {
      cwd: REPO_ROOT,
    });
    return JSON.parse(stdout) as ValidationReport;
  } catch (error) {
    const withStdout = error as { stdout?: string };
    if (typeof withStdout.stdout === "string" && withStdout.stdout.length > 0) {
      return JSON.parse(withStdout.stdout) as ValidationReport;
    }
    throw error;
  }
};

describe("fixture provenance", () => {
  it("every fixture has a valid, hash-matching provenance sidecar", async () => {
    const report = await runValidator();

    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checked).toBeGreaterThanOrEqual(11);
  });
});
