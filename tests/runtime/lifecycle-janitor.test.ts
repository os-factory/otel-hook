import { describe, expect, it } from "vitest";

import { normalizeUsageOrThrow } from "../../src/model/usage.js";
import { createFixedClock } from "../../src/runtime/clock.js";
import { createInMemoryStateStore } from "../../src/runtime/memory.js";
import { createCallbackDeduplicator } from "../../src/lifecycle/dedup.js";
import { createLifecycleJanitor } from "../../src/lifecycle/janitor.js";
import { createSpanCorrelator } from "../../src/lifecycle/span-correlator.js";
import { createUsageAccumulator } from "../../src/lifecycle/usage-accumulator.js";

describe("createLifecycleJanitor", () => {
  it("fans a single sweep out across every configured component", async () => {
    const clock = createFixedClock();
    const stateStore = createInMemoryStateStore({ clock });
    const spanCorrelator = createSpanCorrelator({ stateStore, clock });
    const deduplicator = createCallbackDeduplicator({ stateStore, clock });
    const usageAccumulator = createUsageAccumulator({ stateStore, clock });

    await spanCorrelator.recordStart({
      sessionId: "ses_1",
      scope: "tool",
      scopeKey: "t1",
      eventId: "e1",
      occurredAt: 0,
    });
    await deduplicator.checkAndMark("ses_1", "cb1");
    await usageAccumulator.accumulateDelta(
      { sessionId: "ses_1", scope: "session", scopeKey: "ses_1" },
      normalizeUsageOrThrow({ temporality: "delta", inputTokens: 1 }),
    );
    clock.advance(10_000);

    const janitor = createLifecycleJanitor({
      spanCorrelator,
      deduplicator,
      usageAccumulator,
      spanMaxAgeMillis: 1_000,
      dedupMaxAgeMillis: 1_000,
      usageMaxAgeMillis: 1_000,
    });

    const report = await janitor.runOnce();
    expect(report.span?.removed).toBe(1);
    expect(report.dedup?.removed).toBe(1);
    expect(report.usage?.removed).toBeGreaterThan(0);
  });

  it("skips components that were not configured", async () => {
    const clock = createFixedClock();
    const stateStore = createInMemoryStateStore({ clock });
    const deduplicator = createCallbackDeduplicator({ stateStore, clock });
    const janitor = createLifecycleJanitor({ deduplicator });

    const report = await janitor.runOnce();
    expect(report.span).toBeUndefined();
    expect(report.usage).toBeUndefined();
    expect(report.dedup).toEqual({ removed: 0, scanned: 0 });
  });
});
