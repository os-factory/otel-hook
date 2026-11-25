import { readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PASSING_CAPTURE,
  copyPassingCapture,
  detailsOf,
  makeTempDir,
  runChecker,
  statusOf,
} from "./harness.js";
import {
  SYNTHETIC_START,
  jsonMetricsBody,
  passingMetricPoints,
  protobufMetricsBody,
  writeCaptureRequest,
  type MetricPointSpec,
} from "./otlp-metrics.js";

/**
 * The evidence checker (scripts/e2e-proof/check-evidence.mjs) against the
 * synthetic capture in tests/fixtures/e2e-proof (see its README for provenance).
 * Each failing case is the passing capture with one edit, so a test names
 * exactly the fact that turns a matrix row red.
 */

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const PASSING_ARGS = [
  "--session-id",
  "har-synthetic-session-0001",
  "--work-unit-id",
  "synthetic-56",
  "--expect-tool",
  "Read",
  "--expect-usage",
  "input=200,output=8,cache_read=80",
];

const mutableCopy = async (): Promise<string> => {
  const temp = await makeTempDir("otel-hook-evidence-");
  cleanups.push(() => temp.remove());
  return copyPassingCapture(path.join(temp.dir, "capture"));
};

type JsonBody = Record<string, unknown>;

/** Rewrite one OTLP/JSON body in a capture copy, keeping its metadata's byte count honest. */
const editBody = async (captureDir: string, stem: string, edit: (body: JsonBody) => void): Promise<void> => {
  const bodyPath = path.join(captureDir, `${stem}.body`);
  const body = JSON.parse(await readFile(bodyPath, "utf8")) as JsonBody;
  edit(body);
  const text = JSON.stringify(body);
  await writeFile(bodyPath, text);
  const metaPath = path.join(captureDir, `${stem}.json`);
  const meta = JSON.parse(await readFile(metaPath, "utf8")) as JsonBody;
  meta.bytes = Buffer.byteLength(text);
  await writeFile(metaPath, JSON.stringify(meta));
};

type KeyValue = { key: string; value: Record<string, unknown> };
type JsonSpan = { name: string; attributes: KeyValue[] };
type JsonLog = { attributes: KeyValue[]; timeUnixNano: string };

const resourceOf = (body: JsonBody): KeyValue[] => {
  const groups = (body.resourceSpans ?? body.resourceLogs) as { resource: { attributes: KeyValue[] } }[];
  const first = groups[0];
  if (first === undefined) {
    throw new Error("fixture body has no resource");
  }
  return first.resource.attributes;
};

const spansOf = (body: JsonBody): JsonSpan[] =>
  (body.resourceSpans as { scopeSpans: { spans: JsonSpan[] }[] }[]).flatMap((group) =>
    group.scopeSpans.flatMap((scope) => scope.spans),
  );

const logsOf = (body: JsonBody): JsonLog[] =>
  (body.resourceLogs as { scopeLogs: { logRecords: JsonLog[] }[] }[]).flatMap((group) =>
    group.scopeLogs.flatMap((scope) => scope.logRecords),
  );

type JsonMetricPoint = { attributes: KeyValue[]; asInt?: string; timeUnixNano: string };
type JsonMetric = { name: string; sum?: { dataPoints: JsonMetricPoint[] }; histogram?: { dataPoints: JsonMetricPoint[] } };

const metricsOf = (body: JsonBody): JsonMetric[] =>
  (body.resourceMetrics as { scopeMetrics: { metrics: JsonMetric[] }[] }[]).flatMap((group) =>
    group.scopeMetrics.flatMap((scope) => scope.metrics),
  );

const metricResourceOf = (body: JsonBody): KeyValue[] => {
  const first = (body.resourceMetrics as { resource: { attributes: KeyValue[] } }[])[0];
  if (first === undefined) {
    throw new Error("fixture metrics body has no resource");
  }
  return first.resource.attributes;
};

const pointsOf = (metric: JsonMetric | undefined): JsonMetricPoint[] => {
  if (metric === undefined) {
    throw new Error("fixture is missing a metric");
  }
  return (metric.sum ?? metric.histogram)?.dataPoints ?? [];
};

/** Edit the metadata of one request in a capture copy. */
const editMeta = async (captureDir: string, stem: string, edit: (meta: JsonBody) => void): Promise<void> => {
  const metaPath = path.join(captureDir, `${stem}.json`);
  const meta = JSON.parse(await readFile(metaPath, "utf8")) as JsonBody;
  edit(meta);
  await writeFile(metaPath, JSON.stringify(meta));
};

