import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const SMOKE_SCRIPT = path.join(REPO_ROOT, "scripts", "packaging", "pack-smoke-test.mjs");

type SmokeResult =
  | { readonly ok: true; readonly steps: readonly string[] }
  | { readonly ok: false; readonly error: string };

const runSmokeTest = async (): Promise<SmokeResult> => {
  try {
    // `--skip-build`: vitest's global setup already built dist/ for this run.
    // Rebuilding here would run `tsup` with `clean: true` while the end-to-end
    // suite is spawning dist/cli.js, deleting the binary mid-test.
    const { stdout } = await execFileAsync(process.execPath, [SMOKE_SCRIPT, "--json", "--skip-build"], {
      cwd: REPO_ROOT,
      timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return JSON.parse(stdout) as SmokeResult;
  } catch (error) {
    const withStdout = error as { stdout?: string };
    if (typeof withStdout.stdout === "string" && withStdout.stdout.length > 0) {
      return JSON.parse(withStdout.stdout) as SmokeResult;
    }
    throw error;
  }
};

describe("packed tarball install/binary/API smoke test", () => {
  it(
    "builds, packs, installs the tarball into a scratch consumer, and exercises every export + the CLI binary",
    async () => {
      const result = await runSmokeTest();

      if (!result.ok) {
        throw new Error(result.error);
      }

      expect(result.steps.some((step) => step.startsWith("pack contents: only"))).toBe(true);
      expect(result.steps.some((step) => step.startsWith("install: ok"))).toBe(true);
      expect(result.steps.filter((step) => step.startsWith("import ")).length).toBeGreaterThanOrEqual(14);
      expect(result.steps.some((step) => step.includes("--version"))).toBe(true);
      // The installed binary must be able to construct every adapter it ships
      // and run its own diagnostic, not merely resolve its subpaths.
      expect(result.steps.some((step) => step.includes("providers --json"))).toBe(true);
      expect(result.steps.some((step) => step.includes("doctor --json"))).toBe(true);
    },
    200_000,
  );
});
