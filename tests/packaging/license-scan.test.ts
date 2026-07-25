import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "security", "check-licenses.mjs");

type LicenseReport = {
  readonly checked: number;
  readonly violations: readonly { readonly id: string; readonly license: string }[];
  readonly ok: boolean;
};

describe("dependency license scan", () => {
  it("every installed dependency declares an allowlisted license", async () => {
    const { stdout } = await execFileAsync(process.execPath, [SCRIPT, "--json"], {
      cwd: REPO_ROOT,
      timeout: 30_000,
    });
    const report = JSON.parse(stdout) as LicenseReport;

    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checked).toBeGreaterThan(0);
  });
});