const removeMetrics = async (captureDir: string): Promise<void> => {
  for (const stem of ["0007-metrics", "0008-metrics", "0009-metrics"]) {
    await rm(path.join(captureDir, `${stem}.json`));
    await rm(path.join(captureDir, `${stem}.body`));
  }
};

/** A capture holding only metrics requests, protobuf unless `json` is set. */
const metricsCapture = async (
  requests: readonly (readonly MetricPointSpec[])[],
  options: { readonly json?: boolean } = {},
): Promise<string> => {
  const temp = await makeTempDir("otel-hook-metrics-");
  cleanups.push(() => temp.remove());
  const captureDir = path.join(temp.dir, "capture");
  for (const [index, points] of requests.entries()) {
    await writeCaptureRequest(
      captureDir,
      index + 1,
      options.json === true ? jsonMetricsBody(points) : protobufMetricsBody(points),
      { contentType: options.json === true ? "application/json" : "application/x-protobuf" },
    );
  }
  return captureDir;
};

const METRICS_ARGS = ["--expect-metrics", "--expect-tool", "shell", "--expect-usage", "input=200,output=8,cache_read=80,cache_creation=0"];

const setAttribute = (attributes: KeyValue[], key: string, value: Record<string, unknown>): void => {
  const existing = attributes.find((entry) => entry.key === key);
  if (existing === undefined) {
    attributes.push({ key, value });
  } else {
    existing.value = value;
  }
};

describe("check-evidence: the passing synthetic capture", () => {
  it("passes every mechanical row and reports the manual ones", async () => {
    const { code, result } = await runChecker([PASSING_CAPTURE, ...PASSING_ARGS, "--provider", "claude-code"]);

    expect(code).toBe(0);
    expect(result?.ok).toBe(true);
    expect(result?.schema).toBe("otel-hook.e2e-proof.evidence/v1");
    expect(result?.provider).toBe("claude-code");
    for (const id of ["capture-integrity", "session-span", "profile-attributes", "tool-spans", "token-usage", "logs-signal", "metrics", "spool-replay", "privacy"]) {
      expect({ id, status: statusOf(result, id) }).toEqual({ id, status: "pass" });
    }
    expect(statusOf(result, "headers-auth")).toBe("manual");
    expect(statusOf(result, "trace-proof")).toBe("manual");
    expect(statusOf(result, "multi-destination")).toBe("skip");
    // The empty body is evidence, recorded rather than dropped.
    expect(result?.summary.emptyRequests).toEqual([1]);
    expect(result?.summary.rejectedRequests).toEqual([3]);
    expect(result?.summary.launcherSessionIds).toEqual(["har-synthetic-session-0001"]);
  }, 30_000);

  it("renders a markdown snippet with one line per matrix row", async () => {
    const { code, stdout } = await runChecker([PASSING_CAPTURE, ...PASSING_ARGS, "--markdown"]);

    expect(code).toBe(0);
    expect(stdout).toContain("Result: **PASS**");
    expect(stdout).toContain("| Row | Check | Result | Evidence |");
    expect(stdout).toContain("| Session span with the launcher's `session.id` | `session-span` | PASS |");
    expect(stdout).toContain("| Trace ↔ Factory Commits proof correlation | `trace-proof` | manual |");
    expect(stdout).toContain("empty bodies: #1");
  }, 30_000);

  it("writes the JSON and markdown files when asked", async () => {
    const temp = await makeTempDir("otel-hook-evidence-out-");
    cleanups.push(() => temp.remove());
    const jsonOut = path.join(temp.dir, "evidence.json");
    const markdownOut = path.join(temp.dir, "evidence.md");

    const { code } = await runChecker([PASSING_CAPTURE, ...PASSING_ARGS, "--json-out", jsonOut, "--markdown-out", markdownOut]);

    expect(code).toBe(0);
    expect((JSON.parse(await readFile(jsonOut, "utf8")) as { ok: boolean }).ok).toBe(true);
    expect(await readFile(markdownOut, "utf8")).toContain("#### Receiver capture");
  }, 30_000);

  it("compares a second destination's capture", async () => {
    const same = await runChecker([PASSING_CAPTURE, PASSING_CAPTURE, ...PASSING_ARGS]);
    expect(statusOf(same.result, "multi-destination")).toBe("pass");

    const second = await mutableCopy();
    await rm(path.join(second, "0006-traces.json"));
    const differs = await runChecker([PASSING_CAPTURE, second, ...PASSING_ARGS]);
    expect(differs.code).toBe(1);
    expect(statusOf(differs.result, "multi-destination")).toBe("fail");
  }, 30_000);
});

