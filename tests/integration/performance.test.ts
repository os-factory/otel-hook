import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { resourceFromAttributes } from "@opentelemetry/resources";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { normalizeUsageOrThrow } from "../../src/model/usage.js";
import { createUsageAccumulator } from "../../src/lifecycle/usage-accumulator.js";
import { createBoundedMemoryStateStore } from "../../src/state/memory-store.js";
import { createFilesystemStateStore } from "../../src/state/filesystem-store.js";
import { createSystemClock } from "../../src/runtime/clock.js";
import { canonicalEventsToReadableSpans } from "../../src/telemetry/semconv.js";
import { createTestIdentity } from "../../src/testing/index.js";
import { parseCanonicalEvent } from "../../src/model/events.js";
import { CANONICAL_SCHEMA_VERSION } from "../../src/model/version.js";

/**
 * Simple, generous-threshold throughput checks.
 *
 * These are not micro-benchmarks: the thresholds are set an order of
 * magnitude below what a healthy laptop or CI runner achieves, so the goal is
 * catching an accidental O(n^2) regression or a lock that serializes work
 * that should be concurrent — not tracking absolute numbers precisely.
 */
const OPERATION_COUNT = 2_000;

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(tmpdir(), "otel-hook-perf-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("performance benchmarks", () => {
  it(`performs ${OPERATION_COUNT} sequential in-memory state store writes well within budget`, async () => {
    const store = createBoundedMemoryStateStore({ clock: createSystemClock() });
    const startedAt = performance.now();
    for (let index = 0; index < OPERATION_COUNT; index += 1) {
      await store.write(`key-${index}`, { kind: "sequence", next: index });
    }
    const elapsedMillis = performance.now() - startedAt;
    const perOperationMicros = (elapsedMillis * 1000) / OPERATION_COUNT;
    console.log(`in-memory store: ${OPERATION_COUNT} writes in ${elapsedMillis.toFixed(1)}ms (${perOperationMicros.toFixed(1)}us/op)`);
    expect(elapsedMillis).toBeLessThan(2_000);
  });

  it(`performs ${OPERATION_COUNT} concurrent filesystem state store writes across distinct keys well within budget`, async () => {
    const store = createFilesystemStateStore({
      rootDir,
      providerId: "acme-cli",
      installationId: "install-1",
      clock: createSystemClock(),
    });
    const startedAt = performance.now();
    const CONCURRENCY = 32;
    for (let batch = 0; batch < OPERATION_COUNT / CONCURRENCY; batch += 1) {
      await Promise.all(
        Array.from({ length: CONCURRENCY }, (_, offset) => {
          const index = batch * CONCURRENCY + offset;
          return store.write(`key-${index}`, { kind: "sequence", next: index });
        }),
      );
    }
    const elapsedMillis = performance.now() - startedAt;
    console.log(`filesystem store: ${OPERATION_COUNT} writes in ${elapsedMillis.toFixed(1)}ms`);
    expect(elapsedMillis).toBeLessThan(20_000);
  }, 30_000);

  it(`rolls up ${OPERATION_COUNT} usage deltas for one scope well within budget`, async () => {
    const accumulator = createUsageAccumulator({
      stateStore: createBoundedMemoryStateStore({ clock: createSystemClock() }),
      clock: createSystemClock(),
    });
    const key = { sessionId: "ses_perf", scope: "session", scopeKey: "ses_perf" };
    const delta = normalizeUsageOrThrow({ temporality: "delta", inputTokens: 1, outputTokens: 1 });

    const startedAt = performance.now();
    let last;
    for (let index = 0; index < OPERATION_COUNT; index += 1) {
      last = await accumulator.accumulateDelta(key, delta);
    }
    const elapsedMillis = performance.now() - startedAt;
    console.log(`usage accumulator: ${OPERATION_COUNT} accumulations in ${elapsedMillis.toFixed(1)}ms`);
    expect(last?.total.inputTokens).toBe(OPERATION_COUNT);
    expect(elapsedMillis).toBeLessThan(3_000);
  });

  it(`maps a batch of ${OPERATION_COUNT} canonical events to spans well within budget`, () => {
    const identity = createTestIdentity();
    const resource = resourceFromAttributes({ "service.name": "perf-test" });
    // Start/end pairs rather than lone starts: an unpaired start is deliberately
    // not exported, so a batch of them would map to nothing and measure nothing.
    // Pairs also exercise the grouping path, which is where an O(n^2) regression
    // would actually show up.
    const scopeCount = OPERATION_COUNT / 2;
    const events = Array.from({ length: OPERATION_COUNT }, (_, index) => {
      const scope = Math.floor(index / 2);
      const isStart = index % 2 === 0;
      return parseCanonicalEvent({
        schemaVersion: CANONICAL_SCHEMA_VERSION,
        invocationId: identity.invocationId,
        sessionId: identity.sessionId,
        provenance: identity.provenance,
        workspace: identity.workspace,
        extensions: {},
        eventId: `e${index}`,
        sequence: index,
        occurredAt: 1_000 + index,
        toolCallId: `call_${scope}`,
        toolName: "read_file",
        ...(isStart
          ? { type: "tool.start", toolKind: "read" }
          : { type: "tool.end", outcome: "ok" }),
      });
    });

    const startedAt = performance.now();
    const spans = canonicalEventsToReadableSpans(events, { resource });
    const elapsedMillis = performance.now() - startedAt;
    console.log(`semconv mapping: ${OPERATION_COUNT} events in ${elapsedMillis.toFixed(1)}ms`);
    expect(spans).toHaveLength(scopeCount);
    expect(elapsedMillis).toBeLessThan(2_000);
  });
});
