import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, type OtelHookConfig } from "../../src/config/schema.js";
import { createHookRuntime, type HookRuntime } from "../../src/integration/hook-runtime.js";
import { createProviderRegistry } from "../../src/providers/registry.js";
import { createClaudeCodeAdapter } from "../../src/providers/claude/adapter.js";
import { createSystemClock } from "../../src/runtime/clock.js";
import { createRecordingLogger } from "../../src/runtime/memory.js";
import { startCapturingCollector, type CapturingCollector } from "../helpers/collector.js";
import {
  decodeAllExportedLogRecords,
  decodeAllExportedSpans,
  type DecodedLogRecord,
  type DecodedSpan,
} from "../helpers/otlp.js";

/**
 * Logs and traces driven together through the real runtime, against a real
 * collector.
 *
 * The property under test is that a log record's `spanContext` names a span the
 * trace pipeline actually exported — not a plausible re-derivation of one. That
 * cannot be checked at the mapping layer, because the two things that make it hard
 * are both runtime concerns: the span correlator *writes* state (so it must be
 * consulted exactly once per batch), and a `*.start` edge exports no span at all
 * (so a record on that edge must point forward to the id the end edge will publish).
 *
 * Each `runOnce` is a separate short-lived hook process over a shared state root,
 * exactly as a coding agent invokes the CLI — no correlator, sink, or lock is
 * carried across the boundary.
 */

const PROVIDER = "claude-code";
const INSTALLATION = "install-logs";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const stateRoot = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), "otel-hook-log-correlation-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

const collectorFor = async (): Promise<CapturingCollector> => {
  const collector = await startCapturingCollector();
  cleanups.push(() => collector.close());
  return collector;
};

const configFor = (collector: CapturingCollector, includeContent: boolean): OtelHookConfig => ({
  ...DEFAULT_CONFIG,
  exporter: {
    ...DEFAULT_CONFIG.exporter,
    endpoint: collector.url,
    timeoutMillis: 5_000,
    maxRetryAttempts: 0,
    logs: { ...DEFAULT_CONFIG.exporter.logs, enabled: true, includeContent },
  },
  ...(includeContent
    ? { privacy: { ...DEFAULT_CONFIG.privacy, contentMode: "redact" as const } }
    : {}),
});

/**
 * Run one hook callback in its own runtime, then shut it down.
 *
 * Returning after `shutdown` is what makes the next call a genuinely separate
 * process from the correlator's point of view.
 */
const runOnce = async (
  rootDir: string,
  collector: CapturingCollector,
  payload: Record<string, unknown>,
  options: { readonly includeContent?: boolean } = {},
): Promise<{ readonly runtime: HookRuntime; readonly logs: readonly string[] }> => {
  const logger = createRecordingLogger();
  const runtime = createHookRuntime({
    config: configFor(collector, options.includeContent ?? false),
    registry: createProviderRegistry([createClaudeCodeAdapter()]),
    stateRootDir: rootDir,
    installationId: INSTALLATION,
    providerNamespace: PROVIDER,
    clock: createSystemClock(),
    logger,
  });
  await runtime.process({ payload, transport: "hook-stdin", providerHint: PROVIDER });
  await runtime.shutdown();
  return { runtime, logs: logger.records().map((record) => record.message) };
};

const decoded = (
  collector: CapturingCollector,
): { readonly spans: readonly DecodedSpan[]; readonly records: readonly DecodedLogRecord[] } => ({
  spans: decodeAllExportedSpans(collector.bodiesFor("/v1/traces")),
  records: decodeAllExportedLogRecords(collector.bodiesFor("/v1/logs")),
});

const toolPayload = (sessionId: string, event: string, extra: Record<string, unknown> = {}) => ({
  hook_event_name: event,
  session_id: sessionId,
  cwd: "/workspace/fixture-repo",
  tool_use_id: "toolu_correlation_1",
  tool_name: "Bash",
  tool_input: { command: "npm test" },
  ...extra,
});

