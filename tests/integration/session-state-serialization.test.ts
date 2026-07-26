import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../../src/config/schema.js";
import { createProviderRegistry } from "../../src/providers/registry.js";
import { createFixedClock, createSystemClock } from "../../src/runtime/clock.js";
import { createOtelHook } from "../../src/runtime/hook.js";
import { createSpanCorrelator } from "../../src/lifecycle/span-correlator.js";
import { createFilesystemStateStore } from "../../src/state/filesystem-store.js";
import { isStateLockContention, StateLockTimeoutError } from "../../src/state/store.js";
import { LockWaitTimeoutError } from "../../src/state/async-lock.js";
import { createOtlpTraceSink } from "../../src/telemetry/otlp-sink.js";
import { createFixtureAdapter } from "../../src/testing/index.js";
import type { CanonicalEvent } from "../../src/model/events.js";
import type { TelemetryEmitResult, TelemetrySink } from "../../src/runtime/ports.js";
import { startCapturingCollector, type CapturingCollector } from "../helpers/collector.js";

/**
 * Serialization of the session state every concurrent hook process shares.
 *
 * The sequence counter seeds each event's derived id, and the cumulative usage
 * baseline is what deltas are measured against. Both are read-modify-write cycles
 * over state that two hook processes touch at the same time, so the interesting
 * assertions here are about what happens when they collide.
 */

let rootDir: string;
const cleanups: (() => Promise<void>)[] = [];

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(tmpdir(), "otel-hook-session-serial-"));
});

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  await rm(rootDir, { recursive: true, force: true });
});

const withCollector = async (): Promise<CapturingCollector> => {
  const collector = await startCapturingCollector();
  cleanups.push(() => collector.close());
  return collector;
};

const SESSION = "ses_serial_1";

const collectingSink = (): TelemetrySink & { readonly batches: CanonicalEvent[][] } => {
  const batches: CanonicalEvent[][] = [];
  return {
    batches,
    emit: (events): Promise<TelemetryEmitResult> => {
      batches.push([...events]);
      return Promise.resolve({ accepted: events.length, rejected: 0, errors: [] });
    },
    flush: (): Promise<void> => Promise.resolve(),
    shutdown: (): Promise<void> => Promise.resolve(),
  };
};

/** A fresh hook over a shared state root: one short-lived process. */
const startProcess = (
  sink: TelemetrySink,
): ReturnType<typeof createOtelHook> => {
  const clock = createSystemClock();
  return createOtelHook({
    sink,
    stateStore: createFilesystemStateStore({
      rootDir,
      providerId: "fixture",
      installationId: "install-1",
      clock,
      // Generous on purpose. A waiter that gives up is *cancelled* — its critical
      // section never runs, so its event never gets a sequence — which is the
      // correct answer to contention but would make this test about lock budgets
      // rather than about collisions. Eight contenders on a loaded CI runner can
      // exceed a 1s budget, so the budget is taken out of the picture and what
      // remains under test is that the sequences that *do* land never collide.
      lockTimeoutMillis: 30_000,
    }),
    registry: createProviderRegistry([createFixtureAdapter()]),
    clock,
    config: { ...DEFAULT_CONFIG, detection: { ...DEFAULT_CONFIG.detection, minimumConfidence: "weak" } },
  });
};

const payload = (event: string, occurredAt: number): unknown => ({
  provider: "fixture",
  sessionId: SESSION,
  event,
  occurredAt,
});

