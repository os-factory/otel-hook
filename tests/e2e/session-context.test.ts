/**
 * Session context (docs/session-context.md), end to end through the built CLI:
 * one hook process per callback, a real context directory, a local OTLP
 * receiver decoding all three signals.
 *
 * Codex payloads carry `occurred_at`, so each callback's time is fixed and the
 * segment boundaries can be tested exactly. Payloads are built from
 * `tests/fixtures/codex/hooks/` (see its PROVENANCE.md) with test-only session
 * ids; nothing comes from a real session.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { decodeAllExportedLogRecords, decodeAllExportedSpans } from "../helpers/otlp.js";
import {
  ensureBuiltCli,
  makeStateDir,
  REPO_ROOT,
  runCliProcess,
  startCollector,
  type CliResult,
  type Collector,
} from "./harness.js";

type DecodedMetricPoint = {
  readonly name: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly resourceAttributes: Readonly<Record<string, unknown>>;
};

let decodeAllExportedMetrics: (bodies: readonly Buffer[]) => DecodedMetricPoint[];

beforeAll(async () => {
  await ensureBuiltCli();
  const decoderUrl = pathToFileURL(path.join(REPO_ROOT, "scripts", "e2e-proof", "otlp-decode.mjs")).href;
  const decoder = (await import(decoderUrl)) as { decodeAllExportedMetrics: typeof decodeAllExportedMetrics };
  decodeAllExportedMetrics = decoder.decodeAllExportedMetrics;
}, 300_000);

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const withCollector = async (): Promise<Collector> => {
  const collector = await startCollector();
  cleanups.push(() => collector.close());
  return collector;
};

const withStateDir = async (): Promise<string> => {
  const state = await makeStateDir();
  cleanups.push(() => state.remove());
  return state.dir;
};

const fixture = async (name: string): Promise<Record<string, unknown>> =>
  JSON.parse(
    await readFile(path.join(REPO_ROOT, "tests", "fixtures", "codex", "hooks", `${name}.json`), "utf8"),
  ) as Record<string, unknown>;

const SESSION = "codex-context-e2e-session";
const BASE = 1_800_000_000_000;
const iso = (millis: number): string => new Date(millis).toISOString();

/** The window the attempt is in force: from the first prompt, until the second. */
const FROM = BASE + 1_000;
const TO = BASE + 10_000;