describe("check-evidence: one edit away from passing", () => {
  it("fails the session row when the session span lacks the launcher's id", async () => {
    const { code, result } = await runChecker([PASSING_CAPTURE, ...PASSING_ARGS.slice(2), "--session-id", "har-some-other-session"]);

    expect(code).toBe(1);
    expect(statusOf(result, "session-span")).toBe("fail");
  }, 30_000);

  it("fails the session row when no session span was delivered", async () => {
    const capture = await mutableCopy();
    await rm(path.join(capture, "0006-traces.json"));

    const { result } = await runChecker([capture, ...PASSING_ARGS]);

    expect(statusOf(result, "session-span")).toBe("fail");
  }, 30_000);

  it("fails the profile row when a required profile attribute is missing", async () => {
    const capture = await mutableCopy();
    await editBody(capture, "0005-logs", (body) => {
      const resource = resourceOf(body);
      resource.splice(resource.findIndex((entry) => entry.key === "factory.work_unit.id"), 1);
    });

    const { result } = await runChecker([capture, ...PASSING_ARGS]);

    expect(statusOf(result, "profile-attributes")).toBe("fail");
    expect(detailsOf(result, "profile-attributes")).toContain("`factory.work_unit.id` missing on 4/9 records");
  }, 30_000);

  it("fails the tool row when an expected tool has no span", async () => {
    const { result } = await runChecker([PASSING_CAPTURE, ...PASSING_ARGS, "--expect-tool", "Bash"]);

    expect(statusOf(result, "tool-spans")).toBe("fail");
    expect(detailsOf(result, "tool-spans")).toContain("`Bash`");
  }, 30_000);

  it("fails the usage row when summed deltas disagree with the agent's own totals", async () => {
    const { result } = await runChecker([PASSING_CAPTURE, ...PASSING_ARGS.slice(0, -1), "input=220,output=32"]);

    expect(statusOf(result, "token-usage")).toBe("fail");
    expect(detailsOf(result, "token-usage")).toContain("exported input tokens 200 ≠ expected 220");
  }, 30_000);

  it("counts a session's running totals once rather than summing them", async () => {
    const capture = await mutableCopy();
    await editBody(capture, "0004-traces", (body) => {
      for (const span of spansOf(body)) {
        if (span.name.startsWith("generation")) {
          setAttribute(span.attributes, "otelhook.usage.temporality", { stringValue: "cumulative" });
        }
      }
    });

    const { result } = await runChecker([capture, ...PASSING_ARGS]);

    expect(statusOf(result, "token-usage")).toBe("pass");
    expect(detailsOf(result, "token-usage")).toContain("generation spans: 0 delta, 1 cumulative");
  }, 30_000);

  it("fails the usage row when usage has no temporality", async () => {
    const capture = await mutableCopy();
    await editBody(capture, "0004-traces", (body) => {
      for (const span of spansOf(body)) {
        span.attributes = span.attributes.filter((entry) => entry.key !== "otelhook.usage.temporality");
      }
    });

    const { result } = await runChecker([capture, ...PASSING_ARGS]);

    expect(statusOf(result, "token-usage")).toBe("fail");
  }, 30_000);

  it("fails the usage row when a cumulative total goes down", async () => {
    const capture = await mutableCopy();
    await editBody(capture, "0005-logs", (body) => {
      const logs = logsOf(body);
      const generationEnd = logs.find((log) => log.attributes.some((entry) => entry.value.stringValue === "generation.end"));
      const sessionEnd = logs.find((log) => log.attributes.some((entry) => entry.value.stringValue === "session.end"));
      if (generationEnd === undefined || sessionEnd === undefined) {
        throw new Error("fixture is missing its generation.end or session.end log");
      }
      setAttribute(generationEnd.attributes, "otelhook.usage.temporality", { stringValue: "cumulative" });
      setAttribute(sessionEnd.attributes, "otelhook.usage.temporality", { stringValue: "cumulative" });
      setAttribute(sessionEnd.attributes, "gen_ai.usage.input_tokens", { intValue: "150" });
      setAttribute(sessionEnd.attributes, "gen_ai.usage.output_tokens", { intValue: "8" });
    });

    const { result } = await runChecker([capture, ...PASSING_ARGS]);

    expect(statusOf(result, "token-usage")).toBe("fail");
    expect(detailsOf(result, "token-usage")).toContain("cumulative input went down (200 → 150)");
  }, 30_000);

  it("fails the logs row when no log record was delivered", async () => {
    const capture = await mutableCopy();
    await rm(path.join(capture, "0002-logs.json"));
    await rm(path.join(capture, "0005-logs.json"));

    const { result } = await runChecker([capture, ...PASSING_ARGS]);

    expect(statusOf(result, "logs-signal")).toBe("fail");
  }, 30_000);

  it("fails spool replay when a rejected batch never arrives later", async () => {
    const capture = await mutableCopy();
    await rm(path.join(capture, "0004-traces.json"));

    const { result } = await runChecker([capture, ...PASSING_ARGS]);

    expect(statusOf(result, "spool-replay")).toBe("fail");
  }, 30_000);

  it("fails privacy on factory.local.*, local paths and account identity, without echoing them", async () => {
    const capture = await mutableCopy();
    const localPath = "/home/synthetic-person/checkouts/sandbox";
    const email = "synthetic.person@example.invalid";
    await editBody(capture, "0006-traces", (body) => {
      setAttribute(resourceOf(body), "factory.local.checkout_path", { stringValue: localPath });
      const span = spansOf(body)[0];
      if (span === undefined) {
        throw new Error("fixture has no session span");
      }
      setAttribute(span.attributes, "user.email", { stringValue: email });
    });

    const { code, stdout, result } = await runChecker([capture, ...PASSING_ARGS]);

    expect(code).toBe(1);
    expect(statusOf(result, "privacy")).toBe("fail");
    const details = detailsOf(result, "privacy");
    expect(details).toContain("`factory.local.checkout_path` exported (resource) in request #6");
    expect(details).toContain("account-identity key `user.email`");
    expect(details).toContain("absolute path in `factory.local.checkout_path`");
    expect(details).toContain("email-shaped value in request #6");
    // The report itself is safe to paste into a public issue.
    expect(stdout).not.toContain(localPath);
    expect(stdout).not.toContain("synthetic-person");
    expect(stdout).not.toContain(email);
  }, 30_000);

  it("fails privacy on credentials in a repository URL", async () => {
    const capture = await mutableCopy();
    await editBody(capture, "0006-traces", (body) => {
      setAttribute(resourceOf(body), "vcs.repository.url.full", { stringValue: "https://synthetic:token@example.invalid/sandbox.git" });
    });

    const { result } = await runChecker([capture, ...PASSING_ARGS]);

    expect(statusOf(result, "privacy")).toBe("fail");
    expect(detailsOf(result, "privacy")).toContain("URL with embedded credentials");
  }, 30_000);

  it("fails privacy on a caller-supplied forbidden value, naming it only by position", async () => {
    const { code, stdout, result } = await runChecker([PASSING_CAPTURE, ...PASSING_ARGS, "--forbid", "proof/synthetic"]);

    expect(code).toBe(1);
    expect(detailsOf(result, "privacy")).toContain("forbidden value #1 (15 chars)");
    expect(stdout).not.toContain("proof/synthetic");
  }, 30_000);

  it("rejects a malformed --expect-usage as a usage error", async () => {
    const { code, stderr } = await runChecker([PASSING_CAPTURE, "--expect-usage", "inputs=1"]);

    expect(code).toBe(2);
    expect(stderr).toContain("--expect-usage");
  }, 30_000);
});