describe("concurrent hook processes cannot collide on session sequence state", () => {
  it("gives every event of a session a distinct sequence and event id", async () => {
    const sink = collectingSink();

    // Eight concurrent invocations against one session, each its own hook over the
    // same state root. Unserialized, several would read the same sequence base and
    // stamp events from it, so two events would carry one derived id and a
    // collector would see one twice while another was never numbered at all.
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        startProcess(sink).ingest({
          payload: payload("session.start", 1_000 + index),
          transport: "hook-stdin",
        }),
      ),
    );

    const events = sink.batches.flat();
    expect(events.length).toBe(8);

    const sequences = events.map((event) => event.sequence);
    expect(new Set(sequences).size).toBe(sequences.length);
    // Consecutive from zero, with no gaps and no reuse.
    expect([...sequences].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

    const ids = events.map((event) => event.eventId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps the exported span ids distinct under the same concurrency", async () => {
    const collector = await withCollector();
    const clock = createSystemClock();

    await Promise.all(
      Array.from({ length: 6 }, (_, index) => {
        const stateStore = createFilesystemStateStore({
          rootDir,
          providerId: "fixture",
          installationId: "install-1",
          clock,
          // As above: contention must resolve rather than time out, so the
          // assertion is about span identity and not about lock budgets.
          lockTimeoutMillis: 30_000,
        });
        const correlator = createSpanCorrelator({ stateStore, clock });
        const sink = createOtlpTraceSink({
          exporter: {
            ...DEFAULT_CONFIG.exporter,
            endpoint: collector.url,
            timeoutMillis: 5_000,
          },
          providerId: "fixture",
          installationId: "install-1",
          clock,
          correlate: (events) => correlator.correlateBatch(events),
        });
        return createOtelHook({
          sink,
          stateStore,
          registry: createProviderRegistry([createFixtureAdapter()]),
          clock,
          config: {
            ...DEFAULT_CONFIG,
            detection: { ...DEFAULT_CONFIG.detection, minimumConfidence: "weak" },
          },
        }).ingest({ payload: payload("session.start", 2_000 + index), transport: "hook-stdin" });
      }),
    );

    const { decodeAllExportedSpans } = await import("../helpers/otlp.js");
    const spans = decodeAllExportedSpans(collector.bodies());
    const ids = spans.map((span) => `${span.traceId}:${span.spanId}`);
    // Whatever else concurrency does, no two records may claim one identity.
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("lock failures are told apart from lock contention", () => {
  it("classifies only contention as contention", () => {
    expect(isStateLockContention(new StateLockTimeoutError("ses", 100))).toBe(true);
    expect(isStateLockContention(new LockWaitTimeoutError("ses", 100))).toBe(true);
    // A store that cannot be used at all is a different condition: it protects
    // nothing, because the state the lock guards is equally unreachable.
    expect(isStateLockContention(new Error("filesystem state store lock failed: Error"))).toBe(false);
    expect(isStateLockContention(undefined)).toBe(false);
  });

  it("still exports when the store is unusable, rather than declining", async () => {
    // `rootDir/blocked` is a *file*, so every state operation beneath it fails
    // with ENOTDIR — "the disk is unusable" without OS-specific privilege games.
    const { writeFile } = await import("node:fs/promises");
    const blocked = path.join(rootDir, "blocked");
    await writeFile(blocked, "not a directory", "utf8");

    const sink = collectingSink();
    const clock = createFixedClock();
    const hook = createOtelHook({
      sink,
      stateStore: createFilesystemStateStore({
        rootDir: path.join(blocked, "state"),
        providerId: "fixture",
        installationId: "install-1",
        clock,
        lockTimeoutMillis: 200,
      }),
      registry: createProviderRegistry([createFixtureAdapter()]),
      clock,
      config: { ...DEFAULT_CONFIG, detection: { ...DEFAULT_CONFIG.detection, minimumConfidence: "weak" } },
    });

    const outcome = await hook.ingest({
      payload: payload("session.start", 1_000),
      transport: "hook-stdin",
    });

    // Fail open: the observation is still attributed and still exported. There is
    // no peer inside the critical section and no state to lose an update to, so
    // refusing here would cost telemetry to protect nothing.
    expect(outcome.attribution).toBe("attributed");
    expect(outcome.emitted).toBeGreaterThan(0);
    expect(outcome.diagnostics.some((info) => info.code === "state-store-failure")).toBe(true);
    expect(sink.batches.flat().length).toBeGreaterThan(0);
  });
});
