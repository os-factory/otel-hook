import { readdir } from "node:fs/promises";
import * as path from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  ensureBuiltCli,
  makeStateDir,
  runCliProcess,
  startCollector,
  unreachableCollectorUrl,
  type Collector,
} from "./harness.js";
import { decodeAllExportedLogRecords } from "../helpers/otlp.js";

/**
 * The logs signal driven through the *built* CLI binary as a child process.
 *
 * These assertions cannot be made in-process: whether a hook stays fail-open when
 * its logs endpoint is wrong, whether stdout stays clean, and whether the default
 * posture really keeps a second signal off the wire are all properties of the
 * process, not of the library. The privacy assertions read the raw protobuf bodies
 * as text, because a protobuf string field appears verbatim in the payload — which
 * is what "this text is nowhere in what we sent" actually requires.
 */

beforeAll(async () => {
  await ensureBuiltCli();
}, 300_000);

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const withCollector = async (
  respond?: Parameters<typeof startCollector>[0],
): Promise<Collector> => {
  const collector = await startCollector(respond);
  cleanups.push(() => collector.close());
  return collector;
};

const withStateDir = async (): Promise<string> => {
  const state = await makeStateDir();
  cleanups.push(() => state.remove());
  return state.dir;
};

const PROMPT_SECRET = "e2e-logs-prompt-secret-do-not-export";

const promptPayload = (sessionId: string, prompt = PROMPT_SECRET) => ({
  hook_event_name: "UserPromptSubmit",
  session_id: sessionId,
  transcript_path: "/workspace/fixture-repo/.claude/transcript.jsonl",
  cwd: "/workspace/fixture-repo",
  prompt,
});

