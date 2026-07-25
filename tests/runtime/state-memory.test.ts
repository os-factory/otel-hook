import { describe, expect, it } from "vitest";

import { createFixedClock } from "../../src/runtime/clock.js";
import { createBoundedMemoryStateStore } from "../../src/state/memory-store.js";

describe("createBoundedMemoryStateStore", () => {
  it("round-trips a value and increments revision on each write", async () => {
    const store = createBoundedMemoryStateStore({ clock: createFixedClock() });
    const first = await store.write("k1", { kind: "sequence", next: 1 });
    expect(first.revision).toBe(1);
    const second = await store.write("k1", { kind: "sequence", next: 2 });
    expect(second.revision).toBe(2);

    const read = await store.read("k1");
    expect(read?.value).toEqual({ kind: "sequence", next: 2 });
  });

  it("returns undefined for an absent key and after delete", async () => {
    const store = createBoundedMemoryStateStore({ clock: createFixedClock() });
    expect(await store.read("missing")).toBeUndefined();
    await store.write("k1", { kind: "sequence", next: 1 });
    await store.delete("k1");
    expect(await store.read("k1")).toBeUndefined();
  });

  it("filters keys by prefix and returns them sorted", async () => {
    const store = createBoundedMemoryStateStore({ clock: createFixedClock() });
    await store.write("usage:a:x", { kind: "sequence", next: 1 });
    await store.write("usage:b:x", { kind: "sequence", next: 1 });
    await store.write("sequence:a", { kind: "sequence", next: 1 });

    expect(await store.keys("usage:")).toEqual(["usage:a:x", "usage:b:x"]);
  });

  it("evicts the oldest entry once over capacity", async () => {
    const clock = createFixedClock({ tickMillis: 1 });
    const store = createBoundedMemoryStateStore({ clock, maxEntries: 2 });
    await store.write("a", { kind: "sequence", next: 1 });
    await store.write("b", { kind: "sequence", next: 1 });
    await store.write("c", { kind: "sequence", next: 1 });

    expect(store.size()).toBe(2);
    expect(await store.read("a")).toBeUndefined();
    expect(await store.read("b")).toBeDefined();
    expect(await store.read("c")).toBeDefined();
  });

  it("expires entries older than the configured ttl", async () => {
    const clock = createFixedClock({ tickMillis: 0 });
    const store = createBoundedMemoryStateStore({ clock, ttlMillis: 100 });
    await store.write("a", { kind: "sequence", next: 1 });
    clock.advance(150);
    expect(await store.read("a")).toBeUndefined();
  });

  it("actively prunes expired entries on demand", async () => {
    const clock = createFixedClock();
    const store = createBoundedMemoryStateStore({ clock, ttlMillis: 100 });
    await store.write("a", { kind: "sequence", next: 1 });
    await store.write("b", { kind: "sequence", next: 1 });
    clock.advance(150);
    const removed = store.pruneExpired();
    expect(removed).toBe(2);
    expect(store.size()).toBe(0);
  });

  it("serializes concurrent writes to the same key without losing an update", async () => {
    const store = createBoundedMemoryStateStore({ clock: createFixedClock() });
    await store.write("counter", { kind: "sequence", next: 0 });

    const increment = async (): Promise<void> => {
      const record = await store.read("counter");
      const next = record?.value.kind === "sequence" ? record.value.next : 0;
      await store.write("counter", { kind: "sequence", next: next + 1 });
    };

    // Each increment is itself only safe under the store's own per-key lock
    // because `read` and `write` are individually serialized; wrap the whole
    // read-modify-write in the store's lock to prove that composition works.
    await Promise.all(
      Array.from({ length: 25 }, () => store.withSessionLock("counter-session", increment)),
    );

    const finalRecord = await store.read("counter");
    expect(finalRecord?.value).toEqual({ kind: "sequence", next: 25 });
  });

  it("bounds how long withSessionLock waits when a holder never releases", async () => {
    const store = createBoundedMemoryStateStore({ clock: createFixedClock(), lockTimeoutMillis: 50 });
    let releaseHolder: () => void = () => undefined;
    const holderGate = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const holder = store.withSessionLock("s1", () => holderGate);

    await expect(
      store.withSessionLock("s1", () => Promise.resolve(), { timeoutMillis: 30 }),
    ).rejects.toThrow(/lock wait exceeded/);

    releaseHolder();
    await holder;
  });
});