describe("check-evidence: metrics", () => {
  it("passes the synthetic capture's cumulative metrics, counting a re-sent snapshot once", async () => {
    const { result } = await runChecker([PASSING_CAPTURE, ...PASSING_ARGS]);

    expect(statusOf(result, "metrics")).toBe("pass");
    const details = detailsOf(result, "metrics");
    expect(details).toContain("`gen_ai.client.token.usage`: 8 point(s), histogram, unit `{token}`, cumulative");
    expect(details).toContain("`otelhook.tool.calls`: 3 point(s), sum, unit `{call}`, cumulative");
    expect(details).toContain("identical point(s) re-sent (spool replay or retry), counted once");
    expect(details).toContain("token usage totals: input=200, output=8, cache_read=80, cache_creation=0");
    expect(details).toContain("16/16 metric points carry `session.id`=`har-synthetic-session-0001`");
  }, 30_000);

  it("decodes protobuf metrics and takes each cumulative series' last running total", async () => {
    const capture = await metricsCapture([
      passingMetricPoints("cumulative", SYNTHETIC_START + 3, { input: 120, output: 5, cache_read: 50, cache_creation: 0 }),
      passingMetricPoints("cumulative", SYNTHETIC_START + 5),
      passingMetricPoints("cumulative", SYNTHETIC_START + 5),
    ]);

    const { result } = await runChecker([capture, ...METRICS_ARGS]);

    expect({ status: statusOf(result, "metrics"), details: detailsOf(result, "metrics") }).toMatchObject({ status: "pass" });
    expect(detailsOf(result, "metrics")).toContain("token usage totals: input=200, output=8, cache_read=80, cache_creation=0");
    expect(detailsOf(result, "metrics")).toContain("tool call series: `shell`");
  }, 30_000);

  it("sums OTLP/JSON delta points once per point identity", async () => {
    const second = passingMetricPoints("delta", SYNTHETIC_START + 5, { input: 80, output: 3, cache_read: 30, cache_creation: 0 });
    const capture = await metricsCapture(
      [passingMetricPoints("delta", SYNTHETIC_START + 3, { input: 120, output: 5, cache_read: 50, cache_creation: 0 }), second, second],
      { json: true },
    );

    const { result } = await runChecker([capture, ...METRICS_ARGS]);

    expect({ status: statusOf(result, "metrics"), details: detailsOf(result, "metrics") }).toMatchObject({ status: "pass" });
    expect(detailsOf(result, "metrics")).toContain("token usage totals: input=200, output=8, cache_read=80, cache_creation=0");
    expect(detailsOf(result, "metrics")).toContain("delta");
  }, 30_000);

  it("fails when a cumulative series goes down", async () => {
    const capture = await metricsCapture([
      passingMetricPoints("cumulative", SYNTHETIC_START + 3),
      passingMetricPoints("cumulative", SYNTHETIC_START + 5, { input: 150, output: 8, cache_read: 80, cache_creation: 0 }),
    ]);

    const { code, result } = await runChecker([capture, "--expect-metrics"]);

    expect(code).toBe(1);
    expect(statusOf(result, "metrics")).toBe("fail");
    expect(detailsOf(result, "metrics")).toContain("cumulative `gen_ai.client.token.usage` sum went down (200 → 150)");
  }, 30_000);

  it("allows a reset with a newer start time and adds the runs up", async () => {
    const capture = await metricsCapture([
      passingMetricPoints("cumulative", SYNTHETIC_START + 3),
      passingMetricPoints("cumulative", SYNTHETIC_START + 9, { input: 50, output: 2, cache_read: 0, cache_creation: 0 }).map((point) => ({
        ...point,
        start: SYNTHETIC_START + 6,
      })),
    ]);

    const { result } = await runChecker([capture, "--expect-metrics", "--expect-usage", "input=250,output=10"]);

    expect({ status: statusOf(result, "metrics"), details: detailsOf(result, "metrics") }).toMatchObject({ status: "pass" });
    expect(detailsOf(result, "metrics")).toContain("cumulative reset(s): a series restarted with a newer start time");
  }, 30_000);

  it("fails when the token totals disagree with the agent's own report", async () => {
    const { result } = await runChecker([PASSING_CAPTURE, ...PASSING_ARGS.slice(0, -1), "input=220,output=8,cache_read=80"]);

    expect(statusOf(result, "metrics")).toBe("fail");
    expect(detailsOf(result, "metrics")).toContain("metric input tokens 200 ≠ expected 220");
  }, 30_000);

  it("fails when an expected tool has no tool call series", async () => {
    const { result } = await runChecker([PASSING_CAPTURE, ...PASSING_ARGS, "--expect-tool", "Bash"]);

    expect(statusOf(result, "metrics")).toBe("fail");
    expect(detailsOf(result, "metrics")).toContain("expected tool(s) without an `otelhook.tool.calls` series: `Bash`");
  }, 30_000);

  it("fails when a metric does not match its contract", async () => {
    const capture = await metricsCapture([
      passingMetricPoints("cumulative", SYNTHETIC_START + 3).map((point) =>
        point.name === "otelhook.sessions" ? { ...point, kind: "gauge" as const } : point,
      ),
    ]);

    const { result } = await runChecker([capture, "--expect-metrics"]);

    expect(statusOf(result, "metrics")).toBe("fail");
    expect(detailsOf(result, "metrics")).toContain("`otelhook.sessions` is a gauge, expected a sum");
  }, 30_000);

  it("is skipped without metrics, unless metrics are expected", async () => {
    const capture = await mutableCopy();
    await removeMetrics(capture);

    const skipped = await runChecker([capture, ...PASSING_ARGS]);
    expect(skipped.code).toBe(0);
    expect(statusOf(skipped.result, "metrics")).toBe("skip");

    const required = await runChecker([capture, ...PASSING_ARGS, "--expect-metrics"]);
    expect(required.code).toBe(1);
    expect(statusOf(required.result, "metrics")).toBe("fail");

    const named = await runChecker([capture, ...PASSING_ARGS, "--expect-metric", "otelhook.tool.calls"]);
    expect(statusOf(named.result, "metrics")).toBe("fail");
  }, 30_000);

  it("replaces the required metric list with --expect-metric", async () => {
    const extra = await runChecker([PASSING_CAPTURE, ...PASSING_ARGS, "--expect-metric", "otelhook.cost.usage"]);
    expect(statusOf(extra.result, "metrics")).toBe("fail");
    expect(detailsOf(extra.result, "metrics")).toContain("expected metric(s) without a delivered point: `otelhook.cost.usage`");

    const capture = await metricsCapture([
      passingMetricPoints("cumulative", SYNTHETIC_START + 3).filter((point) => point.name === "gen_ai.client.token.usage"),
    ]);
    const narrowed = await runChecker([capture, "--expect-metric", "gen_ai.client.token.usage"]);
    expect({ status: statusOf(narrowed.result, "metrics"), details: detailsOf(narrowed.result, "metrics") }).toMatchObject({ status: "pass" });
  }, 30_000);

  it("fails privacy on account identity in metric attributes, without echoing it", async () => {
    const capture = await mutableCopy();
    const email = "synthetic.person@example.invalid";
    await editBody(capture, "0008-metrics", (body) => {
      setAttribute(metricResourceOf(body), "organization.id", { stringValue: "org-synthetic" });
      const point = pointsOf(metricsOf(body).find((metric) => metric.name === "otelhook.tool.calls"))[0];
      if (point === undefined) {
        throw new Error("fixture has no tool call point");
      }
      setAttribute(point.attributes, "user.email", { stringValue: email });
      setAttribute(point.attributes, "user.account_uuid", { stringValue: "acct-synthetic" });
    });

    const { code, stdout, result } = await runChecker([capture, ...PASSING_ARGS]);

    expect(code).toBe(1);
    expect(statusOf(result, "privacy")).toBe("fail");
    const details = detailsOf(result, "privacy");
    expect(details).toContain("account-identity key `user.email` exported (record) in request #8");
    expect(details).toContain("account-identity key `user.account_uuid` exported (record) in request #8");
    expect(details).toContain("account-identity key `organization.id` exported (resource) in request #8");
    expect(details).toContain("email-shaped value in request #8");
    expect(stdout).not.toContain(email);
  }, 30_000);

  it("compares metric points across destinations", async () => {
    const second = await mutableCopy();
    await rm(path.join(second, "0007-metrics.json"));

    const { result } = await runChecker([PASSING_CAPTURE, second, ...PASSING_ARGS]);

    expect(statusOf(result, "multi-destination")).toBe("fail");
    expect(detailsOf(result, "multi-destination")).toContain("metric points differ: 2 only in the first, 0 only in");
  }, 30_000);

  it("accepts a later running total as the replay of a rejected metrics request", async () => {
    const capture = await mutableCopy();
    await editMeta(capture, "0007-metrics", (meta) => {
      meta.responseStatus = 503;
      meta.injectedFailure = true;
    });

    const replayed = await runChecker([capture, ...PASSING_ARGS]);
    expect(statusOf(replayed.result, "spool-replay")).toBe("pass");
    expect(detailsOf(replayed.result, "spool-replay")).toContain("holding 3 record(s)");

    await rm(path.join(capture, "0008-metrics.json"));
    await rm(path.join(capture, "0009-metrics.json"));
    const lost = await runChecker([capture, ...PASSING_ARGS]);
    expect(statusOf(lost.result, "spool-replay")).toBe("fail");
  }, 30_000);
});
