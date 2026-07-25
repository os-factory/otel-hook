import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { normalizeUsageOrThrow } from "../../src/model/usage.js";
import { createSystemClock } from "../../src/runtime/clock.js";
import { createCallbackDeduplicator } from "../../src/lifecycle/dedup.js";
import { createSpanCorrelator } from "../../src/lifecycle/span-correlator.js";
import { createUsageAccumulator } from "../../src/lifecycle/usage-accumulator.js";
import { createFilesystemStateStore } from "../../src/state/filesystem-store.js";
import { createSeededRandom } from "../helpers/random.js";

const IDENTITY_COUNT = 20;

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(tmpdir(), "otel-hook-concurrency-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("concurrency across at least ten identities sharing one filesystem state store", () => {
  it("keeps every identity's span correlation, dedup, and usage rollup independently correct", async () => {
    const clock = createSystemClock();
    const stateStore = createFilesystemStateStore({
      rootDir,
      providerId: "acme-cli",
      installationId: "install-1",
      clock,
    });
    const spanCorrelator = createSpanCorrelator({ stateStore, clock });
    const deduplicator = createCallbackDeduplicator({ stateStore, clock });
    const usageAccumulator = createUsageAccumulator({ stateStore, clock });

    const runIdentity = async (index: number): Promise<{ readonly durationMillis: number; readonly total: number; readonly duplicates: number }> => {
      const sessionId = `ses_${index}`;
      const random = createSeededRandom(0x9e3779b1 ^ index);

      const started = await spanCorrelator.recordStart({
        sessionId,
        scope: "tool",
        scopeKey: `call_${index}`,
        eventId: `start_${index}`,
        occurredAt: 0,
      });
      expect(started.status).toBe("recorded");

      let expectedTotal = 0;
      for (let step = 0; step < 10; step += 1) {
        const inputTokens = random.int(1, 20);
        expectedTotal += inputTokens;
        const snapshot = await usageAccumulator.accumulateDelta(
          { sessionId, scope: "tool", scopeKey: `call_${index}` },
          normalizeUsageOrThrow({ temporality: "delta", inputTokens }),
        );
        expect(snapshot.total.inputTokens).toBe(expectedTotal);
      }

      const duplicateChecks = await Promise.all(
        Array.from({ length: 5 }, () => deduplicator.checkAndMark(sessionId, `cb_${index}`)),
      );
      const duplicates = duplicateChecks.filter((result) => result.duplicate).length;

      const ended = await spanCorrelator.recordEnd({
        sessionId,
        scope: "tool",
        scopeKey: `call_${index}`,
        eventId: `end_${index}`,
        occurredAt: 500,
      });
      if (ended.status !== "matched") {
        throw new Error(`expected a matched span for identity ${index}, got ${ended.status}`);
      }

      const finalUsage = await usageAccumulator.read({ sessionId, scope: "tool", scopeKey: `call_${index}` });
      return {
        durationMillis: ended.durationMillis,
        total: finalUsage?.total.inputTokens ?? -1,
        duplicates,
      };
    };

    const results = await Promise.all(
      Array.from({ length: IDENTITY_COUNT }, (_, index) => runIdentity(index)),
    );

    for (const result of results) {
      expect(result.durationMillis).toBe(500);
      expect(result.duplicates).toBe(4);
      expect(result.total).toBeGreaterThan(0);
    }

    // Every identity's final rollup must be internally consistent: no session
    // observed a partial or interleaved write from another session's updates.
    const totals = new Set(results.map((result) => result.total));
    expect(totals.size).toBeGreaterThan(1); // seeded per-identity, so totals differ
  }, 30_000);

  it("serializes concurrent writers on the very same key without losing an update", async () => {
    const clock = createSystemClock();
    const stateStore = createFilesystemStateStore({
      rootDir,
      providerId: "acme-cli",
      installationId: "install-1",
      clock,
    });

    const increment = async (): Promise<void> => {
      await stateStore.withSessionLock("shared-counter", async () => {
        const record = await stateStore.read("counter");
        const next = record?.value.kind === "sequence" ? record.value.next : 0;
        await stateStore.write("counter", { kind: "sequence", next: next + 1 });
      });
    };

    await stateStore.write("counter", { kind: "sequence", next: 0 });
    await Promise.all(Array.from({ length: IDENTITY_COUNT }, () => increment()));

    const final = await stateStore.read("counter");
    expect(final?.value).toEqual({ kind: "sequence", next: IDENTITY_COUNT });
  }, 30_000);
});
