import { describe, expect, it } from "vitest";

import { normalizeUsageOrThrow } from "../../src/model/usage.js";
import { createFixedClock } from "../../src/runtime/clock.js";
import { createInMemoryStateStore } from "../../src/runtime/memory.js";
import { createUsageAccumulator } from "../../src/lifecycle/usage-accumulator.js";
import { createSeededRandom } from "../helpers/random.js";

const delta = (input: Record<string, unknown> = {}) =>
  normalizeUsageOrThrow({ temporality: "delta", ...input });

describe("createUsageAccumulator", () => {
  it("rolls a stream of deltas up into a running cumulative total", async () => {
    const clock = createFixedClock();
    const stateStore = createInMemoryStateStore({ clock });
    const accumulator = createUsageAccumulator({ stateStore, clock });
    const key = { sessionId: "ses_1", scope: "session", scopeKey: "ses_1" };

    await accumulator.accumulateDelta(key, delta({ inputTokens: 10, outputTokens: 2 }));
    const second = await accumulator.accumulateDelta(key, delta({ inputTokens: 5, outputTokens: 1 }));

    expect(second.total.inputTokens).toBe(15);
    expect(second.total.outputTokens).toBe(3);
    expect(second.total.totalTokens).toBe(18);
    expect(second.total.temporality).toBe("cumulative");
    expect(second.epoch).toBe(0);
  });

  it("matches normalizeUsage of the summed report for any sequence of random deltas", async () => {
    const clock = createFixedClock();
    const stateStore = createInMemoryStateStore({ clock });
    const accumulator = createUsageAccumulator({ stateStore, clock });
    const key = { sessionId: "ses_prop", scope: "generation", scopeKey: "gen_1" };
    const random = createSeededRandom(0x1234);

    let expectedInput = 0;
    let expectedOutput = 0;
    let expectedCached = 0;
    let last;
    for (let iteration = 0; iteration < 100; iteration += 1) {
      const inputTokens = random.int(0, 50);
      const cachedInputTokens = random.int(0, inputTokens);
      const outputTokens = random.int(0, 50);
      expectedInput += inputTokens;
      expectedOutput += outputTokens;
      expectedCached += cachedInputTokens;
      last = await accumulator.accumulateDelta(
        key,
        delta({ inputTokens, cachedInputTokens, outputTokens }),
      );
    }

    expect(last?.total.inputTokens).toBe(expectedInput);
    expect(last?.total.outputTokens).toBe(expectedOutput);
    expect(last?.total.cachedInputTokens).toBe(expectedCached);
  });

  it("starts a new epoch and zeroes the total on reset", async () => {
    const clock = createFixedClock();
    const stateStore = createInMemoryStateStore({ clock });
    const accumulator = createUsageAccumulator({ stateStore, clock });
    const key = { sessionId: "ses_1", scope: "session", scopeKey: "ses_1" };

    await accumulator.accumulateDelta(key, delta({ inputTokens: 100 }));
    const reset = await accumulator.recordReset(key);
    expect(reset.epoch).toBe(1);

    expect(await accumulator.read(key)).toBeUndefined();
    const after = await accumulator.accumulateDelta(key, delta({ inputTokens: 10 }));
    expect(after.total.inputTokens).toBe(10);
    expect(after.epoch).toBe(1);
  });

  it("keeps independent totals for different scope keys within one session", async () => {
    const clock = createFixedClock();
    const stateStore = createInMemoryStateStore({ clock });
    const accumulator = createUsageAccumulator({ stateStore, clock });

    await accumulator.accumulateDelta(
      { sessionId: "ses_1", scope: "generation", scopeKey: "gen_a" },
      delta({ inputTokens: 10 }),
    );
    await accumulator.accumulateDelta(
      { sessionId: "ses_1", scope: "generation", scopeKey: "gen_b" },
      delta({ inputTokens: 20 }),
    );

    const a = await accumulator.read({ sessionId: "ses_1", scope: "generation", scopeKey: "gen_a" });
    const b = await accumulator.read({ sessionId: "ses_1", scope: "generation", scopeKey: "gen_b" });
    expect(a?.total.inputTokens).toBe(10);
    expect(b?.total.inputTokens).toBe(20);
  });

  it("cleans up stale totals and epoch markers, bounded by maxEntries", async () => {
    const clock = createFixedClock();
    const stateStore = createInMemoryStateStore({ clock });
    const accumulator = createUsageAccumulator({ stateStore, clock });
    const key = { sessionId: "ses_1", scope: "session", scopeKey: "ses_1" };

    await accumulator.accumulateDelta(key, delta({ inputTokens: 1 }));
    await accumulator.recordReset(key);
    clock.advance(10_000);

    const result = await accumulator.cleanup(5_000);
    expect(result.removed).toBeGreaterThan(0);
    expect(await accumulator.read(key)).toBeUndefined();
  });
});
