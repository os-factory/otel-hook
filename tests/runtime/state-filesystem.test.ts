import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFixedClock, type FixedClock } from "../../src/runtime/clock.js";
import { createFilesystemStateStore, type FilesystemStateStore } from "../../src/state/filesystem-store.js";

let rootDir: string;
let clock: FixedClock;

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(tmpdir(), "otel-hook-state-"));
  clock = createFixedClock({ tickMillis: 1 });
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

const createStore = (overrides: Partial<Parameters<typeof createFilesystemStateStore>[0]> = {}): FilesystemStateStore =>
  createFilesystemStateStore({
    rootDir,
    providerId: "acme-cli",
    installationId: "install-1",
    clock,
    lockTimeoutMillis: 200,
    lockPollIntervalMillis: 5,
    ...overrides,
  });

describe("createFilesystemStateStore", () => {
  it("round-trips a value through a real file and increments revision", async () => {
    const store = createStore();
    const first = await store.write("sequence:ses_1", { kind: "sequence", next: 1 });
    expect(first.revision).toBe(1);
    const second = await store.write("sequence:ses_1", { kind: "sequence", next: 2 });
    expect(second.revision).toBe(2);

    const read = await store.read("sequence:ses_1");
    expect(read?.value).toEqual({ kind: "sequence", next: 2 });
  });

  it("namespaces two providers or installations into disjoint directories", async () => {
    const a = createStore({ providerId: "provider-a", installationId: "install-1" });
    const b = createStore({ providerId: "provider-b", installationId: "install-1" });
    const c = createStore({ providerId: "provider-a", installationId: "install-2" });

    await a.write("k", { kind: "sequence", next: 1 });
    expect(await b.read("k")).toBeUndefined();
    expect(await c.read("k")).toBeUndefined();
    expect(await a.read("k")).toBeDefined();
  });

  it("never leaves a partially written record: rename lands the full file atomically", async () => {
    const store = createStore();
    await store.write("k", { kind: "attributes", attributes: { a: 1 } });
    const files = await readdir(store.recordsDir);
    const dataFiles = files.filter((entry) => entry.endsWith(".json") && !entry.startsWith(".tmp-"));
    expect(dataFiles).toHaveLength(1);
    // No temp files should survive a successful write.
    expect(files.some((entry) => entry.startsWith(".tmp-"))).toBe(false);

    const raw = await readFile(path.join(store.recordsDir, dataFiles[0] as string), "utf8");
    const envelope = JSON.parse(raw) as { key: string; record: { value: unknown } };
    expect(envelope.key).toBe("k");
    expect(envelope.record.value).toEqual({ kind: "attributes", attributes: { a: 1 } });
  });

  it("quarantines a record that fails to parse as JSON and treats it as absent", async () => {
    const store = createStore();
    await store.write("k", { kind: "sequence", next: 1 });
    const files = (await readdir(store.recordsDir)).filter((entry) => entry.endsWith(".json"));
    const filePath = path.join(store.recordsDir, files[0] as string);
    await writeFile(filePath, "{not json", "utf8");

    expect(await store.read("k")).toBeUndefined();
    const quarantined = await readdir(store.quarantineDir);
    expect(quarantined).toHaveLength(1);
  });

  it("quarantines a record that fails schema validation", async () => {
    const store = createStore();
    await store.write("k", { kind: "sequence", next: 1 });
    const files = (await readdir(store.recordsDir)).filter((entry) => entry.endsWith(".json"));
    const filePath = path.join(store.recordsDir, files[0] as string);
    await writeFile(filePath, JSON.stringify({ key: "k", record: { revision: "not-a-number" } }), "utf8");

    expect(await store.read("k")).toBeUndefined();
    const quarantined = await readdir(store.quarantineDir);
    expect(quarantined).toHaveLength(1);
  });

  it("keys(prefix) recovers the logical key from stored envelopes", async () => {
    const store = createStore();
    await store.write("usage:ses_1:generation:g1", { kind: "sequence", next: 1 });
    await store.write("usage:ses_1:tool:t1", { kind: "sequence", next: 1 });
    await store.write("sequence:ses_1", { kind: "sequence", next: 1 });

    expect(await store.keys("usage:ses_1:")).toEqual(["usage:ses_1:generation:g1", "usage:ses_1:tool:t1"]);
  });

  it("prunes records untouched for longer than the given age, bounded by maxEntries", async () => {
    const store = createStore();
    await store.write("old", { kind: "sequence", next: 1 });
    clock.advance(1_000);
    await store.write("new", { kind: "sequence", next: 1 });

    const result = await store.pruneStale(500);
    expect(result.removed).toBe(1);
    expect(await store.read("old")).toBeUndefined();
    expect(await store.read("new")).toBeDefined();
  });

  it("serializes withSessionLock across processes via a reclaimable stale lock file", async () => {
    const storeA = createStore({ lockStaleMillis: 20, lockPollIntervalMillis: 5, lockTimeoutMillis: 500 });
    const storeB = createStore({ lockStaleMillis: 20, lockPollIntervalMillis: 5, lockTimeoutMillis: 500 });

    // storeA acquires and never releases (simulating a crashed holder).
    const acquireOnly = new Promise<void>((resolve) => {
      void storeA.withSessionLock("ses_1", () => new Promise<void>(() => resolve()));
    });
    await acquireOnly;

    const order: string[] = [];
    await storeB.withSessionLock("ses_1", () => {
      order.push("b");
      return Promise.resolve();
    });
    expect(order).toEqual(["b"]);
  });

  it("bounds how long withSessionLock waits for a genuinely held lock", async () => {
    const store = createStore({ lockTimeoutMillis: 60, lockPollIntervalMillis: 5, lockStaleMillis: 10_000 });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalAcquired: () => void = () => undefined;
    const acquired = new Promise<void>((resolve) => {
      signalAcquired = resolve;
    });
    const holder = store.withSessionLock("ses_lock", () => {
      signalAcquired();
      return gate;
    });
    // Wait for the holder to actually be inside the lock. Without this the
    // contender below can win the file lock outright under CPU contention, and
    // the test passes or fails on scheduling rather than on the timeout bound.
    await acquired;

    await expect(
      createStore({ lockTimeoutMillis: 30, lockPollIntervalMillis: 5, lockStaleMillis: 10_000 }).withSessionLock(
        "ses_lock",
        () => Promise.resolve(),
      ),
    ).rejects.toThrow();

    release();
    await holder;
  });
});
