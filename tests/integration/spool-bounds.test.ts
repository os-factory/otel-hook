import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFixedClock, type FixedClock } from "../../src/runtime/clock.js";
import { createFileDurableSpool, type SpoolBatch } from "../../src/telemetry/durable-spool.js";
import { readSpoolQueueStats } from "../../src/telemetry/spool-queue.js";

/**
 * Bounds of a per-destination spool: size, age, and count, oldest dropped first,
 * every drop counted on disk. Batches are synthetic; nothing here is a real span.
 */

let rootDir: string;
let clock: FixedClock;

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(tmpdir(), "otel-hook-spool-bounds-"));
  clock = createFixedClock({ tickMillis: 1 });
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

const batch = (marker: string, padding = 0): SpoolBatch => ({
  providerId: "acme",
  installationId: "install-1",
  resourceAttributes: { "service.name": "acme" },
  instrumentationScope: { name: "test" },
  spans: [
    {
      name: marker,
      kind: 0,
      traceId: "0".repeat(32),
      spanId: "0".repeat(16),
      startMillis: 0,
      endMillis: 0,
      attributes: padding === 0 ? {} : { pad: "p".repeat(padding) },
      statusCode: 0,
    },
  ],
  enqueuedAt: 0,
});

const queueDir = (queueName: string): string => path.join(rootDir, "acme", "install-1", queueName);

const drainedNames = async (spool: ReturnType<typeof createFileDurableSpool>): Promise<string[]> => {
  const names: string[] = [];
  await spool.drain((queued) => {
    names.push(queued.spans[0]?.name ?? "");
    return Promise.resolve(true);
  });
  return names;
};

const bounded = (overrides: Partial<Parameters<typeof createFileDurableSpool>[0]> = {}) =>
  createFileDurableSpool({
    rootDir,
    providerId: "acme",
    installationId: "install-1",
    clock,
    queueName: "destinations/collector/spool",
    overflow: "drop-oldest",
    ...overrides,
  });

