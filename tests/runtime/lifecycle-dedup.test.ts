import { describe, expect, it } from "vitest";

import { createFixedClock } from "../../src/runtime/clock.js";
import { createInMemoryStateStore } from "../../src/runtime/memory.js";
import { createBoundedMemoryStateStore } from "../../src/state/memory-store.js";
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

describe("createCallbackDeduplicator: two-phase claims", () => {
  const build = (): ReturnType<typeof createCallbackDeduplicator> & {
    readonly clock: ReturnType<typeof createFixedClock>;
  } => {
    const clock = createFixedClock();
    // The bounded store, not the unlocked test double: two-phase claiming is only
    // a guarantee when the store can serialize a read-modify-write per scope.
    const stateStore = createBoundedMemoryStateStore({ clock });
    return { ...createCallbackDeduplicator({ stateStore, clock }), clock };
  };

  it("grants the first claim and refuses a redelivery once it is committed", async () => {
    const dedup = build();

    const first = await dedup.claim("scope", "cb_1");
    expect(first).toMatchObject({ outcome: "fresh", duplicate: false, owned: true, attempt: 1 });
    await dedup.commit("scope", "cb_1");

    const second = await dedup.claim("scope", "cb_1");
    expect(second).toMatchObject({ outcome: "duplicate", duplicate: true, owned: false });
  });

  it("refuses a second delivery while the first is still in flight", async () => {
    const dedup = build();

    // No commit in between: this is the crash window, and the point of claiming
    // before exporting is that a peer arriving inside it stands down.
    await dedup.claim("scope", "cb_1");
    const concurrent = await dedup.claim("scope", "cb_1");
    expect(concurrent).toMatchObject({ outcome: "in-flight", duplicate: true, owned: false });
  });

  it("grants exactly one owner when many deliveries race the same id", async () => {
    const dedup = build();

    const results = await Promise.all(
      Array.from({ length: 12 }, () => dedup.claim("scope", "cb_race")),
    );

    expect(results.filter((result) => result.owned)).toHaveLength(1);
    expect(results.filter((result) => result.duplicate)).toHaveLength(11);
  });

  it("takes over a claim no process ever committed, once it is old enough", async () => {
    const dedup = build();

    await dedup.claim("scope", "cb_1", { staleClaimMillis: 30_000 });
    // Still inside the window: assume the peer is alive and working.
    dedup.clock.advance(29_000);
    expect((await dedup.claim("scope", "cb_1", { staleClaimMillis: 30_000 })).outcome).toBe(
      "in-flight",
    );

    dedup.clock.advance(2_000);
    const reclaimed = await dedup.claim("scope", "cb_1", { staleClaimMillis: 30_000 });
    expect(reclaimed).toMatchObject({ outcome: "reclaimed", duplicate: false, owned: true, attempt: 2 });
    expect(reclaimed.abandonedForMillis).toBeGreaterThan(30_000);
  });

  it("never takes over a committed claim, however old it is", async () => {
    const dedup = build();

    await dedup.claim("scope", "cb_1");
    await dedup.commit("scope", "cb_1");
    dedup.clock.advance(365 * 24 * 60 * 60 * 1000);

    expect((await dedup.claim("scope", "cb_1", { staleClaimMillis: 1 })).outcome).toBe("duplicate");
  });

  it("releases an uncommitted claim but leaves a committed one alone", async () => {
    const dedup = build();

    await dedup.claim("scope", "cb_open");
    await dedup.release("scope", "cb_open");
    expect((await dedup.claim("scope", "cb_open")).outcome).toBe("fresh");

    await dedup.commit("scope", "cb_open");
    await dedup.release("scope", "cb_open");
    expect((await dedup.claim("scope", "cb_open")).outcome).toBe("duplicate");
  });

  it("keeps two scopes' callback ids independent", async () => {
    const dedup = build();

    expect((await dedup.claim("scope_a", "cb_1")).outcome).toBe("fresh");
    expect((await dedup.claim("scope_b", "cb_1")).outcome).toBe("fresh");
  });

  it("reads a record written by the single-phase path as already completed", async () => {
    const dedup = build();

    await dedup.checkAndMark("scope", "cb_1");
    expect((await dedup.claim("scope", "cb_1")).outcome).toBe("duplicate");
  });

  it("sweeps claimed and completed records alike once they age out", async () => {
    const dedup = build();

    await dedup.claim("scope", "cb_claimed");
    await dedup.claim("scope", "cb_done");
    await dedup.commit("scope", "cb_done");

    dedup.clock.advance(10_000);
    expect(await dedup.cleanup(5_000)).toEqual({ removed: 2, scanned: 2 });
    expect((await dedup.claim("scope", "cb_done")).outcome).toBe("fresh");
  });

  it("bounds a sweep to maxEntries so a huge state store cannot stall a hook", async () => {
    const dedup = build();

    for (let index = 0; index < 20; index += 1) {
      await dedup.claim("scope", `cb_${String(index)}`);
    }
    dedup.clock.advance(10_000);

    const swept = await dedup.cleanup(5_000, { maxEntries: 5 });
    expect(swept).toEqual({ removed: 5, scanned: 5 });
  });
});
