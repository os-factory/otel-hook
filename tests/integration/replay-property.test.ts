import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../../src/config/schema.js";
import { normalizeUsageOrThrow } from "../../src/model/usage.js";
import { createCallbackDeduplicator } from "../../src/lifecycle/dedup.js";
import { createSpanCorrelator } from "../../src/lifecycle/span-correlator.js";
import { createUsageAccumulator } from "../../src/lifecycle/usage-accumulator.js";
import { createProviderRegistry } from "../../src/providers/registry.js";
import { createFixedClock } from "../../src/runtime/clock.js";
import { createOtelHook } from "../../src/runtime/hook.js";
import { createNullTelemetrySink } from "../../src/runtime/memory.js";
import { createFilesystemStateStore } from "../../src/state/filesystem-store.js";
import { createFixtureAdapter } from "../../src/testing/index.js";
import { createSeededRandom } from "../helpers/random.js";

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(tmpdir(), "otel-hook-replay-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("replay invariants across separately constructed hook instances sharing durable state", () => {
  it("re-processing an identical cumulative usage snapshot yields an all-zero delta the second time", async () => {
    const clock = createFixedClock();
    const stateStore = createFilesystemStateStore({
      rootDir,
      providerId: "fixture",
      installationId: "install-1",
      clock,
    });
    const registry = createProviderRegistry([createFixtureAdapter()]);
    const sink = createNullTelemetrySink();

    const payload = {
      provider: "fixture",
      sessionId: "ses_replay",
      event: "generation",
      requestId: "req-1",
      occurredAt: 1_000,
      usage: { temporality: "cumulative" as const, inputTokens: 100, outputTokens: 20 },
    };

    // Two independently constructed hook instances, as two separate process
    // invocations would be, sharing only the on-disk state.
    const first = createOtelHook({ sink, stateStore, registry, clock, config: DEFAULT_CONFIG });
    const firstOutcome = await first.ingest({ payload, transport: "hook-stdin" });
    const firstUsage = firstOutcome.usageObservations.find((observation) => observation.scope === "generation");
    expect(firstUsage?.delta.inputTokens).toBe(100);
    expect(firstUsage?.resetDetected).toBe(false);

    const second = createOtelHook({ sink, stateStore, registry, clock, config: DEFAULT_CONFIG });
    const secondOutcome = await second.ingest({ payload, transport: "hook-stdin" });
    const secondUsage = secondOutcome.usageObservations.find((observation) => observation.scope === "generation");
    expect(secondUsage?.delta.inputTokens).toBe(0);
    expect(secondUsage?.delta.outputTokens).toBe(0);
    expect(secondUsage?.resetDetected).toBe(false);
  });

  it("reports a reset rather than a negative delta when a replayed transcript restarts the counter", async () => {
    const clock = createFixedClock();
    const stateStore = createFilesystemStateStore({
      rootDir,
      providerId: "fixture",
      installationId: "install-1",
      clock,
    });
    const registry = createProviderRegistry([createFixtureAdapter()]);
    const sink = createNullTelemetrySink();
    const hook = createOtelHook({ sink, stateStore, registry, clock, config: DEFAULT_CONFIG });

    await hook.ingest({
      payload: {
        provider: "fixture",
        sessionId: "ses_reset",
        event: "generation",
        requestId: "req-1",
        usage: { temporality: "cumulative", inputTokens: 500 },
      },
      transport: "hook-stdin",
    });
    // Same requestId (and so the same generation scope key) as above: a
    // smaller cumulative snapshot for the *same* scope is what signals a
    // restart, not a new generation id.
    const restarted = await hook.ingest({
      payload: {
        provider: "fixture",
        sessionId: "ses_reset",
        event: "generation",
        requestId: "req-1",
        usage: { temporality: "cumulative", inputTokens: 10 },
      },
      transport: "hook-stdin",
    });

    const usage = restarted.usageObservations.find((observation) => observation.scope === "generation");
    expect(usage?.resetDetected).toBe(true);
    expect(usage?.delta.inputTokens).toBe(10);
  });

  it("callback deduplication is order-independent: every fresh id is accepted exactly once no matter how redeliveries interleave", async () => {
    const clock = createFixedClock();
    const stateStore = createFilesystemStateStore({ rootDir, providerId: "fixture", installationId: "install-1", clock });
    const deduplicator = createCallbackDeduplicator({ stateStore, clock });
    const random = createSeededRandom(0xc0ffee);

    const ids = Array.from({ length: 30 }, (_, index) => `cb_${index}`);
    const deliveries = [...ids, ...ids, ...ids];
    for (let index = deliveries.length - 1; index > 0; index -= 1) {
      const swapIndex = random.int(0, index);
      const a = deliveries[index] as string;
      const b = deliveries[swapIndex] as string;
      deliveries[index] = b;
      deliveries[swapIndex] = a;
    }

    let accepted = 0;
    for (const id of deliveries) {
      const result = await deduplicator.checkAndMark("ses_1", id);
      if (!result.duplicate) {
        accepted += 1;
      }
    }
    expect(accepted).toBe(ids.length);
  });

  it("usage rollup accumulation is order-independent: any permutation of the same deltas sums to the same total", async () => {
    const clock = createFixedClock();
    const random = createSeededRandom(0x5eed);
    const deltas = Array.from({ length: 20 }, () =>
      normalizeUsageOrThrow({ temporality: "delta", inputTokens: random.int(0, 30), outputTokens: random.int(0, 30) }),
    );
    const expectedInput = deltas.reduce((sum, usage) => sum + usage.inputTokens, 0);
    const expectedOutput = deltas.reduce((sum, usage) => sum + usage.outputTokens, 0);

    const runInOrder = async (order: readonly number[], label: string): Promise<number> => {
      const stateStore = createFilesystemStateStore({
        rootDir: path.join(rootDir, label),
        providerId: "fixture",
        installationId: "install-1",
        clock,
      });
      const accumulator = createUsageAccumulator({ stateStore, clock });
      const key = { sessionId: "ses_1", scope: "session", scopeKey: "ses_1" };
      let last;
      for (const index of order) {
        last = await accumulator.accumulateDelta(key, deltas[index] as ReturnType<typeof normalizeUsageOrThrow>);
      }
      expect(last?.total.outputTokens).toBe(expectedOutput);
      return last?.total.inputTokens ?? -1;
    };

    const ascending = deltas.map((_, index) => index);
    const shuffled = [...ascending];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swapIndex = random.int(0, index);
      const a = shuffled[index] as number;
      const b = shuffled[swapIndex] as number;
      shuffled[index] = b;
      shuffled[swapIndex] = a;
    }

    const totalAscending = await runInOrder(ascending, "ascending");
    const totalShuffled = await runInOrder(shuffled, "shuffled");
    expect(totalAscending).toBe(expectedInput);
    expect(totalShuffled).toBe(expectedInput);
  });

  it("span correlation survives a redelivered start/end pair without double-counting a duration", async () => {
    const clock = createFixedClock();
    const stateStore = createFilesystemStateStore({ rootDir, providerId: "fixture", installationId: "install-1", clock });
    const correlator = createSpanCorrelator({ stateStore, clock });

    const startInput = {
      sessionId: "ses_1",
      scope: "tool" as const,
      scopeKey: "call_1",
      eventId: "evt_start",
      occurredAt: 1_000,
    };
    const endInput = {
      sessionId: "ses_1",
      scope: "tool" as const,
      scopeKey: "call_1",
      eventId: "evt_end",
      occurredAt: 1_300,
    };

    await correlator.recordStart(startInput);
    const firstEnd = await correlator.recordEnd(endInput);
    await correlator.recordStart(startInput); // redelivered start
    const secondEnd = await correlator.recordEnd(endInput); // redelivered end

    expect(firstEnd).toEqual({ status: "matched", startedAt: 1_000, durationMillis: 300 });
    expect(secondEnd).toEqual({ status: "duplicate" });
  });
});
