import { describe, expect, it } from "vitest";

import { createFixedClock } from "../../src/runtime/clock.js";
import { createInMemoryStateStore } from "../../src/runtime/memory.js";
import {
  createSpanCorrelator,
  SPAN_RECORD_VERSION,
  type SpanCorrelator,
} from "../../src/lifecycle/span-correlator.js";

const PROVIDER = "acme-cli";

const harness = (
  options: { readonly maxStartAgeMillis?: number } = {},
): {
  readonly clock: ReturnType<typeof createFixedClock>;
  readonly stateStore: ReturnType<typeof createInMemoryStateStore>;
  readonly correlator: SpanCorrelator;
} => {
  const clock = createFixedClock();
  const stateStore = createInMemoryStateStore({ clock });
  const correlator = createSpanCorrelator({
    stateStore,
    clock,
    ...(options.maxStartAgeMillis === undefined
      ? {}
      : { maxStartAgeMillis: options.maxStartAgeMillis }),
  });
  return { clock, stateStore, correlator };
};

const toolStart = (overrides: Record<string, unknown> = {}) => ({
  sessionId: "ses_1",
  providerId: PROVIDER,
  scope: "tool" as const,
  scopeKey: "call_1",
  eventId: "evt_start",
  occurredAt: 1_000,
  ...overrides,
});

const toolEnd = (overrides: Record<string, unknown> = {}) => ({
  sessionId: "ses_1",
  providerId: PROVIDER,
  scope: "tool" as const,
  scopeKey: "call_1",
  eventId: "evt_end",
  occurredAt: 1_500,
  ...overrides,
});