describe("log records correlate to the spans the trace pipeline exported", () => {
  it("pairs a start-edge record with the span id the end edge publishes", async () => {
    const rootDir = await stateRoot();
    const collector = await collectorFor();

    // First process: the `PreToolUse` edge. The span is deferred — the correlator
    // recorded the start and the end edge will publish the completed span — so this
    // invocation exports a log record and no span at all.
    await runOnce(rootDir, collector, toolPayload("ses-corr-1", "PreToolUse"));
    const afterStart = decoded(collector);
    expect(afterStart.spans).toHaveLength(0);
    expect(afterStart.records.length).toBeGreaterThan(0);
    const startRecord = afterStart.records.find(
      (record) => record.attributes["otelhook.event.type"] === "tool.start",
    );
    expect(startRecord).toBeDefined();

    // Second process: the `PostToolUse` edge publishes the one complete span.
    await runOnce(
      rootDir,
      collector,
      toolPayload("ses-corr-1", "PostToolUse", { tool_response: { stdout: "ok" } }),
    );
    const afterEnd = decoded(collector);
    const toolSpan = afterEnd.spans.find((span) => span.name === "tool Bash");
    expect(toolSpan).toBeDefined();
    // Cross-process pairing really happened, so the span has a real duration rather
    // than being an orphan collapsed onto one instant.
    expect(toolSpan?.attributes["otelhook.span.pairing"]).toBe("cross-process");

    // The point of the whole exercise: the record emitted *before* any span existed
    // names the span that was eventually exported.
    expect(startRecord?.spanId).toBe(toolSpan?.spanId);
    expect(startRecord?.traceId).toBe(toolSpan?.traceId);

    const endRecord = afterEnd.records.find(
      (record) => record.attributes["otelhook.event.type"] === "tool.end",
    );
    expect(endRecord?.spanId).toBe(toolSpan?.spanId);
    expect(endRecord?.traceId).toBe(toolSpan?.traceId);
  }, 30_000);

  it("resolves correlation once per batch, so neither signal sees the other's writes", async () => {
    const rootDir = await stateRoot();
    const collector = await collectorFor();

    // If each sink called the correlator separately, the second call would see the
    // first's persisted start and report it as a duplicate — and the two signals
    // would disagree about which span id was published. A single deferred start with
    // no span exported is the observable proof that only one call happened.
    const { logs } = await runOnce(rootDir, collector, toolPayload("ses-corr-2", "PreToolUse"));
    const { spans, records } = decoded(collector);

    expect(spans).toHaveLength(0);
    const startRecords = records.filter(
      (record) => record.attributes["otelhook.event.type"] === "tool.start",
    );
    expect(startRecords).toHaveLength(1);
    expect(logs).not.toContain("span correlation unavailable; exporting uncorrelated log records");
  }, 30_000);

  it("never merges two sessions into one trace", async () => {
    const rootDir = await stateRoot();
    const collector = await collectorFor();

    for (const sessionId of ["ses-iso-a", "ses-iso-b"]) {
      await runOnce(
        rootDir,
        collector,
        toolPayload(sessionId, "PostToolUse", { tool_response: { stdout: "ok" } }),
      );
    }

    const { records } = decoded(collector);
    const bySession = new Map<string, Set<string>>();
    for (const record of records) {
      const sessionId = String(record.attributes["session.id"]);
      const traces = bySession.get(sessionId) ?? new Set<string>();
      traces.add(record.traceId);
      bySession.set(sessionId, traces);
    }

    expect([...bySession.keys()].sort()).toEqual(["ses-iso-a", "ses-iso-b"]);
    // One trace per session, and the two sessions share none of it — even though the
    // two invocations used the same tool call id and the same state root.
    for (const traces of bySession.values()) {
      expect(traces.size).toBe(1);
    }
    const [a, b] = [...bySession.values()].map((traces) => [...traces][0]);
    expect(a).not.toBe(b);
  }, 30_000);

  it("holds the default privacy posture on both signals at once", async () => {
    const rootDir = await stateRoot();
    const collector = await collectorFor();
    const secret = "npm test --token=leak-me-please";

    await runOnce(
      rootDir,
      collector,
      toolPayload("ses-privacy-1", "PostToolUse", {
        tool_input: { command: secret },
        tool_response: { stdout: secret },
      }),
    );

    // One assertion over *everything* the process sent, both signals: adding a
    // pipeline must not add a disclosure path.
    const wire = Buffer.concat(collector.bodies()).toString("latin1");
    expect(wire).not.toContain(secret);
    expect(wire).not.toContain("leak-me-please");
    expect(wire).not.toContain("/workspace/fixture-repo");

    const { records } = decoded(collector);
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(record.body).toBeUndefined();
    }
  }, 30_000);

  it("carries content on the logs signal only, once both gates are open", async () => {
    const rootDir = await stateRoot();
    const collector = await collectorFor();

    await runOnce(
      rootDir,
      collector,
      toolPayload("ses-content-1", "PostToolUse", {
        tool_input: { command: "npm run build" },
        tool_response: { stdout: "build succeeded" },
      }),
      { includeContent: true },
    );

    const { spans, records } = decoded(collector);
    const disclosed = records.filter((record) => record.body !== undefined);
    expect(disclosed.length).toBeGreaterThan(0);
    expect(disclosed.some((record) => (record.body ?? "").includes("build succeeded"))).toBe(true);

    // Spans still carry no content in any mode, which is why the logs pipeline needed
    // its own switch: enabling content must not retroactively change what a span is.
    const spanText = JSON.stringify(spans);
    expect(spanText).not.toContain("build succeeded");
  }, 30_000);

  it("reports both signals separately in health", async () => {
    const rootDir = await stateRoot();
    const collector = await collectorFor();
    const { runtime } = await runOnce(
      rootDir,
      collector,
      toolPayload("ses-health-1", "PostToolUse", { tool_response: { stdout: "ok" } }),
    );

    const health = runtime.health();
    expect(health.subsystems.map((entry) => entry.subsystem)).toEqual([
      "telemetry-sink",
      "telemetry-log-sink",
    ]);
    expect(health.healthy).toBe(true);
    for (const subsystem of health.subsystems) {
      expect(subsystem.totalAccepted).toBeGreaterThan(0);
      expect(subsystem.totalRejected).toBe(0);
    }
  }, 30_000);

  it("gives the logs signal its own retry queue under the shared state root", async () => {
    const rootDir = await stateRoot();
    const collector = await collectorFor();
    const { runtime } = await runOnce(
      rootDir,
      collector,
      toolPayload("ses-spool-1", "PostToolUse", { tool_response: { stdout: "ok" } }),
    );

    expect(runtime.logSpool).toBeDefined();
    expect(await runtime.logSpool?.size()).toBe(0);
    expect(await runtime.spool?.size()).toBe(0);
  }, 30_000);
});

