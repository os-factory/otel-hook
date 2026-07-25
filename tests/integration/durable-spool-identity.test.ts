import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFixedClock, type FixedClock } from "../../src/runtime/clock.js";
import { createFileDurableSpool, type SpoolBatch } from "../../src/telemetry/durable-spool.js";

let rootDir: string;
let clock: FixedClock;

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(tmpdir(), "otel-hook-spool-identity-"));
  clock = createFixedClock({ tickMillis: 1 });
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

const batchFor = (providerId: string, installationId: string): SpoolBatch => ({
  providerId,
  installationId,
  resourceAttributes: { "service.name": providerId },
  instrumentationScope: { name: "test" },
  spans: [
    {
      name: "span",
      kind: 0,
      traceId: "0".repeat(32),
      spanId: "0".repeat(16),
      startMillis: 0,
      endMillis: 0,
      attributes: {},
      statusCode: 0,
    },
  ],
  enqueuedAt: 0,
});

describe("durable spool: identity isolation", () => {
  it("keeps two providers sharing one rootDir in physically disjoint directories", async () => {
    const spoolA = createFileDurableSpool({ rootDir, providerId: "provider-a", installationId: "install-1", clock });
    const spoolB = createFileDurableSpool({ rootDir, providerId: "provider-b", installationId: "install-1", clock });

    await spoolA.enqueue(batchFor("provider-a", "install-1"));
    await spoolB.enqueue(batchFor("provider-b", "install-1"));

    expect(await spoolA.size()).toBe(1);
    expect(await spoolB.size()).toBe(1);

    const providerDirs = await readdir(rootDir);
    expect(providerDirs).toHaveLength(2);

    const seenByA: SpoolBatch[] = [];
    await spoolA.drain((batch) => {
      seenByA.push(batch);
      return Promise.resolve(true);
    });
    expect(seenByA).toHaveLength(1);
    expect(seenByA[0]?.providerId).toBe("provider-a");
    // Draining A must never see B's file, whatever the directory layout.
    expect(await spoolB.size()).toBe(1);
  });

  it("keeps two installations of the same provider isolated", async () => {
    const spoolOne = createFileDurableSpool({ rootDir, providerId: "acme", installationId: "install-1", clock });
    const spoolTwo = createFileDurableSpool({ rootDir, providerId: "acme", installationId: "install-2", clock });

    await spoolOne.enqueue(batchFor("acme", "install-1"));
    expect(await spoolTwo.size()).toBe(0);
    expect(await spoolOne.size()).toBe(1);
  });

  it("quarantines a spooled batch whose identity does not match the reading spool", async () => {
    const spoolA = createFileDurableSpool({ rootDir, providerId: "provider-a", installationId: "install-1", clock });
    // Enqueue a batch whose *content* claims a different identity than the
    // directory it physically lives in — simulating a hand-edited or corrupted
    // file rather than a real cross-identity delivery, which the directory
    // layout already makes impossible.
    await spoolA.enqueue(batchFor("someone-else", "install-1"));

    const delivered = await spoolA.drain(() => Promise.resolve(true));
    expect(delivered).toEqual({ drained: 0, remaining: 0, failed: 0 });
    expect(await spoolA.size()).toBe(0);
  });

  it("refuses new entries once at capacity rather than growing without bound", async () => {
    const spool = createFileDurableSpool({
      rootDir,
      providerId: "acme",
      installationId: "install-1",
      clock,
      maxSpoolFiles: 2,
    });
    expect((await spool.enqueue(batchFor("acme", "install-1"))).spooled).toBe(true);
    expect((await spool.enqueue(batchFor("acme", "install-1"))).spooled).toBe(true);
    const third = await spool.enqueue(batchFor("acme", "install-1"));
    expect(third).toEqual({ spooled: false, reason: "capacity-exceeded" });
    expect(await spool.size()).toBe(2);
  });
});
