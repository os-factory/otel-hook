import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFixedClock } from "../../src/runtime/clock.js";
import { sanitizeSegment } from "../../src/state/keys.js";
import { createFileDurableSpool, validateSpoolBatch, type SpoolBatch } from "../../src/telemetry/durable-spool.js";
import { createSpoolQueue } from "../../src/telemetry/spool-queue.js";

/**
 * Many sessions on one machine share one spool per destination, and every hook
 * process drains it at flush. Two drains running at once must not both send the
 * same batch (seen in the agent lab's concurrency scenario as duplicate spans
 * and log records once a destination came back).
 */

const PROVIDER = "acme-cli";
const INSTALLATION = "install-1";

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(tmpdir(), "otel-hook-spool-drain-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

const spoolDir = (): string => path.join(rootDir, sanitizeSegment(PROVIDER), INSTALLATION, "spool");

const batch = (spanId: string): Record<string, unknown> => ({
  providerId: PROVIDER,
  installationId: INSTALLATION,
  resourceAttributes: { "service.name": "obs" },
  instrumentationScope: { name: "otel-hook" },
  spans: [
    {
      name: "tool read_file",
      kind: 0,
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId,
      startMillis: 1_000,
      endMillis: 1_750,
      attributes: {},
      statusCode: 0,
    },
  ],
  enqueuedAt: 1_700_000_000_000,
});

const plant = async (order: number, spanId: string): Promise<string> => {
  await mkdir(spoolDir(), { recursive: true });
  const name = `${String(order).padStart(16, "0")}-planted.json`;
  await writeFile(path.join(spoolDir(), name), JSON.stringify(batch(spanId)), "utf8");
  return name;
};

/** A claim another drain holds on a queued batch, as `drain` writes it. */
const claim = (name: string, pid: number, claimedAt: number): Promise<void> =>
  writeFile(
    path.join(spoolDir(), `${name}.claim`),
    JSON.stringify({ token: "0".repeat(32), pid, claimedAt }),
    { encoding: "utf8", flag: "wx" },
  );

const makeSpool = (): ReturnType<typeof createFileDurableSpool> =>
  createFileDurableSpool({ rootDir, providerId: PROVIDER, installationId: INSTALLATION, clock: createFixedClock() });

describe("concurrent drains of one spool", () => {
  it("deliver every batch exactly once", async () => {
    const ids = Array.from({ length: 12 }, (_, index) => index.toString(16).padStart(16, "0"));
    for (const [index, id] of ids.entries()) {
      await plant(index + 1, id);
    }
    const sent: string[] = [];
    const send = async (spooled: { readonly spans: readonly { readonly spanId: string }[] }): Promise<boolean> => {
      // Slow enough that the drains overlap on every file.
      await new Promise((resolve) => setTimeout(resolve, 5));
      sent.push(...spooled.spans.map((span) => span.spanId));
      return true;
    };
    const results = await Promise.all(Array.from({ length: 4 }, () => makeSpool().drain(send)));

    expect([...sent].sort()).toEqual([...ids].sort());
    expect(results.reduce((sum, result) => sum + result.drained, 0)).toBe(ids.length);
    expect(results.every((result) => result.quarantined === 0)).toBe(true);
    expect(await readdir(spoolDir())).toEqual([]);
  });

  it("puts a batch whose send failed back in the queue under its own name", async () => {
    const name = await plant(1, "00000000000000aa");
    const result = await makeSpool().drain(() => Promise.resolve(false));
    expect(result.failed).toBe(1);
    expect(await readdir(spoolDir())).toEqual([name]);
  });

  it("releases a claim a crashed drain left behind once it is stale, and never a fresh one", async () => {
    const name = await plant(1, "00000000000000bb");
    // A drain of a live process (this one) holds it: only age can release it.
    await claim(name, process.pid, Date.now());

    const sent: string[] = [];
    const queue = (claimStaleMillis: number): ReturnType<typeof createSpoolQueue<SpoolBatch>> =>
      createSpoolQueue<SpoolBatch>({
        rootDir,
        providerId: PROVIDER,
        installationId: INSTALLATION,
        clock: createFixedClock(),
        maxFiles: 100,
        queueName: "spool",
        claimStaleMillis,
        validate: validateSpoolBatch,
      });
    const send = (spooled: SpoolBatch): Promise<boolean> => {
      sent.push(...spooled.spans.map((span) => span.spanId));
      return Promise.resolve(true);
    };

    // Fresh: its owner may still be sending it.
    expect((await queue(60_000).drain(send)).drained).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Stale: back in the queue and delivered.
    expect((await queue(5).drain(send)).drained).toBe(1);
    expect(sent).toEqual(["00000000000000bb"]);
    expect(await readdir(spoolDir())).toEqual([]);
  });

  it("releases at once a claim whose process has exited", async () => {
    const name = await plant(1, "00000000000000cc");
    // A hook that exited at its flush deadline while sending: a pid that cannot exist.
    await claim(name, 2147483646, Date.now());
    const sent: string[] = [];
    const result = await makeSpool().drain((spooled) => {
      sent.push(...spooled.spans.map((span) => span.spanId));
      return Promise.resolve(true);
    });
    expect(result.drained).toBe(1);
    expect(sent).toEqual(["00000000000000cc"]);
  });

  it("never sends a batch another live drain holds, and leaves no claim behind", async () => {
    const held = await plant(1, "00000000000000d1");
    await plant(2, "00000000000000d2");
    await claim(held, process.pid, Date.now());
    const sent: string[] = [];
    const result = await makeSpool().drain((spooled) => {
      sent.push(...spooled.spans.map((span) => span.spanId));
      return Promise.resolve(true);
    });
    expect(sent).toEqual(["00000000000000d2"]);
    expect(result.drained).toBe(1);
    expect((await readdir(spoolDir())).sort()).toEqual([held, `${held}.claim`].sort());
  });

  it("removes a stale claim whose batch is already gone, and an old unreadable one", async () => {
    await mkdir(spoolDir(), { recursive: true });
    await claim("0000000000000009-gone.json", 2147483646, Date.now());
    const empty = path.join(spoolDir(), "0000000000000008-gone.json.claim");
    await writeFile(empty, "", "utf8");
    const old = new Date(Date.now() - 10 * 60 * 1000);
    await utimes(empty, old, old);
    // A claim created a moment ago and not yet written is live, whatever it reads as.
    await writeFile(path.join(spoolDir(), "0000000000000007-new.json.claim"), "", "utf8");
    await makeSpool().drain(() => Promise.resolve(true));
    expect(await readdir(spoolDir())).toEqual(["0000000000000007-new.json.claim"]);
  });
});