const writeContextFile = async (
  dir: string,
  attributes: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Promise<void> => {
  await mkdir(path.join(dir, "codex"), { recursive: true });
  await writeFile(
    path.join(dir, "codex", `${SESSION}.json`),
    JSON.stringify({
      version: 1,
      agentTool: "codex",
      sessionId: SESSION,
      segments: [{ from: iso(FROM), to: iso(TO), reason: "launch", attributes }],
      ...overrides,
    }),
    "utf8",
  );
};

const ATTEMPT = {
  "factory.work_unit.id": "wu-ctx",
  "factory.attempt.id": "attempt-in-context",
  "factory.slot.id": "2",
  "factory.local.work_dir": "/home/dev/never-exported",
};

/**
 * One two-turn Codex session. The session start comes before the segment, turn
 * 1 (prompt, tool call, stop) inside it, and turn 2 at and after its end.
 */
const sessionPayloads = async (): Promise<readonly Record<string, unknown>[]> => {
  const ids = { session_id: SESSION, cwd: "/workspace/fixture-repo" };
  const prompt = await fixture("user-prompt-submit");
  const stop = await fixture("stop");
  const usage = (input: number, output: number) => ({
    input_tokens: input,
    cached_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + output,
  });
  return [
    { ...(await fixture("session-start")), ...ids, occurred_at: BASE },
    { ...prompt, ...ids, turn_id: "turn-c-1", prompt: "synthetic prompt one", occurred_at: BASE + 1_000 },
    { ...(await fixture("pre-tool-use-shell")), ...ids, turn_id: "turn-c-1", tool_input: { command: ["ls"] }, occurred_at: BASE + 2_000 },
    {
      ...(await fixture("post-tool-use-success")),
      ...ids,
      turn_id: "turn-c-1",
      tool_response: { success: true, exit_code: 0, stdout: "" },
      occurred_at: BASE + 2_500,
    },
    { ...stop, ...ids, turn_id: "turn-c-1", usage: usage(1_000, 100), duration_ms: 4_000, occurred_at: BASE + 5_000 },
    { ...prompt, ...ids, turn_id: "turn-c-2", prompt: "synthetic prompt two", occurred_at: TO },
    { ...stop, ...ids, turn_id: "turn-c-2", usage: usage(1_500, 160), duration_ms: 2_000, occurred_at: BASE + 12_500 },
  ];
};

const runHook = (args: readonly string[], payload: unknown): Promise<CliResult> =>
  runCliProcess(
    [
      "run",
      "--provider",
      "codex",
      // The launcher's environment still names an older attempt.
      "--resource-attr",
      "factory.attempt.id=stale-attempt",
      "--resource-attr",
      "factory.work_unit.id=wu-env",
      "--timeout-ms",
      "1000",
      "--flush-timeout-ms",
      "5000",
      ...args,
    ],
    JSON.stringify(payload),
    { timeoutMillis: 60_000 },
  );

const writeConfig = async (dir: string, config: unknown): Promise<string> => {
  const file = path.join(dir, "otel-hook.json");
  await writeFile(file, JSON.stringify(config), "utf8");
  return file;
};

const signals = (collector: Collector) => ({
  spans: decodeAllExportedSpans(
    collector.requests.filter((request) => request.path === "/v1/traces").map((request) => request.body),
  ),
  records: decodeAllExportedLogRecords(
    collector.requests.filter((request) => request.path === "/v1/logs").map((request) => request.body),
  ),
  points: decodeAllExportedMetrics(
    collector.requests.filter((request) => request.path === "/v1/metrics").map((request) => request.body),
  ),
});

const inWindow = (millis: number): boolean => millis >= FROM && millis < TO;

describe("otel-hook run: session context", () => {
  it("stamps spans, log records and metric points inside the segment, over the Resource, and nothing outside", async () => {
    const collector = await withCollector();
    const stateDir = await withStateDir();
    const contextDir = path.join(stateDir, "sessions");
    await writeContextFile(contextDir, ATTEMPT);
    const config = await writeConfig(stateDir, {
      exporter: {
        endpoint: collector.url,
        logs: { enabled: true },
        metrics: { enabled: true, temporality: "delta" },
      },
      sessionContext: { dir: contextDir },
    });

    for (const payload of await sessionPayloads()) {
      const result = await runHook(["--config-file", config, "--state-dir", stateDir], payload);
      expect(result.code).toBe(0);
    }

    const { spans, records, points } = signals(collector);
    expect(collector.text()).not.toContain("never-exported");

    // Log records carry the event's own time, so each can be placed exactly.
    const inside = records.filter((record) => inWindow(Number(record.timeUnixNanos / 1_000_000n)));
    const outside = records.filter((record) => !inWindow(Number(record.timeUnixNanos / 1_000_000n)));
    expect(inside.length).toBeGreaterThanOrEqual(3);
    expect(outside.length).toBeGreaterThanOrEqual(2);
    for (const record of inside) {
      expect(record.attributes["factory.attempt.id"]).toBe("attempt-in-context");
      expect(record.attributes["factory.work_unit.id"]).toBe("wu-ctx");
      expect(record.attributes["factory.slot.id"]).toBe("2");
      // The Resource is rewritten for the keys it already carried, and gains none.
      expect(record.resourceAttributes["factory.attempt.id"]).toBe("attempt-in-context");
      expect(record.resourceAttributes["factory.work_unit.id"]).toBe("wu-ctx");
      expect(record.resourceAttributes["factory.slot.id"]).toBeUndefined();
    }
    for (const record of outside) {
      // Before `from` and from `to` on: nothing added, the Resource as launched.
      expect(record.attributes["factory.attempt.id"]).toBe("stale-attempt");
      expect(record.attributes["factory.slot.id"]).toBeUndefined();
      expect(record.resourceAttributes["factory.attempt.id"]).toBe("stale-attempt");
    }

    const promptSpans = spans.filter((span) => span.name === "prompt");
    expect(promptSpans.map((span) => [span.startMillis, span.attributes["factory.attempt.id"]])).toEqual([
      [BASE + 1_000, "attempt-in-context"],
      [TO, "stale-attempt"],
    ]);
    const toolSpan = spans.find((span) => span.name.startsWith("tool "));
    expect(toolSpan?.attributes["factory.attempt.id"]).toBe("attempt-in-context");
    expect(toolSpan?.resourceAttributes["factory.attempt.id"]).toBe("attempt-in-context");
    const generations = spans.filter((span) => span.name.startsWith("generation"));
    expect(generations.map((span) => span.attributes["factory.attempt.id"]).sort()).toEqual([
      "attempt-in-context",
      "stale-attempt",
    ]);
    for (const span of spans) {
      expect(Object.keys(span.attributes).some((key) => key.startsWith("factory.local"))).toBe(false);
    }

    // Metric points: the tool call and turn 1's tokens are inside, the session
    // start and turn 2 outside.
    const tools = points.filter((point) => point.name === "otelhook.tool.calls");
    expect(tools.map((point) => point.attributes["factory.attempt.id"])).toEqual(["attempt-in-context"]);
    expect(tools[0]?.resourceAttributes["factory.attempt.id"]).toBe("attempt-in-context");
    const sessions = points.filter((point) => point.name === "otelhook.sessions");
    expect(sessions.map((point) => point.attributes["factory.attempt.id"])).toEqual([undefined]);
    expect(sessions[0]?.resourceAttributes["factory.attempt.id"]).toBe("stale-attempt");
    const inputTokens = points.filter(
      (point) => point.name === "gen_ai.client.token.usage" && point.attributes["gen_ai.token.type"] === "input",
    );
    expect(inputTokens.map((point) => point.attributes["factory.attempt.id"])).toEqual([
      "attempt-in-context",
      undefined,
    ]);
  }, 180_000);

  it("prefers --session-context-dir over the config file, and treats an invalid file as no context", async () => {
    const collector = await withCollector();
    const stateDir = await withStateDir();
    const fromConfig = path.join(stateDir, "config-sessions");
    const fromFlag = path.join(stateDir, "flag-sessions");
    const invalid = path.join(stateDir, "invalid-sessions");
    await writeContextFile(fromConfig, { "factory.attempt.id": "attempt-from-config" });
    await writeContextFile(fromFlag, { "factory.attempt.id": "attempt-from-flag" });
    await writeContextFile(invalid, { "factory.attempt.id": "attempt-from-v2" }, { version: 2 });
    const config = await writeConfig(stateDir, {
      exporter: { endpoint: collector.url, logs: { enabled: true } },
      sessionContext: { dir: fromConfig },
    });
    const [, prompt] = await sessionPayloads();

    let turn = 0;
    const attemptsOf = async (extra: readonly string[]): Promise<unknown[]> => {
      const before = collector.requests.length;
      // A new turn each time: the same payload twice is a redelivery, and suppressed.
      turn += 1;
      const result = await runHook(["--config-file", config, "--state-dir", stateDir, ...extra], {
        ...prompt,
        turn_id: `turn-p-${String(turn)}`,
        occurred_at: FROM + turn,
      });
      expect(result.code).toBe(0);
      const records = decodeAllExportedLogRecords(
        collector.requests
          .slice(before)
          .filter((request) => request.path === "/v1/logs")
          .map((request) => request.body),
      );
      expect(records.length).toBeGreaterThan(0);
      return [...new Set(records.map((record) => record.attributes["factory.attempt.id"]))];
    };

    expect(await attemptsOf([])).toEqual(["attempt-from-config"]);
    expect(await attemptsOf(["--session-context-dir", fromFlag])).toEqual(["attempt-from-flag"]);
    expect(await attemptsOf(["--session-context-dir", invalid])).toEqual(["stale-attempt"]);
    expect(await attemptsOf(["--session-context-dir", path.join(stateDir, "absent")])).toEqual(["stale-attempt"]);
  }, 180_000);
});
