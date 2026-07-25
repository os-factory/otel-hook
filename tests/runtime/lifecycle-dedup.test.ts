import { describe, expect, it } from "vitest";

import { createFixedClock } from "../../src/runtime/clock.js";
import { createInMemoryStateStore } from "../../src/runtime/memory.js";
import { createCallbackDeduplicator } from "../../src/lifecycle/dedup.js";

describe("createCallbackDeduplicator", () => {
  it("marks a callback id seen once and flags every redelivery", async () => {
    const clock = createFixedClock();
    const stateStore = createInMemoryStateStore({ clock });
    const dedup = createCallbackDeduplicator({ stateStore, clock });

    expect((await dedup.checkAndMark("ses_1", "cb_1")).duplicate).toBe(false);
    expect((await dedup.checkAndMark("ses_1", "cb_1")).duplicate).toBe(true);
    expect((await dedup.checkAndMark("ses_1", "cb_1")).duplicate).toBe(true);
  });

  it("keeps two sessions' callback ids independent", async () => {
    const clock = createFixedClock();
    const stateStore = createInMemoryStateStore({ clock });
    const dedup = createCallbackDeduplicator({ stateStore, clock });

    expect((await dedup.checkAndMark("ses_a", "cb_1")).duplicate).toBe(false);
    expect((await dedup.checkAndMark("ses_b", "cb_1")).duplicate).toBe(false);
  });

  it("expires seen markers older than the cleanup age", async () => {
    const clock = createFixedClock();
    const stateStore = createInMemoryStateStore({ clock });
    const dedup = createCallbackDeduplicator({ stateStore, clock });

    await dedup.checkAndMark("ses_1", "cb_1");
    clock.advance(10_000);
    const result = await dedup.cleanup(5_000);
    expect(result.removed).toBe(1);

    expect((await dedup.checkAndMark("ses_1", "cb_1")).duplicate).toBe(false);
  });

  it("handles many distinct callback ids concurrently without cross-contamination", async () => {
    const clock = createFixedClock();
    const stateStore = createInMemoryStateStore({ clock });
    const dedup = createCallbackDeduplicator({ stateStore, clock });

    const ids = Array.from({ length: 50 }, (_, index) => `cb_${index}`);
    const results = await Promise.all(ids.map((id) => dedup.checkAndMark("ses_1", id)));
    expect(results.every((result) => !result.duplicate)).toBe(true);

    const redelivered = await Promise.all(ids.map((id) => dedup.checkAndMark("ses_1", id)));
    expect(redelivered.every((result) => result.duplicate)).toBe(true);
  });
});
