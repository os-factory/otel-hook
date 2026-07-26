import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_EXPORTER_POLICY } from "../../src/config/schema.js";
import { createLifecycleJanitor } from "../../src/lifecycle/janitor.js";
import { createSpanCorrelator, type SpanCorrelator } from "../../src/lifecycle/span-correlator.js";
import { parseCanonicalEvent, type CanonicalEvent } from "../../src/model/events.js";
import { CANONICAL_SCHEMA_VERSION } from "../../src/model/version.js";
import { createFixedClock, createSystemClock } from "../../src/runtime/clock.js";
import { createInMemoryStateStore } from "../../src/runtime/memory.js";
import type { Clock } from "../../src/runtime/ports.js";
import { sanitizeSegment } from "../../src/state/keys.js";
import { createFilesystemStateStore } from "../../src/state/filesystem-store.js";
import { createOtlpTraceSink, type OtlpTelemetrySink } from "../../src/telemetry/otlp-sink.js";
import { createTestIdentity } from "../../src/testing/index.js";
import { startCapturingCollector, type CapturingCollector } from "../helpers/collector.js";
import { decodeAllExportedSpans, type DecodedSpan } from "../helpers/otlp.js";

/**
 * Cross-process span correlation, exercised the way it actually runs.
 *
 * A hook fires as a separate short-lived process per lifecycle edge, so a
 * "process" here is a *fresh* state store, correlator, and sink over a shared
 * state root — no object, cache, or lock is carried across the boundary, which
 * is the only way to prove the pairing really came off disk.
 */

const PROVIDER = "acme-cli";
const INSTALLATION = "install-1";
const SESSION = "ses_correlation_1";

const identity = createTestIdentity();

type EventOverrides = Record<string, unknown>;

const buildEvent = (invocationId: string, overrides: EventOverrides): CanonicalEvent =>
  parseCanonicalEvent({
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    invocationId,
    sessionId: SESSION,
    provenance: { ...identity.provenance, providerId: PROVIDER },
    workspace: identity.workspace,
    extensions: {},
    ...overrides,
  });

const toolStartEvent = (invocationId: string, overrides: EventOverrides = {}): CanonicalEvent =>
  buildEvent(invocationId, {
    type: "tool.start",
    eventId: "evt_tool_start",
    sequence: 0,
    occurredAt: 1_000,
    toolCallId: "call_1",
    toolName: "read_file",
    toolKind: "read",
    generationId: "gen_1",
    ...overrides,
  });

const toolEndEvent = (invocationId: string, overrides: EventOverrides = {}): CanonicalEvent =>
  buildEvent(invocationId, {
    type: "tool.end",
    eventId: "evt_tool_end",
    sequence: 0,
    occurredAt: 1_750,
    toolCallId: "call_1",
    toolName: "read_file",
    outcome: "ok",
    ...overrides,
  });

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const withStateRoot = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), "otel-hook-correlation-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

const withCollector = async (
  respond?: Parameters<typeof startCapturingCollector>[0],
): Promise<CapturingCollector> => {
  const collector = await startCapturingCollector(respond);
  cleanups.push(() => collector.close());
  return collector;
};

type HookProcess = {
  readonly correlator: SpanCorrelator;
  readonly sink: OtlpTelemetrySink;
  emit(events: readonly CanonicalEvent[]): Promise<void>;
};

type ProcessOptions = {
  readonly providerId?: string;
  readonly clock?: Clock;
  readonly lockTimeoutMillis?: number;
  readonly lockStaleMillis?: number;
  readonly maxStartAgeMillis?: number;
};

/**
 * One short-lived hook process: everything is constructed from scratch, exactly
 * as `createHookRuntime` does on each invocation.
 */
const startProcess = (
  rootDir: string,
  collectorUrl: string,
  options: ProcessOptions = {},
): HookProcess => {
  const clock = options.clock ?? createFixedClock();
  const providerId = options.providerId ?? PROVIDER;
  const stateStore = createFilesystemStateStore({
    rootDir,
    providerId,
    installationId: INSTALLATION,
    clock,
    ...(options.lockTimeoutMillis === undefined ? {} : { lockTimeoutMillis: options.lockTimeoutMillis }),
    ...(options.lockStaleMillis === undefined ? {} : { lockStaleMillis: options.lockStaleMillis }),
  });
  const correlator = createSpanCorrelator({
    stateStore,
    clock,
    ...(options.maxStartAgeMillis === undefined ? {} : { maxStartAgeMillis: options.maxStartAgeMillis }),
  });
  const sink = createOtlpTraceSink({
    exporter: { ...DEFAULT_EXPORTER_POLICY, endpoint: collectorUrl, timeoutMillis: 5_000 },
    providerId,
    installationId: INSTALLATION,
    clock,
    correlate: (events) => correlator.correlateBatch(events),
  });
  return {
    correlator,
    sink,
    emit: async (events): Promise<void> => {
      const result = await sink.emit(events);
      expect(result.rejected).toBe(0);
    },
  };
};

