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

/**
 * Idempotency by delivery identity, which is what makes a *retried* callback's
 * accounting safe.
 *
 * `ingest` commits the cumulative baseline inside its own transaction, but the
 * rollup is applied in a second critical section afterwards — the accumulator takes
 * the same non-reentrant session lock — so the rollup is the one number a reclaimed
 * or superseded delivery could apply twice. The marker rides inside the record it
 * describes, so the check and the write are one atomic operation and no multi-key
 * transaction is invented to fake one.
 */
describe("createUsageAccumulator: idempotency per delivery", () => {
  const build = () => {
    const clock = createFixedClock();
    const stateStore = createInMemoryStateStore({ clock });
    return { accumulator: createUsageAccumulator({ stateStore, clock }), clock };
  };
  const key = { sessionId: "ses_idem", scope: "subagent", scopeKey: "agent_1" };

  it("folds one delivery's delta in once, however many times it is applied", async () => {
    const { accumulator } = build();
    const stamp = { delivery: { callbackId: "cb-digest-1", ordinal: 0 } };

    const first = await accumulator.accumulateDelta(key, delta({ inputTokens: 10 }), stamp);
    const retry = await accumulator.accumulateDelta(key, delta({ inputTokens: 10 }), stamp);

    expect(first.total.inputTokens).toBe(10);
    // The retry reports the running total after its own delta, which is exactly
    // this: its delta is already in there.
    expect(retry.total.inputTokens).toBe(10);
    expect((await accumulator.read(key))?.total.inputTokens).toBe(10);
  });

  it("still folds in a second observation of the same delivery", async () => {
    const { accumulator } = build();
    const callbackId = "cb-digest-2";

    // One callback can carry two usage-bearing events landing on one rollup key.
    // Idempotency must recognize a *repeat*, not collapse distinct observations.
    await accumulator.accumulateDelta(key, delta({ inputTokens: 10 }), {
      delivery: { callbackId, ordinal: 0 },
    });
    const second = await accumulator.accumulateDelta(key, delta({ inputTokens: 4 }), {
      delivery: { callbackId, ordinal: 1 },
    });
    expect(second.total.inputTokens).toBe(14);

    // And replaying the whole delivery re-applies neither.
    await accumulator.accumulateDelta(key, delta({ inputTokens: 10 }), {
      delivery: { callbackId, ordinal: 0 },
    });
    await accumulator.accumulateDelta(key, delta({ inputTokens: 4 }), {
      delivery: { callbackId, ordinal: 1 },
    });
    expect((await accumulator.read(key))?.total.inputTokens).toBe(14);
  });

  it("folds in a different delivery's delta, marker or no marker", async () => {
    const { accumulator } = build();

    await accumulator.accumulateDelta(key, delta({ inputTokens: 10 }), {
      delivery: { callbackId: "cb-a", ordinal: 0 },
    });
    const other = await accumulator.accumulateDelta(key, delta({ inputTokens: 3 }), {
      delivery: { callbackId: "cb-b", ordinal: 0 },
    });
    expect(other.total.inputTokens).toBe(13);

    // Only the most recent delivery per record is recognizable — that is the retry
    // window and nothing beyond it, and it is stated rather than implied.
    const replayed = await accumulator.accumulateDelta(key, delta({ inputTokens: 10 }), {
      delivery: { callbackId: "cb-a", ordinal: 0 },
    });
    expect(replayed.total.inputTokens).toBe(23);
  });

  it("accumulates unconditionally when the caller has no delivery identity", async () => {
    const { accumulator } = build();

    // Nothing to recognize a repeat by, so declining would lose a real observation
    // rather than avoid a duplicate one.
    await accumulator.accumulateDelta(key, delta({ inputTokens: 10 }));
    await accumulator.accumulateDelta(key, delta({ inputTokens: 10 }));
    expect((await accumulator.read(key))?.total.inputTokens).toBe(20);
  });

  it("opens one epoch per counter restart, not one per replay of it", async () => {
    const { accumulator } = build();
    const stamp = { delivery: { callbackId: "cb-reset", ordinal: 0 } };

    const first = await accumulator.recordReset(key, stamp);
    const replayed = await accumulator.recordReset(key, stamp);

    // The epoch number is what stops a consumer summing across a counter restart.
    // Inflating it twice for one restart makes one real series look like two.
    expect(first.epoch).toBe(1);
    expect(replayed.epoch).toBe(1);
  });

  it("still opens a new epoch for a genuinely different delivery", async () => {
    const { accumulator } = build();

    expect((await accumulator.recordReset(key, { delivery: { callbackId: "cb-1", ordinal: 0 } })).epoch).toBe(1);
    expect((await accumulator.recordReset(key, { delivery: { callbackId: "cb-2", ordinal: 0 } })).epoch).toBe(2);
    expect((await accumulator.recordReset(key)).epoch).toBe(3);
  });

  it("keeps the reset and the delta of one replayed delivery consistent", async () => {
    const { accumulator } = build();
    const stamp = { delivery: { callbackId: "cb-both", ordinal: 0 } };

    await accumulator.accumulateDelta(key, delta({ inputTokens: 99 }));
    // A delivery whose provider counter restarted: reset, then its own delta.
    await accumulator.recordReset(key, stamp);
    await accumulator.accumulateDelta(key, delta({ inputTokens: 7 }), stamp);

    // Replaying it must neither re-zero the total nor re-add the delta.
    await accumulator.recordReset(key, stamp);
    await accumulator.accumulateDelta(key, delta({ inputTokens: 7 }), stamp);

    const snapshot = await accumulator.read(key);
    expect(snapshot?.total.inputTokens).toBe(7);
    expect(snapshot?.epoch).toBe(1);
  });

  it("accumulates onto a total that predates the marker rather than refusing it", async () => {
    const { accumulator } = build();

    // A record written before the marker existed carries no provenance. That reads
    // as "unknown", which forgoes the check — the alternative, treating an unmarked
    // record as unsafe, would refuse a real observation to protect against a
    // duplicate that may not exist.
    await accumulator.accumulateDelta(key, delta({ inputTokens: 5 }));
    const next = await accumulator.accumulateDelta(key, delta({ inputTokens: 5 }), {
      delivery: { callbackId: "cb-new", ordinal: 0 },
    });
    expect(next.total.inputTokens).toBe(10);
  });
});