describe("per-destination spool bounds", () => {
  it("queues under its own destination directory", async () => {
    const spool = bounded();
    await spool.enqueue(batch("one"));
    const files = await readdir(queueDir("destinations/collector/spool"));
    expect(files.filter((file) => file.endsWith(".json"))).toHaveLength(1);
    expect(await readdir(path.join(rootDir, "acme", "install-1"))).toEqual(["destinations"]);
  });

  it("drops the oldest batch first when the count bound is reached, and counts it", async () => {
    const spool = bounded({ maxSpoolFiles: 2 });
    for (const marker of ["first", "second", "third"]) {
      expect((await spool.enqueue(batch(marker))).spooled).toBe(true);
    }
    const stats = await spool.stats?.();
    expect(stats?.batches).toBe(2);
    expect(stats?.dropped).toMatchObject({ total: 1, count: 1, age: 0, size: 0, rejected: 0 });
    expect(await drainedNames(spool)).toEqual(["second", "third"]);
  });

  it("drops the oldest batches first to stay within the byte bound", async () => {
    // Each batch is a little over 1 KiB; three fit under 4 KiB, a fourth does not.
    const spool = bounded({ maxBytes: 4_096 });
    for (const marker of ["a", "b", "c", "d"]) {
      expect((await spool.enqueue(batch(marker, 1_024))).spooled).toBe(true);
    }
    const stats = await spool.stats?.();
    expect(stats?.bytes).toBeLessThanOrEqual(4_096);
    expect(stats?.dropped.size).toBeGreaterThanOrEqual(1);
    const names = await drainedNames(spool);
    expect(names.at(-1)).toBe("d");
    expect(names).not.toContain("a");
  });

  it("refuses, and counts, a single batch larger than the whole byte budget", async () => {
    const spool = bounded({ maxBytes: 2_048 });
    await spool.enqueue(batch("small"));
    expect(await spool.enqueue(batch("huge", 4_096))).toEqual({
      spooled: false,
      reason: "capacity-exceeded",
    });
    expect((await spool.stats?.())?.dropped).toMatchObject({ total: 1, size: 1 });
    // What was already queued is untouched.
    expect(await drainedNames(spool)).toEqual(["small"]);
  });

  it("drops batches older than the age bound, at enqueue and at drain, without sending them", async () => {
    const spool = bounded({ maxAgeMillis: 60_000 });
    await spool.enqueue(batch("stale"));
    clock.advance(120_000);
    await spool.enqueue(batch("fresh"));
    expect((await spool.stats?.())?.dropped).toMatchObject({ total: 1, age: 1 });

    clock.advance(120_000);
    const sent: string[] = [];
    const result = await spool.drain((queued) => {
      sent.push(queued.spans[0]?.name ?? "");
      return Promise.resolve(true);
    });
    expect(sent).toEqual([]);
    expect(result.remaining).toBe(0);
    expect((await spool.stats?.())?.dropped).toMatchObject({ total: 2, age: 2 });
  });

  it("discards a batch the destination permanently refused, and keeps draining behind it", async () => {
    const spool = bounded();
    await spool.enqueue(batch("refused"));
    await spool.enqueue(batch("deliverable"));
    const sent: string[] = [];
    const result = await spool.drain((queued) => {
      const name = queued.spans[0]?.name ?? "";
      sent.push(name);
      return Promise.resolve(name === "refused" ? "discard" : true);
    });
    expect(sent).toEqual(["refused", "deliverable"]);
    expect(result).toMatchObject({ drained: 1, failed: 0, remaining: 0 });
    expect((await spool.stats?.())?.dropped).toMatchObject({ total: 1, rejected: 1 });
  });

  it("holds a batch that keeps failing retryably only until the age bound, then drains behind it", async () => {
    // A destination answering 500 (retryable) to one batch forever: each drain
    // stops at it, but it is still the oldest batch, so the age bound — checked
    // on every drain and enqueue — drops it, and the queue moves on.
    const spool = bounded({ maxAgeMillis: 60_000 });
    await spool.enqueue(batch("stuck"));
    clock.advance(30_000);
    await spool.enqueue(batch("behind"));

    const attempts: string[] = [];
    const sendStuckFails = (queued: SpoolBatch): Promise<boolean> => {
      const name = queued.spans[0]?.name ?? "";
      attempts.push(name);
      return Promise.resolve(name !== "stuck");
    };
    for (let invocation = 0; invocation < 3; invocation += 1) {
      expect(await spool.drain(sendStuckFails)).toMatchObject({ drained: 0, failed: 1, remaining: 2 });
      clock.advance(5_000);
    }
    expect(attempts).toEqual(["stuck", "stuck", "stuck"]);

    clock.advance(30_000);
    expect(await spool.drain(sendStuckFails)).toMatchObject({ drained: 1, failed: 0, remaining: 0 });
    expect(attempts.at(-1)).toBe("behind");
    expect((await spool.stats?.())?.dropped).toMatchObject({ total: 1, age: 1 });
  });

  it("evicts a batch that keeps failing retryably once newer batches reach the count bound", async () => {
    const spool = bounded({ maxSpoolFiles: 2 });
    await spool.enqueue(batch("stuck"));
    expect(await spool.drain(() => Promise.resolve(false))).toMatchObject({ failed: 1, remaining: 1 });
    await spool.enqueue(batch("second"));
    await spool.enqueue(batch("third"));
    expect(await drainedNames(spool)).toEqual(["second", "third"]);
    expect((await spool.stats?.())?.dropped).toMatchObject({ total: 1, count: 1 });
  });

  it("persists drop counts across instances, so a later process can report them", async () => {
    await bounded({ maxSpoolFiles: 1 }).enqueue(batch("one"));
    await bounded({ maxSpoolFiles: 1 }).enqueue(batch("two"));
    await bounded({ maxSpoolFiles: 1 }).enqueue(batch("three"));
    const stats = await readSpoolQueueStats(queueDir("destinations/collector/spool"));
    expect(stats.batches).toBe(1);
    expect(stats.dropped).toMatchObject({ total: 2, count: 2 });
    expect(stats.dropped.lastDroppedAt).toBeTypeOf("number");
    expect(stats.oldestEnqueuedAt).toBeTypeOf("number");
  });

  it("reads an absent queue as empty without creating it", async () => {
    const stats = await readSpoolQueueStats(queueDir("destinations/never/spool"));
    expect(stats).toEqual({
      batches: 0,
      bytes: 0,
      dropped: { total: 0, age: 0, size: 0, count: 0, rejected: 0 },
    });
    expect(await readdir(rootDir)).toEqual([]);
  });

  it("keeps the original refuse-new behavior for a queue built without an overflow policy", async () => {
    const spool = createFileDurableSpool({
      rootDir,
      providerId: "acme",
      installationId: "install-1",
      clock,
      maxSpoolFiles: 1,
    });
    await spool.enqueue(batch("kept"));
    expect((await spool.enqueue(batch("refused"))).spooled).toBe(false);
    expect(await drainedNames(spool)).toEqual(["kept"]);
    expect((await spool.stats?.())?.dropped).toMatchObject({ total: 1, count: 1 });
  });
});