describe("otel-hook run: the logs signal is off unless asked for", () => {
  it("exports traces only, by default", async () => {
    const collector = await withCollector();
    const stateDir = await withStateDir();

    const result = await runCliProcess(
      ["run", "--provider", "claude-code", "--endpoint", collector.url, "--state-dir", stateDir],
      JSON.stringify(promptPayload("ses-logs-off")),
    );

    expect(result.code).toBe(0);
    expect(collector.requests.length).toBeGreaterThanOrEqual(1);
    // Every request went to the traces path: adding a signal must not change what an
    // existing installation sends.
    expect(collector.requests.every((request) => request.path === "/v1/traces")).toBe(true);
    expect(collector.textFor("/v1/logs")).toBe("");

    // No queue directory for a signal this installation never emits.
    const identityDir = path.join(stateDir, "claude-code", "default");
    expect(await readdir(identityDir)).not.toContain("spool-logs");
  }, 60_000);

  it("exports both signals with --logs, deriving the logs path from the trace endpoint", async () => {
    const collector = await withCollector();
    const stateDir = await withStateDir();
    const sessionId = "ses-logs-on";

    const result = await runCliProcess(
      [
        "run",
        "--provider",
        "claude-code",
        "--endpoint",
        collector.url,
        "--logs",
        "--state-dir",
        stateDir,
      ],
      JSON.stringify(promptPayload(sessionId)),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(collector.requests.some((request) => request.path === "/v1/traces")).toBe(true);
    expect(collector.requests.some((request) => request.path === "/v1/logs")).toBe(true);

    const records = decodeAllExportedLogRecords(
      collector.requests.filter((request) => request.path === "/v1/logs").map((request) => request.body),
    );
    expect(records.length).toBeGreaterThan(0);
    expect(records.some((record) => record.attributes["session.id"] === sessionId)).toBe(true);
    expect(records.some((record) => record.attributes["otelhook.log.signal"] === "prompt")).toBe(true);
    // Correlated to the trace, with ids of the right widths.
    for (const record of records) {
      expect(record.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(record.spanId).toMatch(/^[0-9a-f]{16}$/);
    }
  }, 60_000);

  it("reads the logs variables from the environment", async () => {
    const collector = await withCollector();
    const stateDir = await withStateDir();

    const result = await runCliProcess(
      ["run", "--provider", "claude-code", "--state-dir", stateDir],
      JSON.stringify(promptPayload("ses-logs-env")),
      {
        env: {
          OTEL_EXPORTER_OTLP_ENDPOINT: collector.url,
          OTEL_HOOK_LOGS_ENABLED: "1",
          OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: collector.logsUrl,
        },
      },
    );

    expect(result.code).toBe(0);
    expect(collector.requests.some((request) => request.path === "/v1/logs")).toBe(true);
  }, 60_000);
});

describe("otel-hook run: logs hold the same privacy policy as traces", () => {
  it("keeps prompt text and filesystem paths off both signals by default", async () => {
    const collector = await withCollector();
    const stateDir = await withStateDir();

    const result = await runCliProcess(
      [
        "run",
        "--provider",
        "claude-code",
        "--endpoint",
        collector.url,
        "--logs",
        "--state-dir",
        stateDir,
      ],
      JSON.stringify(promptPayload("ses-logs-privacy")),
    );

    expect(result.code).toBe(0);
    // One assertion over everything both signals sent.
    const wire = collector.text();
    expect(wire).toContain("ses-logs-privacy");
    expect(wire).not.toContain(PROMPT_SECRET);
    expect(wire).not.toContain("/workspace/fixture-repo");
    expect(wire).not.toContain("transcript.jsonl");

    // The measurable facts *are* there, which is what makes the omission a policy
    // rather than a gap.
    const records = decodeAllExportedLogRecords(
      collector.requests.filter((request) => request.path === "/v1/logs").map((request) => request.body),
    );
    const withContent = records.filter(
      (record) => record.attributes["otelhook.content.hash"] !== undefined,
    );
    expect(withContent.length).toBeGreaterThan(0);
    for (const record of withContent) {
      expect(record.body).toBeUndefined();
      expect(record.attributes["otelhook.content.withheld"]).toBe("privacy-policy");
    }
  }, 60_000);

  it("still withholds content when --logs-content is set but no mode discloses any", async () => {
    // Both gates are required, and this is the one an operator is most likely to set
    // alone. The result must be no content, not a partial disclosure.
    const collector = await withCollector();
    const stateDir = await withStateDir();

    const result = await runCliProcess(
      [
        "run",
        "--provider",
        "claude-code",
        "--endpoint",
        collector.url,
        "--logs",
        "--logs-content",
        "--state-dir",
        stateDir,
      ],
      JSON.stringify(promptPayload("ses-logs-content-only")),
    );

    expect(result.code).toBe(0);
    expect(collector.text()).not.toContain(PROMPT_SECRET);
  }, 60_000);

  it("discloses a redacted body only when both gates are open, and redacts secrets in it", async () => {
    const collector = await withCollector();
    const stateDir = await withStateDir();
    const prompt = "deploy with AKIAIOSFODNN7EXAMPLE please";

    const result = await runCliProcess(
      [
        "run",
        "--provider",
        "claude-code",
        "--endpoint",
        collector.url,
        "--logs",
        "--logs-content",
        "--content-mode",
        "redact",
        "--state-dir",
        stateDir,
      ],
      JSON.stringify(promptPayload("ses-logs-redacted", prompt)),
    );

    expect(result.code).toBe(0);
    const logWire = collector.textFor("/v1/logs");
    expect(logWire).toContain("deploy with");
    // The secret-looking span is replaced even in the disclosed body.
    expect(collector.text()).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(logWire).toContain("[redacted]");
    // Spans carry no content in any mode, which is why the logs pipeline needed its
    // own switch rather than reusing --content-mode alone.
    expect(collector.textFor("/v1/traces")).not.toContain("deploy with");
  }, 60_000);

  it("refuses raw content without the existing allowRawContent opt-in", async () => {
    const collector = await withCollector();
    const stateDir = await withStateDir();

    const result = await runCliProcess(
      [
        "run",
        "--provider",
        "claude-code",
        "--endpoint",
        collector.url,
        "--logs",
        "--logs-content",
        "--content-mode",
        "raw",
        "--state-dir",
        stateDir,
      ],
      JSON.stringify(promptPayload("ses-logs-raw-refused")),
    );

    expect(result.code).toBe(0);
    // `raw` was downgraded to `omit` because allowRawContent is unset, and the
    // downgrade is said out loud rather than applied silently.
    expect(result.stderr).toContain("downgraded to omit");
    expect(collector.text()).not.toContain(PROMPT_SECRET);
  }, 60_000);

  it("exports raw content once the opt-in is set, on the logs signal only", async () => {
    const collector = await withCollector();
    const stateDir = await withStateDir();

    const result = await runCliProcess(
      [
        "run",
        "--provider",
        "claude-code",
        "--endpoint",
        collector.url,
        "--logs",
        "--logs-content",
        "--content-mode",
        "raw",
        "--state-dir",
        stateDir,
      ],
      JSON.stringify(promptPayload("ses-logs-raw-allowed")),
      { env: { OTEL_HOOK_ALLOW_RAW_CONTENT: "1" } },
    );

    expect(result.code).toBe(0);
    expect(collector.textFor("/v1/logs")).toContain(PROMPT_SECRET);
    expect(collector.textFor("/v1/traces")).not.toContain(PROMPT_SECRET);
  }, 60_000);
});

describe("otel-hook run: the logs signal stays fail-open", () => {
  it("exits 0 and spools log batches when the collector is unreachable", async () => {
    const endpoint = await unreachableCollectorUrl();
    const stateDir = await withStateDir();

    const result = await runCliProcess(
      [
        "run",
        "--provider",
        "claude-code",
        "--endpoint",
        endpoint,
        "--logs",
        "--timeout-ms",
        "400",
        "--state-dir",
        stateDir,
      ],
      JSON.stringify(promptPayload("ses-logs-unreachable")),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");

    // Each signal spooled into its own queue, so neither consumed the other's
    // capacity.
    const identityDir = path.join(stateDir, "claude-code", "default");
    const entries = await readdir(identityDir);
    expect(entries).toContain("spool");
    expect(entries).toContain("spool-logs");
    expect((await readdir(path.join(identityDir, "spool-logs"))).filter((f) => f.endsWith(".json"))).toHaveLength(1);
  }, 60_000);

  it("exits 0 when only the logs receiver rejects, and still exports traces", async () => {
    // The failure mode the two sinks are separate objects for: a collector with no
    // logs receiver must cost the logs signal and nothing else.
    const collector = await withCollector((request) => ({
      status: request.path === "/v1/logs" ? 404 : 200,
    }));
    const stateDir = await withStateDir();

    const result = await runCliProcess(
      [
        "run",
        "--provider",
        "claude-code",
        "--endpoint",
        collector.url,
        "--logs",
        "--timeout-ms",
        "1000",
        "--state-dir",
        stateDir,
      ],
      JSON.stringify(promptPayload("ses-logs-404")),
    );

    expect(result.code).toBe(0);
    expect(collector.textFor("/v1/traces")).toContain("ses-logs-404");
  }, 60_000);
});

describe("otel-hook doctor: reports the logs signal", () => {
  it("passes with logs off, saying so rather than failing", async () => {
    const collector = await withCollector();
    const stateDir = await withStateDir();
    const result = await runCliProcess([
      "doctor",
      "--json",
      "--endpoint",
      collector.url,
      "--state-dir",
      stateDir,
    ]);

    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      checks: { name: string; ok: boolean; detail: string }[];
      config: Record<string, unknown>;
    };
    const check = report.checks.find((entry) => entry.name === "logs-exporter");
    expect(check?.ok).toBe(true);
    expect(check?.detail).toContain("logs are disabled");
    expect(report.config["exporter.logs_enabled"]).toBe(false);
    expect(report.ok).toBe(true);
  }, 60_000);

  it("reports a configured pipeline and whether its endpoint was derived", async () => {
    const collector = await withCollector();
    const stateDir = await withStateDir();
    const result = await runCliProcess([
      "doctor",
      "--json",
      "--endpoint",
      collector.url,
      "--logs",
      "--state-dir",
      stateDir,
    ]);

    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as {
      checks: { name: string; ok: boolean; detail: string }[];
      state: Record<string, unknown>;
    };
    const check = report.checks.find((entry) => entry.name === "logs-exporter");
    expect(check?.ok).toBe(true);
    expect(check?.detail).toContain("derived from the trace endpoint");
    expect(check?.detail).toContain("content disabled");
    expect(report.state["spooledLogBatches"]).toBe(0);
  }, 60_000);

  it("fails the check when logs are enabled with nowhere to send them", async () => {
    const stateDir = await withStateDir();
    const result = await runCliProcess(["doctor", "--json", "--logs", "--state-dir", stateDir]);

    // Exit code 1: the pipeline was asked for and cannot deliver, which is exactly
    // what a no-op sink would otherwise hide.
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as {
      checks: { name: string; ok: boolean; detail: string }[];
    };
    const check = report.checks.find((entry) => entry.name === "logs-exporter");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("no endpoint");
  }, 60_000);
});
