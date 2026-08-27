import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  ensureBuiltCli,
  findProviderCase,
  makeStateDir,
  runCliProcess,
} from "./harness.js";

/**
 * Local JSONL and console exporters driven through the built CLI binary.
 *
 * `--no-export` must still write the file, stdout must stay empty for a silent
 * provider, and prompt text must not appear — privacy is applied before any sink.
 */

beforeAll(async () => {
  await ensureBuiltCli();
}, 300_000);

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const withStateDir = async (): Promise<string> => {
  const state = await makeStateDir();
  cleanups.push(() => state.remove());
  return state.dir;
};

describe("otel-hook run: local JSONL export", () => {
  it("writes canonical events under --no-export without touching stdout or prompt text", async () => {
    const stateDir = await withStateDir();
    const jsonlPath = path.join(stateDir, "events.jsonl");
    const providerCase = findProviderCase("claude-code");
    const result = await runCliProcess(
      [
        "run",
        "--provider",
        "claude-code",
        "--no-export",
        "--jsonl",
        jsonlPath,
        "--log-level",
        "silent",
        "--state-dir",
        stateDir,
      ],
      JSON.stringify(providerCase.payload("ses-jsonl")),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    const body = await readFile(jsonlPath, "utf8");
    expect(body).toContain('"schema":"otelhook.local-export"');
    expect(body).toContain('"schemaVersion":1');
    expect(body).not.toContain(providerCase.secret);
    expect(body).not.toContain("/workspace/fixture-repo");
    if (process.platform !== "win32") {
      expect((await stat(jsonlPath)).mode & 0o777).toBe(0o600);
    }
  }, 60_000);

  it("reads the JSONL path from the environment and still ignores --no-export", async () => {
    const stateDir = await withStateDir();
    const jsonlPath = path.join(stateDir, "from-env.jsonl");
    const providerCase = findProviderCase("claude-code");
    const result = await runCliProcess(
      [
        "run",
        "--provider",
        "claude-code",
        "--no-export",
        "--log-level",
        "silent",
        "--state-dir",
        stateDir,
      ],
      JSON.stringify(providerCase.payload("ses-jsonl-env")),
      { env: { OTEL_HOOK_JSONL_PATH: jsonlPath } },
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    const body = await readFile(jsonlPath, "utf8");
    expect(body).toContain("otelhook.local-export");
    expect(body).not.toContain(providerCase.secret);
  }, 60_000);
});

describe("otel-hook run: console export", () => {
  it("writes JSONL to stderr and leaves stdout empty for a silent provider", async () => {
    const stateDir = await withStateDir();
    const providerCase = findProviderCase("claude-code");
    const result = await runCliProcess(
      [
        "run",
        "--provider",
        "claude-code",
        "--no-export",
        "--console",
        "--log-level",
        "silent",
        "--state-dir",
        stateDir,
      ],
      JSON.stringify(providerCase.payload("ses-console")),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('"schema":"otelhook.local-export"');
    expect(result.stderr).not.toContain(providerCase.secret);
  }, 60_000);
});

describe("otel-hook doctor: reports local exporters", () => {
  it("passes with both exporters off, saying so rather than failing", async () => {
    const stateDir = await withStateDir();
    const result = await runCliProcess(["doctor", "--json", "--no-export", "--state-dir", stateDir]);

    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as {
      checks: { name: string; ok: boolean; detail: string }[];
      config: Record<string, unknown>;
    };
    const jsonl = report.checks.find((entry) => entry.name === "jsonl-exporter");
    const consoleCheck = report.checks.find((entry) => entry.name === "console-exporter");
    expect(jsonl?.ok).toBe(true);
    expect(jsonl?.detail).toContain("disabled");
    expect(consoleCheck?.ok).toBe(true);
    expect(consoleCheck?.detail).toContain("disabled");
    expect(report.config["local_export.jsonl_enabled"]).toBe(false);
    expect(report.config["local_export.console_enabled"]).toBe(false);
  }, 60_000);

  it("reports a configured JSONL path without putting the path in the snapshot", async () => {
    const stateDir = await withStateDir();
    const jsonlPath = path.join(stateDir, "doctor-events.jsonl");
    const result = await runCliProcess([
      "doctor",
      "--json",
      "--no-export",
      "--jsonl",
      jsonlPath,
      "--state-dir",
      stateDir,
    ]);

    const report = JSON.parse(result.stdout) as {
      checks: { name: string; ok: boolean; detail: string }[];
      config: Record<string, unknown>;
    };
    const jsonl = report.checks.find((entry) => entry.name === "jsonl-exporter");
    expect(jsonl?.ok).toBe(true);
    expect(jsonl?.detail).toContain("configured");
    expect(report.config["local_export.jsonl_enabled"]).toBe(true);
    expect(JSON.stringify(report.config)).not.toContain(jsonlPath);
    expect(JSON.stringify(report.config)).not.toContain("doctor-events.jsonl");
  }, 60_000);

  it("fails the JSONL check when the path would write onto a process stream", async () => {
    const stateDir = await withStateDir();
    const result = await runCliProcess([
      "doctor",
      "--json",
      "--no-export",
      "--jsonl",
      "/dev/stdout",
      "--state-dir",
      stateDir,
    ]);

    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as {
      checks: { name: string; ok: boolean; detail: string }[];
    };
    const jsonl = report.checks.find((entry) => entry.name === "jsonl-exporter");
    expect(jsonl?.ok).toBe(false);
    expect(jsonl?.detail).toContain("process stream");
    expect(JSON.stringify(report)).not.toContain("/dev/stdout");
  }, 60_000);
});
