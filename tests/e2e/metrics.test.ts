/**
 * Hook-derived metrics (issue #69), end to end through the built CLI.
 *
 * Every receiver is a local, ephemeral HTTP server. Every payload is a synthetic
 * Codex hook payload built from `tests/fixtures/codex/hooks/` (see its
 * PROVENANCE.md) with test-only session ids. Nothing comes from a real session.
 *
 * Codex is the interesting provider here: it reports the session's *running*
 * token total on every `Stop`, so a metric that summed what the hook reported
 * would double count. The token histogram must reflect the per-turn deltas.
 */
import { readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

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
  readonly unit: string;
  readonly type: string;
  readonly temporality: string;
  readonly monotonic?: boolean;
  readonly value?: number;
  readonly histogram?: {
    readonly count: number;
    readonly sum: number;
    readonly bucketCounts: readonly number[];
  };
  readonly startTimeUnixNanos: bigint;
  readonly timeUnixNanos: bigint;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly resourceAttributes: Readonly<Record<string, unknown>>;
};

let decodeAllExportedMetrics: (bodies: readonly Buffer[]) => DecodedMetricPoint[];

beforeAll(async () => {
  await ensureBuiltCli();
  const decoderUrl = pathToFileURL(path.join(REPO_ROOT, "scripts", "e2e-proof", "otlp-decode.mjs")).href;
  const decoder = (await import(decoderUrl)) as {
    decodeAllExportedMetrics: typeof decodeAllExportedMetrics;
  };
  decodeAllExportedMetrics = decoder.decodeAllExportedMetrics;
}, 300_000);

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const withCollector = async (respond?: Parameters<typeof startCollector>[0]): Promise<Collector> => {
  const collector = await startCollector(respond);
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

const SESSION = "codex-metrics-e2e-session";
const LAUNCHER_SESSION = "launcher-session-key-69";

/**
 * One two-turn Codex session. Turn 1 reports a running total of 1 000 in / 100
 * out and states its duration; turn 2 reports 1 500 / 160 and states none, so its
 * duration is measured from turn 2's `UserPromptSubmit`, recorded by an earlier
 * hook process (Codex has no generation start edge; a turn is its generation).
 */
const sessionPayloads = async (): Promise<readonly Record<string, unknown>[]> => {
  const ids = { session_id: SESSION, cwd: "/workspace/fixture-repo" };
  const start = { ...(await fixture("session-start")), ...ids, occurred_at: 1_800_000_000_000 };
  const prompt = await fixture("user-prompt-submit");
  const preTool = await fixture("pre-tool-use-shell");
  const postTool = await fixture("post-tool-use-success");
  const stop = await fixture("stop");
  const usage = (input: number, output: number) => ({
    input_tokens: input,
    cached_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + output,
  });
  return [
    start,
    { ...prompt, ...ids, turn_id: "turn-m-1", prompt: "synthetic prompt one", occurred_at: 1_800_000_001_000 },
    { ...preTool, ...ids, turn_id: "turn-m-1", tool_input: { command: ["ls"] }, occurred_at: 1_800_000_002_000 },
    { ...postTool, ...ids, turn_id: "turn-m-1", tool_response: { success: true, exit_code: 0, stdout: "" }, occurred_at: 1_800_000_002_500 },
    { ...stop, ...ids, turn_id: "turn-m-1", usage: usage(1_000, 100), duration_ms: 4_000, occurred_at: 1_800_000_005_000 },
    { ...prompt, ...ids, turn_id: "turn-m-2", prompt: "synthetic prompt two", occurred_at: 1_800_000_010_000 },
    {
      ...Object.fromEntries(Object.entries(stop).filter(([key]) => key !== "duration_ms")),
      ...ids,
      turn_id: "turn-m-2",
      usage: usage(1_500, 160),
      occurred_at: 1_800_000_012_500,
    },
  ];
};

const runHook = (config: string, stateDir: string, payload: unknown): Promise<CliResult> =>
  runCliProcess(
    [
      "run",
      "--provider",
      "codex",
      "--config-file",
      config,
      "--state-dir",
      stateDir,
      "--resource-attr",
      `session.id=${LAUNCHER_SESSION}`,
      "--resource-attr",
      "user.email=someone@example.invalid",
      "--timeout-ms",
      "1000",
      "--flush-timeout-ms",
      "5000",
    ],
    JSON.stringify(payload),
    { timeoutMillis: 60_000 },
  );

const writeConfig = async (dir: string, config: unknown): Promise<string> => {
  const file = path.join(dir, "otel-hook.json");
  await writeFile(file, JSON.stringify(config), "utf8");
  return file;
};

const metricsOf = (collector: Collector): DecodedMetricPoint[] =>
  decodeAllExportedMetrics(
    collector.requests.filter((request) => request.path === "/v1/metrics").map((request) => request.body),
  );

const runSession = async (config: string, stateDir: string): Promise<void> => {
  for (const payload of await sessionPayloads()) {
    const result = await runHook(config, stateDir, payload);
    expect(result.code).toBe(0);
  }
};

/** Last point of each series, by arrival: the session's running totals. */
const finalPoints = (points: readonly DecodedMetricPoint[]): DecodedMetricPoint[] => {
  const last = new Map<string, DecodedMetricPoint>();
  for (const point of points) {
    const attributes = Object.entries(point.attributes).sort(([a], [b]) => a.localeCompare(b));
    last.set(JSON.stringify([point.name, attributes]), point);
  }
  return [...last.values()];
};

const tokenTotal = (points: readonly DecodedMetricPoint[], tokenType: string): number =>
  points
    .filter((point) => point.name === "gen_ai.client.token.usage" && point.attributes["gen_ai.token.type"] === tokenType)
    .reduce((sum, point) => sum + (point.histogram?.sum ?? 0), 0);

describe("otel-hook run: hook-derived metrics", () => {
  it("sends cumulative token, duration, session and tool-call metrics only to a metrics destination", async () => {
    const metricsCollector = await withCollector();
    const tracesOnly = await withCollector();
    const stateDir = await withStateDir();
    const config = await writeConfig(stateDir, {
      exporter: {
        destinations: [
          { name: "with-metrics", endpoint: metricsCollector.url, signals: ["traces", "metrics"] },
          { name: "traces-only", endpoint: tracesOnly.url, signals: ["traces"] },
        ],
      },
    });

    await runSession(config, stateDir);

    expect(tracesOnly.requests.some((request) => request.path === "/v1/metrics")).toBe(false);
    expect(tracesOnly.requests.some((request) => request.path === "/v1/traces")).toBe(true);

    const points = metricsOf(metricsCollector);
    const names = new Set(points.map((point) => point.name));
    expect([...names].sort()).toEqual([
      "gen_ai.client.operation.duration",
      "gen_ai.client.token.usage",
      "otelhook.sessions",
      "otelhook.tool.calls",
    ]);
    expect(points.every((point) => point.temporality === "cumulative")).toBe(true);

    const final = finalPoints(points);
    // Running totals reported per turn are diffed, not summed: 1 500 in, not 2 500.
    expect(tokenTotal(final, "input")).toBe(1_500);
    expect(tokenTotal(final, "output")).toBe(160);
    const inputSeries = final.filter(
      (point) => point.name === "gen_ai.client.token.usage" && point.attributes["gen_ai.token.type"] === "input",
    );
    expect(inputSeries.map((point) => point.histogram?.count)).toEqual([2]);

    const duration = final.find((point) => point.name === "gen_ai.client.operation.duration");
    expect(duration?.unit).toBe("s");
    // Turn 1 states 4 s; turn 2 is measured from its prompt, 2.5 s earlier, in another process.
    expect(duration?.histogram?.count).toBe(2);
    expect(duration?.histogram?.sum).toBeCloseTo(6.5, 5);

    const sessions = final.find((point) => point.name === "otelhook.sessions");
    expect(sessions?.value).toBe(1);
    expect(sessions?.monotonic).toBe(true);
    const tools = final.filter((point) => point.name === "otelhook.tool.calls");
    expect(tools.map((point) => [point.attributes["gen_ai.tool.name"], point.attributes["otelhook.outcome"], point.value])).toEqual([
      ["shell", "ok", 1],
    ]);

    for (const point of points) {
      expect(point.attributes["session.id"]).toBe(LAUNCHER_SESSION);
      expect(point.attributes["otelhook.provider.id"]).toBe("codex");
      const keys = [...Object.keys(point.attributes), ...Object.keys(point.resourceAttributes)];
      expect(keys.filter((key) => /^(user|enduser|organization)\./.test(key))).toEqual([]);
    }
    expect(metricsCollector.textFor("/v1/metrics")).not.toContain("someone@example.invalid");
    expect(metricsCollector.textFor("/v1/metrics")).not.toContain("synthetic prompt");

    // Cumulative series never decrease and keep their start time.
    const bySeries = new Map<string, DecodedMetricPoint[]>();
    for (const point of points) {
      const key = JSON.stringify([point.name, Object.entries(point.attributes).sort(([a], [b]) => a.localeCompare(b))]);
      bySeries.set(key, [...(bySeries.get(key) ?? []), point]);
    }
    for (const series of bySeries.values()) {
      const starts = new Set(series.map((point) => point.startTimeUnixNanos));
      expect(starts.size).toBe(1);
      const values = series.map((point) => point.histogram?.count ?? point.value ?? 0);
      expect(values).toEqual([...values].sort((a, b) => a - b));
    }
  }, 180_000);

  it("exports per-callback deltas with metrics.temporality delta, and no metrics by default", async () => {
    const deltaCollector = await withCollector();
    const defaultCollector = await withCollector();
    const stateDir = await withStateDir();
    const deltaConfig = await writeConfig(stateDir, {
      exporter: {
        endpoint: deltaCollector.url,
        metrics: { enabled: true, temporality: "delta", includeSessionId: false },
      },
    });
    await runSession(deltaConfig, stateDir);

    const points = metricsOf(deltaCollector);
    expect(points.length).toBeGreaterThan(0);
    expect(points.every((point) => point.temporality === "delta")).toBe(true);
    expect(tokenTotal(points, "input")).toBe(1_500);
    expect(tokenTotal(points, "output")).toBe(160);
    expect(points.some((point) => "session.id" in point.attributes)).toBe(false);

    const otherState = await withStateDir();
    const defaultConfig = await writeConfig(otherState, { exporter: { endpoint: defaultCollector.url } });
    await runSession(defaultConfig, otherState);
    expect(defaultCollector.requests.some((request) => request.path === "/v1/metrics")).toBe(false);
    expect(defaultCollector.requests.some((request) => request.path === "/v1/traces")).toBe(true);
  }, 180_000);

  it("spools metrics a destination refused and replays them on the next invocation", async () => {
    let refuse = true;
    const collector = await withCollector((request) => ({
      status: request.path === "/v1/metrics" && refuse ? 503 : 200,
    }));
    const stateDir = await withStateDir();
    const config = await writeConfig(stateDir, {
      exporter: { destinations: [{ name: "flaky", endpoint: collector.url, signals: ["metrics"] }] },
    });
    const payloads = await sessionPayloads();
    const [start, ...rest] = payloads;
    expect((await runHook(config, stateDir, start)).code).toBe(0);
    const refused = collector.requests.filter((request) => request.path === "/v1/metrics").length;
    expect(refused).toBeGreaterThan(0);

    refuse = false;
    for (const payload of rest) {
      expect((await runHook(config, stateDir, payload)).code).toBe(0);
    }
    const delivered = metricsOf({
      ...collector,
      requests: collector.requests.slice(refused),
    });
    // The session counter recorded during the outage arrived later, from the spool.
    expect(delivered.some((point) => point.name === "otelhook.sessions" && point.value === 1)).toBe(true);
    // A metrics-only destination receives no traces.
    expect(collector.requests.some((request) => request.path === "/v1/traces")).toBe(false);
  }, 180_000);
});