const exportedSpans = (collector: CapturingCollector): readonly DecodedSpan[] =>
  decodeAllExportedSpans(collector.bodies());

const toolSpans = (collector: CapturingCollector): readonly DecodedSpan[] =>
  exportedSpans(collector).filter((span) => span.name === "tool read_file");

describe("cross-process span correlation", () => {
  it("pairs a start and an end emitted by two separate processes", async () => {
    const collector = await withCollector();
    const rootDir = await withStateRoot();

    await startProcess(rootDir, collector.url).emit([toolStartEvent("inv_start")]);
    // A brand-new process: nothing is shared but the state directory.
    await startProcess(rootDir, collector.url).emit([toolEndEvent("inv_end")]);

    // One record, from the end process. The start process exported nothing: a
    // lifecycle span id is derived from the scope, so a start-edge record would
    // carry the same trace and span id as this one, and OTLP has no update — a
    // collector would arbitrarily keep one of the two rather than merge them.
    const spans = toolSpans(collector);
    expect(spans).toHaveLength(1);
    const [closed] = spans;
    expect(closed).toBeDefined();

    // No two exported records may claim one (trace, span) identity.
    const ids = exportedSpans(collector).map((span) => `${span.traceId}:${span.spanId}`);
    expect(new Set(ids).size).toBe(ids.length);

    // The end process recovered the start time, duration, status, and the
    // attributes only the start edge ever knew.
    expect(closed?.attributes["otelhook.span.paired"]).toBe(true);
    expect(closed?.attributes["otelhook.span.pairing"]).toBe("cross-process");
    expect(closed?.attributes["otelhook.span.orphan"]).toBe("none");
    expect(closed?.startMillis).toBe(1_000);
    expect(closed?.endMillis).toBe(1_750);
    expect(closed?.durationMillis).toBe(750);
    expect(closed?.attributes["otelhook.tool.kind"]).toBe("read");
    expect(closed?.attributes["otelhook.outcome"]).toBe("ok");
    expect(closed?.statusCode).toBe(0);

    // The parent recorded at start time survives into the end process, which
    // never saw the generation id at all.
    expect(closed?.parentSpanId).not.toBe("");
    expect(closed?.parentSpanId).toBeDefined();
  });

  it("reports an error status and outcome from the end process alone", async () => {
    const collector = await withCollector();
    const rootDir = await withStateRoot();

    await startProcess(rootDir, collector.url).emit([toolStartEvent("inv_start")]);
    await startProcess(rootDir, collector.url).emit([
      toolEndEvent("inv_end", { outcome: "error" }),
    ]);

    const closed = toolSpans(collector)[0];
    expect(closed?.statusCode).toBe(2);
    expect(closed?.attributes["error.type"]).toBe("error");
    expect(closed?.attributes["otelhook.span.orphan"]).toBe("none");
    expect(closed?.durationMillis).toBe(750);
  });

  it("recovers after the start process is killed before it could shut down", async () => {
    const collector = await withCollector();
    const rootDir = await withStateRoot();

    // No flush, no shutdown, no graceful anything: the record is on disk
    // because every write lands through a temp file plus rename.
    const crashed = startProcess(rootDir, collector.url);
    await crashed.emit([toolStartEvent("inv_start")]);

    // Debris a killed process leaves behind must not confuse a later reader.
    const recordsDir = path.join(rootDir, sanitizeSegment(PROVIDER), INSTALLATION, "records");
    await writeFile(path.join(recordsDir, ".tmp-abandoned-write.json"), "{ truncated", "utf8");

    await startProcess(rootDir, collector.url).emit([toolEndEvent("inv_end")]);

    const closed = toolSpans(collector)[0];
    expect(closed?.attributes["otelhook.span.orphan"]).toBe("none");
    expect(closed?.durationMillis).toBe(750);
  });

  it("reclaims a session lock left behind by a crashed process", async () => {
    const collector = await withCollector();
    const rootDir = await withStateRoot();

    await startProcess(rootDir, collector.url).emit([toolStartEvent("inv_start")]);

    // A crashed holder never unlinks its lock file. Nothing will ever release
    // it, so the only way out is the staleness timeout.
    const locksDir = path.join(rootDir, sanitizeSegment(PROVIDER), INSTALLATION, "locks");
    await mkdir(locksDir, { recursive: true });
    await writeFile(
      path.join(locksDir, `${sanitizeSegment(SESSION)}.lock`),
      JSON.stringify({ pid: 999_999, acquiredAt: 0 }),
      "utf8",
    );

    await startProcess(rootDir, collector.url, { lockStaleMillis: 50 }).emit([
      toolEndEvent("inv_end"),
    ]);

    const closed = toolSpans(collector)[0];
    expect(closed?.attributes["otelhook.span.orphan"]).toBe("none");
    expect(closed?.durationMillis).toBe(750);
  });

  it("degrades to an unpaired span when a live lock holder never yields", async () => {
    const collector = await withCollector();
    const rootDir = await withStateRoot();

    await startProcess(rootDir, collector.url).emit([toolStartEvent("inv_start")]);

    const locksDir = path.join(rootDir, sanitizeSegment(PROVIDER), INSTALLATION, "locks");
    await mkdir(locksDir, { recursive: true });
    // Freshly acquired by a peer that is still alive: waiting forever would
    // stall the host agent, so the wait is bounded and the span degrades. The
    // bound is measured on a real monotonic clock, so this reader uses one.
    await writeFile(
      path.join(locksDir, `${sanitizeSegment(SESSION)}.lock`),
      JSON.stringify({ pid: 999_999, acquiredAt: Date.now() }),
      "utf8",
    );

    await startProcess(rootDir, collector.url, {
      clock: createSystemClock(),
      lockTimeoutMillis: 50,
      lockStaleMillis: 600_000,
    }).emit([toolEndEvent("inv_end")]);

    const degraded = toolSpans(collector)[0];
    // Fail open: the observation is still exported, explicitly labelled as
    // having had no state to consult.
    expect(degraded).toBeDefined();
    expect(degraded?.attributes["otelhook.span.paired"]).toBe(false);
    expect(degraded?.attributes["otelhook.span.orphan"]).toBe("state-unavailable");
  });

  it("produces exactly one completed span when the start and end processes race", async () => {
    const collector = await withCollector();
    const rootDir = await withStateRoot();

    // Both edges in flight at once, ordered by the filesystem lock rather than
    // by the test.
    await Promise.all([
      startProcess(rootDir, collector.url).emit([toolStartEvent("inv_start")]),
      startProcess(rootDir, collector.url).emit([toolEndEvent("inv_end")]),
    ]);

    // Exactly one record either way, and never two claiming one span id.
    //
    // The lock picks the order. Start-then-end is the good case: the start defers
    // and the end publishes a completed span. End-then-start is the honest bad
    // case: the end had no start to pair with, so it published an orphan, and the
    // late start then stays silent rather than re-publishing that same span id
    // with a duration attached — OTLP cannot revise an exported span.
    const spans = toolSpans(collector);
    expect(spans).toHaveLength(1);
    const [only] = spans;
    const orphan = only?.attributes["otelhook.span.orphan"];
    if (orphan === "none") {
      expect(only?.durationMillis).toBe(750);
    } else {
      expect(orphan).toBe("missing-start");
      expect(only?.durationMillis).toBe(0);
    }
  });

  it("re-exports an identical span for a redelivered end instead of re-closing it", async () => {
    const collector = await withCollector();
    const rootDir = await withStateRoot();

    await startProcess(rootDir, collector.url).emit([toolStartEvent("inv_start")]);
    await startProcess(rootDir, collector.url).emit([toolEndEvent("inv_end")]);
    // The host retries the same callback in a third process. Its wall clock has
    // moved on, but the span must not.
    await startProcess(rootDir, collector.url).emit([
      toolEndEvent("inv_end_retry", { occurredAt: 9_999 }),
    ]);

    const [first, replay] = toolSpans(collector);
    expect(replay?.spanId).toBe(first?.spanId);
    expect(replay?.traceId).toBe(first?.traceId);
    expect(replay?.startMillis).toBe(first?.startMillis);
    expect(replay?.endMillis).toBe(first?.endMillis);
    expect(replay?.durationMillis).toBe(750);
    expect(replay?.attributes["otelhook.span.orphan"]).toBe("none");
  });

  it("refuses a second, distinct end for a span that is already closed", async () => {
    const collector = await withCollector();
    const rootDir = await withStateRoot();

    await startProcess(rootDir, collector.url).emit([toolStartEvent("inv_start")]);
    await startProcess(rootDir, collector.url).emit([toolEndEvent("inv_end")]);
    await startProcess(rootDir, collector.url).emit([
      toolEndEvent("inv_end_2", { eventId: "evt_tool_end_2", occurredAt: 5_000 }),
    ]);

    const spans = toolSpans(collector);
    const [closed, late] = spans;
    expect(spans).toHaveLength(2);
    expect(late?.attributes["otelhook.span.paired"]).toBe(false);
    expect(late?.attributes["otelhook.span.orphan"]).toBe("already-closed");
    // No duration is invented from the first pair's start.
    expect(late?.durationMillis).toBe(0);
    // Both ends are real observations, so neither is dropped — but the second
    // must not reuse the span id the first was published under.
    expect(late?.spanId).not.toBe(closed?.spanId);
    expect(late?.traceId).toBe(closed?.traceId);
  });

  it("classifies an end whose start was never seen", async () => {
    const collector = await withCollector();
    const rootDir = await withStateRoot();

    await startProcess(rootDir, collector.url).emit([toolEndEvent("inv_end")]);

    const orphan = toolSpans(collector)[0];
    expect(orphan?.attributes["otelhook.span.paired"]).toBe(false);
    expect(orphan?.attributes["otelhook.span.orphan"]).toBe("missing-start");
    expect(orphan?.durationMillis).toBe(0);
    expect(orphan?.startMillis).toBe(1_750);
  });

  it("classifies an end whose start aged out of the retention window", async () => {
    const collector = await withCollector();
    const rootDir = await withStateRoot();

    await startProcess(rootDir, collector.url).emit([toolStartEvent("inv_start")]);
    await startProcess(rootDir, collector.url, { maxStartAgeMillis: 100 }).emit([
      toolEndEvent("inv_end"),
    ]);

    const expired = toolSpans(collector)[0];
    expect(expired?.attributes["otelhook.span.orphan"]).toBe("expired-start");
    expect(expired?.durationMillis).toBe(0);
  });

  it("does not pair across sessions or across providers", async () => {
    const collector = await withCollector();
    const rootDir = await withStateRoot();

    await startProcess(rootDir, collector.url).emit([toolStartEvent("inv_start")]);

    // Same tool call id, different session.
    await startProcess(rootDir, collector.url).emit([
      buildEvent("inv_other_session", {
        sessionId: "ses_other",
        type: "tool.end",
        eventId: "evt_tool_end",
        sequence: 0,
        occurredAt: 1_750,
        toolCallId: "call_1",
        toolName: "read_file",
        outcome: "ok",
      }),
    ]);

    // Same session and tool call id, different provider.
    await startProcess(rootDir, collector.url, { providerId: "other-cli" }).emit([
      buildEvent("inv_other_provider", {
        provenance: { ...identity.provenance, providerId: "other-cli" },
        type: "tool.end",
        eventId: "evt_tool_end",
        sequence: 0,
        occurredAt: 1_750,
        toolCallId: "call_1",
        toolName: "read_file",
        outcome: "ok",
      }),
    ]);

    // The open start exported nothing, so these two foreign ends are all there is.
    const [otherSession, otherProvider] = toolSpans(collector);

    // And the original span is still pairable by its own process.
    await startProcess(rootDir, collector.url).emit([toolEndEvent("inv_end")]);
    const closed = toolSpans(collector)[2];
    expect(closed?.attributes["otelhook.span.orphan"]).toBe("none");
    expect(closed?.durationMillis).toBe(750);

    for (const foreign of [otherSession, otherProvider]) {
      expect(foreign?.attributes["otelhook.span.orphan"]).toBe("missing-start");
      expect(foreign?.durationMillis).toBe(0);
      // Nothing about the real span leaks: not its trace, not its span id.
      expect(foreign?.traceId).not.toBe(closed?.traceId);
      expect(foreign?.spanId).not.toBe(closed?.spanId);
    }
  });

  it("drops swept correlation state and says so on the next end", async () => {
    const collector = await withCollector();
    const rootDir = await withStateRoot();

    await startProcess(rootDir, collector.url).emit([toolStartEvent("inv_start")]);

    const clock = createFixedClock();
    const sweeper = startProcess(rootDir, collector.url, { clock });
    clock.advance(10_000);
    const report = await createLifecycleJanitor({
      spanCorrelator: sweeper.correlator,
      spanMaxAgeMillis: 1_000,
    }).runOnce(SESSION);
    // `expiredOpen` counts the swept records that held a start and never got an
    // end: spans that will never be exported at all, which is worth surfacing
    // rather than deleting quietly.
    expect(report.span).toEqual({ removed: 1, scanned: 1, expiredOpen: 1 });

    await startProcess(rootDir, collector.url).emit([toolEndEvent("inv_end")]);
    const afterSweep = toolSpans(collector)[0];
    expect(afterSweep?.attributes["otelhook.span.orphan"]).toBe("missing-start");
    expect(afterSweep?.durationMillis).toBe(0);
  });

  it("leaves no correlation record behind once a session has been swept", async () => {
    const collector = await withCollector();
    const rootDir = await withStateRoot();

    const clock = createFixedClock();
    const process = startProcess(rootDir, collector.url, { clock });
    await process.emit([toolStartEvent("inv_start")]);
    await process.emit([toolEndEvent("inv_end")]);

    clock.advance(10_000);
    await createLifecycleJanitor({
      spanCorrelator: process.correlator,
      spanMaxAgeMillis: 1_000,
    }).runOnce(SESSION);

    const recordsDir = path.join(rootDir, sanitizeSegment(PROVIDER), INSTALLATION, "records");
    expect((await readdir(recordsDir)).filter((entry) => entry.endsWith(".json"))).toEqual([]);
  });

  it("exports the batch anyway when the state store cannot be read at all", async () => {
    const collector = await withCollector();
    const clock = createFixedClock();
    const stateStore = createInMemoryStateStore({ clock });
    const correlator = createSpanCorrelator({ stateStore, clock });
    const sink = createOtlpTraceSink({
      exporter: { ...DEFAULT_EXPORTER_POLICY, endpoint: collector.url, timeoutMillis: 5_000 },
      providerId: PROVIDER,
      installationId: INSTALLATION,
      clock,
      correlate: (events) => correlator.correlateBatch(events),
    });

    stateStore.failNext(10);
    const result = await sink.emit([toolEndEvent("inv_end")]);

    // Fail-open telemetry: the observation still leaves the process.
    expect(result).toMatchObject({ accepted: 1, rejected: 0 });
    const degraded = toolSpans(collector)[0];
    expect(degraded?.attributes["otelhook.span.orphan"]).toBe("state-unavailable");
    expect(degraded?.attributes["otelhook.span.paired"]).toBe(false);
  });

  it("exports the batch anyway when the resolver itself throws", async () => {
    const collector = await withCollector();
    const sink = createOtlpTraceSink({
      exporter: { ...DEFAULT_EXPORTER_POLICY, endpoint: collector.url, timeoutMillis: 5_000 },
      providerId: PROVIDER,
      installationId: INSTALLATION,
      clock: createFixedClock(),
      correlate: () => Promise.reject(new Error("resolver exploded")),
    });

    const result = await sink.emit([toolEndEvent("inv_end")]);
    expect(result).toMatchObject({ accepted: 1, rejected: 0 });
    // With no correlation at all the mapping falls back to in-batch pairing.
    expect(toolSpans(collector)[0]?.attributes["otelhook.span.orphan"]).toBe("missing-start");
  });

  it("keeps a parent span id through a spool round trip", async () => {
    const rootDir = await withStateRoot();
    let up = false;
    const collector = await withCollector(() => ({ status: up ? 200 : 503 }));

    const clock = createFixedClock();
    const { createFileDurableSpool } = await import("../../src/telemetry/durable-spool.js");
    const spool = createFileDurableSpool({
      rootDir,
      providerId: PROVIDER,
      installationId: INSTALLATION,
      clock,
    });
    const stateStore = createFilesystemStateStore({
      rootDir,
      providerId: PROVIDER,
      installationId: INSTALLATION,
      clock,
    });
    const correlator = createSpanCorrelator({ stateStore, clock });
    const sink = createOtlpTraceSink({
      exporter: {
        ...DEFAULT_EXPORTER_POLICY,
        endpoint: collector.url,
        timeoutMillis: 2_000,
        maxRetryAttempts: 0,
      },
      providerId: PROVIDER,
      installationId: INSTALLATION,
      clock,
      spool,
      correlate: (events) => correlator.correlateBatch(events),
    });

    // Both edges in one batch, so there is a completed span to spool. A lone start
    // is deferred and would produce no record at all, hence nothing to round-trip.
    await sink.emit([toolStartEvent("inv_start"), toolEndEvent("inv_end")]);
    expect(await spool.size()).toBe(1);

    up = true;
    expect(await sink.drainSpool()).toMatchObject({ drained: 1, remaining: 0 });

    const drained = toolSpans(collector).at(-1);
    expect(drained?.parentSpanId).not.toBe("");
    expect(drained?.parentSpanId).toBeDefined();
    expect(drained?.attributes["otelhook.span.orphan"]).toBe("none");
    expect(drained?.durationMillis).toBe(750);
  });
});
