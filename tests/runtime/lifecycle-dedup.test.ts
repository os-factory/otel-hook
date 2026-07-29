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

  it("sweeps an aged-out completed record but holds back a claim a live process may own", async () => {
    const dedup = build();

    await dedup.claim("scope", "cb_claimed");
    await dedup.claim("scope", "cb_done");
    await dedup.commit("scope", "cb_done");

    // Past retention, but well inside the stale-claim window. Deleting the
    // uncommitted claim here would hand the callback to a concurrent delivery as
    // *fresh* while its holder is still exporting — retention silently turning
    // suppression into a double export.
    dedup.clock.advance(10_000);
    expect(await dedup.cleanup(5_000, { staleClaimMillis: 60_000 })).toEqual({
      removed: 1,
      scanned: 2,
      retainedInFlight: 1,
    });
    expect((await dedup.claim("scope", "cb_done")).outcome).toBe("fresh");
    // Held back, so a redelivery still stands down rather than exporting again.
    expect((await dedup.claim("scope", "cb_claimed", { staleClaimMillis: 60_000 })).outcome).toBe(
      "in-flight",
    );
  });

  it("sweeps a claim once it is past both retention and the stale-claim window", async () => {
    const dedup = build();

    await dedup.claim("scope", "cb_abandoned");
    dedup.clock.advance(70_000);

    expect(await dedup.cleanup(5_000, { staleClaimMillis: 60_000 })).toEqual({
      removed: 1,
      scanned: 1,
    });
  });

  it("bounds a sweep to maxEntries so a huge state store cannot stall a hook", async () => {
    const dedup = build();

    for (let index = 0; index < 20; index += 1) {
      await dedup.claim("scope", `cb_${String(index)}`);
    }
    // Past the stale window too, so the cap is what limits the sweep rather than
    // the in-flight protection.
    dedup.clock.advance(70_000);

    const swept = await dedup.cleanup(5_000, { maxEntries: 5, staleClaimMillis: 60_000 });
    expect(swept).toEqual({ removed: 5, scanned: 5 });
  });

  it("keeps a live claim out of the sweep even when retention is configured shorter", async () => {
    const dedup = build();

    // The reachable misconfiguration: a one-second retention with a one-minute
    // effective stale window. The sweep must defer to the longer of the two.
    await dedup.claim("scope", "cb_live", { staleClaimMillis: 60_000 });
    dedup.clock.advance(2_000);

    expect(await dedup.cleanup(1_000, { staleClaimMillis: 60_000 })).toMatchObject({
      removed: 0,
      retainedInFlight: 1,
    });
    expect((await dedup.claim("scope", "cb_live", { staleClaimMillis: 60_000 })).outcome).toBe(
      "in-flight",
    );
  });
});