describe("durability across two signals", () => {
  const runWith = async (
    rootDir: string,
    endpoint: string,
    logsEndpoint: string | undefined,
    payload: Record<string, unknown>,
  ) => {
    const runtime = createHookRuntime({
      config: {
        ...DEFAULT_CONFIG,
        exporter: {
          ...DEFAULT_CONFIG.exporter,
          endpoint,
          timeoutMillis: 400,
          maxRetryAttempts: 0,
          logs: {
            ...DEFAULT_CONFIG.exporter.logs,
            enabled: true,
            ...(logsEndpoint === undefined ? {} : { endpoint: logsEndpoint }),
          },
        },
      },
      registry: createProviderRegistry([createClaudeCodeAdapter()]),
      stateRootDir: rootDir,
      installationId: INSTALLATION,
      providerNamespace: PROVIDER,
      clock: createSystemClock(),
      logger: createRecordingLogger(),
      // Spooling off, so a refused export is a real loss rather than a queued retry —
      // which is the only way to observe the durability classification at all.
      enableSpool: false,
    });
    const outcome = await runtime.process({ payload, transport: "hook-stdin", providerHint: PROVIDER });
    await runtime.shutdown();
    return outcome;
  };

  it("commits terminally when only the logs signal is lost", async () => {
    const rootDir = await stateRoot();
    const collector = await collectorFor();
    // Traces land; logs go nowhere. Retrying would re-export a span the collector
    // already accepted, so this must be terminal rather than retryable.
    const outcome = await runWith(
      rootDir,
      collector.url,
      "http://127.0.0.1:1/v1/logs",
      toolPayload("ses-partial-1", "PostToolUse", { tool_response: { stdout: "ok" } }),
    );

    expect(outcome.ingest.durability).toBe("partial");
    expect(outcome.delivery.retryable).toBeUndefined();
    expect(outcome.ingest.emitted).toBeGreaterThan(0);
    expect(outcome.ingest.exportRejected).toBeGreaterThan(0);
    expect(collector.bodiesFor("/v1/traces").length).toBeGreaterThan(0);
  }, 30_000);

  it("stays retryable when neither signal survived", async () => {
    const rootDir = await stateRoot();
    // Nothing reachable at all: with no spool there is nothing to duplicate, so the
    // claim is released and the callback can be redelivered.
    const outcome = await runWith(
      rootDir,
      "http://127.0.0.1:1/v1/traces",
      undefined,
      toolPayload("ses-lost-1", "PostToolUse", { tool_response: { stdout: "ok" } }),
    );

    expect(outcome.ingest.durability).toBe("lost");
    expect(outcome.ingest.emitted).toBe(0);
    expect(outcome.delivery.retryable).toBe(true);
  }, 30_000);
});