describe("createSpanCorrelator", () => {
  it("computes a duration when the end arrives in a later invocation", async () => {
    const { correlator } = harness();

    const start = await correlator.recordStart(toolStart());
    expect(start.status).toBe("recorded");

    const end = await correlator.recordEnd(toolEnd());
    expect(end).toMatchObject({ status: "matched", startedAt: 1_000, durationMillis: 500 });
  });

  it("carries the parent and start-only attributes forward to the end side", async () => {
    const { correlator } = harness();

    await correlator.recordStart(
      toolStart({
        parent: { family: "generation", scopeKey: "gen_1" },
        attributes: { "otelhook.tool.kind": "read", "gen_ai.tool.name": "read_file" },
      }),
    );
    const end = await correlator.recordEnd(toolEnd());

    expect(end.status).toBe("matched");
    expect(end.facts.parent).toEqual({ family: "generation", scopeKey: "gen_1" });
    expect(end.facts.attributes).toEqual({
      "otelhook.tool.kind": "read",
      "gen_ai.tool.name": "read_file",
    });
  });

  it("recognizes a redelivered start as a duplicate and replays its recorded start time", async () => {
    const { correlator } = harness();
    const input = toolStart({ scope: "generation" as const, scopeKey: "gen_1" });

    expect((await correlator.recordStart(input)).status).toBe("recorded");
    const again = await correlator.recordStart(input);
    expect(again.status).toBe("duplicate");
    expect(again.status === "duplicate" && again.facts.startedAt).toBe(1_000);
  });

  it("recognizes a redelivered end as a duplicate rather than re-matching", async () => {
    const { correlator } = harness();

    await correlator.recordStart(toolStart({ scope: "subagent" as const, scopeKey: "sub_1", occurredAt: 0 }));
    const endInput = toolEnd({ scope: "subagent" as const, scopeKey: "sub_1", occurredAt: 10 });

    const first = await correlator.recordEnd(endInput);
    expect(first.status).toBe("matched");
    const second = await correlator.recordEnd(endInput);
    expect(second).toEqual({ status: "duplicate", facts: { startedAt: 0, endedAt: 10 } });
  });

  it("refuses a second, distinct end for a scope that is already closed", async () => {
    const { correlator } = harness();

    await correlator.recordStart(toolStart());
    expect((await correlator.recordEnd(toolEnd())).status).toBe("matched");

    const late = await correlator.recordEnd(toolEnd({ eventId: "evt_end_2", occurredAt: 9_000 }));
    expect(late).toMatchObject({ status: "orphaned", reason: "already-closed" });
  });

  it("reports an orphaned end when no start was ever recorded", async () => {
    const { correlator } = harness();

    const end = await correlator.recordEnd(toolEnd({ scopeKey: "call_missing", occurredAt: 10 }));
    expect(end).toMatchObject({ status: "orphaned", reason: "no-start-recorded" });
  });

  it("pairs a start that races in behind its own end", async () => {
    const { correlator } = harness();

    // Two hook processes, no ordering guarantee: the end lands first.
    const end = await correlator.recordEnd(toolEnd({ occurredAt: 1_500 }));
    expect(end).toMatchObject({ status: "orphaned", reason: "no-start-recorded" });

    // The record is completed, so a redelivered end replays identical facts — but
    // the status is `published`, not `recorded`: the end already exported this
    // scope's span under its derived id, and OTLP cannot revise a span, so this
    // late start must not export a second record claiming that same id.
    const start = await correlator.recordStart(toolStart({ occurredAt: 1_000 }));
    expect(start.status).toBe("published");
    expect(start.status === "published" && start.facts).toMatchObject({
      startedAt: 1_000,
      endedAt: 1_500,
    });
  });

  it("refuses to pair a start and end recorded by different providers", async () => {
    const { correlator } = harness();

    await correlator.recordStart(toolStart());
    const foreign = await correlator.recordEnd(toolEnd({ providerId: "other-cli" }));
    // Different providers are also key-isolated, so the foreign end sees no
    // record at all rather than the first provider's open span — either way it
    // never inherits a duration that was not its own.
    expect(foreign.status).toBe("orphaned");
    expect(foreign.status === "orphaned" && foreign.facts.startedAt).toBeUndefined();

    // The original provider's span is untouched by the foreign edge.
    const own = await correlator.recordEnd(toolEnd());
    expect(own).toMatchObject({ status: "matched", startedAt: 1_000 });
  });

  it("reports provider-mismatch when a record names a different provider than its key", async () => {
    const { clock, stateStore, correlator } = harness();

    // Defense in depth: a hand-edited or misplaced record whose stored provider
    // disagrees with the caller must not be paired against.
    const [key] = [...(await stateStore.keys("lifecycle:span:"))];
    expect(key).toBeUndefined();
    await correlator.recordStart(toolStart());
    const [recordKey] = await stateStore.keys("lifecycle:span:");
    if (recordKey === undefined) {
      throw new Error("expected the correlator to have written a span record");
    }
    await stateStore.write(recordKey, {
      kind: "attributes",
      attributes: {
        v: SPAN_RECORD_VERSION,
        providerId: "someone-else",
        startEventId: "evt_start",
        startedAt: clock.now(),
      },
    });

    const end = await correlator.recordEnd(toolEnd());
    expect(end).toMatchObject({ status: "orphaned", reason: "provider-mismatch" });
  });

  it("discards a record written by an incompatible version instead of interpreting it", async () => {
    const { stateStore, correlator } = harness();

    await correlator.recordStart(toolStart());
    const [recordKey] = await stateStore.keys("lifecycle:span:");
    if (recordKey === undefined) {
      throw new Error("expected the correlator to have written a span record");
    }
    // The v1 shape this library shipped before cross-process correlation.
    await stateStore.write(recordKey, {
      kind: "attributes",
      attributes: { startEventId: "evt_start", startedAt: 1_000 },
    });

    const end = await correlator.recordEnd(toolEnd());
    expect(end).toMatchObject({ status: "orphaned", reason: "state-incompatible" });
    // Self-healing: the unreadable record is gone rather than poisoning the key.
    expect(await stateStore.read(recordKey)).toBeUndefined();
  });

  it("discards a corrupt record rather than inventing the missing half of an edge", async () => {
    const { stateStore, correlator } = harness();

    await correlator.recordStart(toolStart());
    const [recordKey] = await stateStore.keys("lifecycle:span:");
    if (recordKey === undefined) {
      throw new Error("expected the correlator to have written a span record");
    }
    await stateStore.write(recordKey, {
      kind: "attributes",
      // A start timestamp with no event id: half a record, and not one we guess at.
      attributes: { v: SPAN_RECORD_VERSION, providerId: PROVIDER, startedAt: 1_000 },
    });

    const end = await correlator.recordEnd(toolEnd());
    expect(end).toMatchObject({ status: "orphaned", reason: "state-corrupt" });
    expect(await stateStore.read(recordKey)).toBeUndefined();
  });

  it("refuses a start that aged past the retention window before its end arrived", async () => {
    const { stateStore, correlator } = harness({ maxStartAgeMillis: 60_000 });

    await correlator.recordStart(toolStart({ occurredAt: 0 }));
    const end = await correlator.recordEnd(toolEnd({ occurredAt: 60_001 }));
    expect(end).toMatchObject({ status: "orphaned", reason: "start-expired" });
    expect(end.facts.startedAt).toBeUndefined();
    // The untrustworthy start is dropped, not left to mislead a later end.
    expect(await stateStore.keys("lifecycle:span:")).toEqual([]);
  });

  it("clears a decreasing duration to zero rather than reporting negative", async () => {
    const { correlator } = harness();

    await correlator.recordStart(toolStart({ occurredAt: 1_000 }));
    const end = await correlator.recordEnd(toolEnd({ occurredAt: 500 }));
    expect(end.status).toBe("matched");
    expect(end.status === "matched" && end.durationMillis).toBe(0);
  });

  it("supersedes an open span when a different start claims the same scope key", async () => {
    const { correlator } = harness();

    await correlator.recordStart(toolStart({ eventId: "evt_start_1", occurredAt: 1_000 }));
    const second = await correlator.recordStart(toolStart({ eventId: "evt_start_2", occurredAt: 2_000 }));
    expect(second.status).toBe("recorded");

    const end = await correlator.recordEnd(toolEnd({ occurredAt: 2_400 }));
    expect(end).toMatchObject({ status: "matched", startedAt: 2_000, durationMillis: 400 });
  });

  it("bounded cleanup removes spans untouched past the max age and leaves fresh ones", async () => {
    const { clock, correlator } = harness();

    await correlator.recordStart(toolStart({ scopeKey: "stale", eventId: "evt_1", occurredAt: 0 }));
    clock.advance(10_000);
    await correlator.recordStart(toolStart({ scopeKey: "fresh", eventId: "evt_2", occurredAt: 10_000 }));

    const result = await correlator.cleanup(5_000);
    expect(result.removed).toBe(1);
    expect(result.scanned).toBe(2);

    const staleEnd = await correlator.recordEnd(
      toolEnd({ scopeKey: "stale", eventId: "evt_end", occurredAt: 10_100 }),
    );
    expect(staleEnd.status).toBe("orphaned");

    const freshEnd = await correlator.recordEnd(
      toolEnd({ scopeKey: "fresh", eventId: "evt_end2", occurredAt: 10_100 }),
    );
    expect(freshEnd.status).toBe("matched");
  });

  it("bounds a cleanup sweep by maxEntries", async () => {
    const { clock, correlator } = harness();

    for (let index = 0; index < 10; index += 1) {
      await correlator.recordStart(
        toolStart({ scopeKey: `call_${index}`, eventId: `evt_${index}`, occurredAt: 0 }),
      );
    }
    clock.advance(10_000);

    const result = await correlator.cleanup(1_000, { maxEntries: 3 });
    expect(result.scanned).toBe(3);
    expect(result.removed).toBe(3);
  });

  it("sweeps only the named session", async () => {
    const { clock, correlator } = harness();

    await correlator.recordStart(toolStart({ sessionId: "ses_1", occurredAt: 0 }));
    await correlator.recordStart(toolStart({ sessionId: "ses_2", occurredAt: 0 }));
    clock.advance(10_000);

    const result = await correlator.cleanup(1_000, { sessionId: "ses_1" });
    // The swept record held a start and no end, so it names a span that will never
    // be exported at all.
    expect(result).toEqual({ removed: 1, scanned: 1, expiredOpen: 1 });

    // The untouched session's open span is still pairable.
    const survivor = await correlator.recordEnd(toolEnd({ sessionId: "ses_2", occurredAt: 10_100 }));
    expect(survivor.status).toBe("matched");
  });
});
