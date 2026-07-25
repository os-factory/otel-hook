import { describe, expect, it } from "vitest";

import { createFixedClock } from "../../src/runtime/clock.js";
import { createInMemoryStateStore } from "../../src/runtime/memory.js";
import { createSpanCorrelator } from "../../src/lifecycle/span-correlator.js";

describe("createSpanCorrelator", () => {
  it("computes a duration when the end arrives in a later invocation", async () => {
    const clock = createFixedClock();
    const stateStore = createInMemoryStateStore({ clock });
    const correlator = createSpanCorrelator({ stateStore, clock });

    const start = await correlator.recordStart({
      sessionId: "ses_1",
      scope: "tool",
      scopeKey: "call_1",
      eventId: "evt_start",
      occurredAt: 1_000,
    });
    expect(start.status).toBe("recorded");

    const end = await correlator.recordEnd({
      sessionId: "ses_1",
      scope: "tool",
      scopeKey: "call_1",
      eventId: "evt_end",
      occurredAt: 1_500,
    });
    expect(end).toEqual({ status: "matched", startedAt: 1_000, durationMillis: 500 });
  });

  it("recognizes a redelivered start as a duplicate", async () => {
    const clock = createFixedClock();
    const stateStore = createInMemoryStateStore({ clock });
    const correlator = createSpanCorrelator({ stateStore, clock });

    const input = {
      sessionId: "ses_1",
      scope: "generation" as const,
      scopeKey: "gen_1",
      eventId: "evt_start",
      occurredAt: 1_000,
    };
    expect((await correlator.recordStart(input)).status).toBe("recorded");
    expect((await correlator.recordStart(input)).status).toBe("duplicate");
  });

  it("recognizes a redelivered end as a duplicate rather than re-matching", async () => {
    const clock = createFixedClock();
    const stateStore = createInMemoryStateStore({ clock });
    const correlator = createSpanCorrelator({ stateStore, clock });

    await correlator.recordStart({
      sessionId: "ses_1",
      scope: "subagent",
      scopeKey: "sub_1",
      eventId: "evt_start",
      occurredAt: 0,
    });
    const endInput = {
      sessionId: "ses_1",
      scope: "subagent" as const,
      scopeKey: "sub_1",
      eventId: "evt_end",
      occurredAt: 10,
    };
    const first = await correlator.recordEnd(endInput);
    expect(first.status).toBe("matched");
    const second = await correlator.recordEnd(endInput);
    expect(second).toEqual({ status: "duplicate" });
  });

  it("reports an orphaned end when no start was ever recorded", async () => {
    const clock = createFixedClock();
    const stateStore = createInMemoryStateStore({ clock });
    const correlator = createSpanCorrelator({ stateStore, clock });

    const end = await correlator.recordEnd({
      sessionId: "ses_1",
      scope: "tool",
      scopeKey: "call_missing",
      eventId: "evt_end",
      occurredAt: 10,
    });
    expect(end).toEqual({ status: "orphaned", reason: "no-start-recorded" });
  });

  it("clears a decreasing duration to zero rather than reporting negative", async () => {
    const clock = createFixedClock();
    const stateStore = createInMemoryStateStore({ clock });
    const correlator = createSpanCorrelator({ stateStore, clock });

    await correlator.recordStart({
      sessionId: "ses_1",
      scope: "tool",
      scopeKey: "call_1",
      eventId: "evt_start",
      occurredAt: 1_000,
    });
    const end = await correlator.recordEnd({
      sessionId: "ses_1",
      scope: "tool",
      scopeKey: "call_1",
      eventId: "evt_end",
      occurredAt: 500,
    });
    expect(end.status).toBe("matched");
    expect(end.status === "matched" && end.durationMillis).toBe(0);
  });

  it("bounded cleanup removes spans untouched past the max age and leaves fresh ones", async () => {
    const clock = createFixedClock();
    const stateStore = createInMemoryStateStore({ clock });
    const correlator = createSpanCorrelator({ stateStore, clock });

    await correlator.recordStart({
      sessionId: "ses_1",
      scope: "tool",
      scopeKey: "stale",
      eventId: "evt_1",
      occurredAt: 0,
    });
    clock.advance(10_000);
    await correlator.recordStart({
      sessionId: "ses_1",
      scope: "tool",
      scopeKey: "fresh",
      eventId: "evt_2",
      occurredAt: 10_000,
    });

    const result = await correlator.cleanup(5_000);
    expect(result.removed).toBe(1);
    expect(result.scanned).toBe(2);

    const staleEnd = await correlator.recordEnd({
      sessionId: "ses_1",
      scope: "tool",
      scopeKey: "stale",
      eventId: "evt_end",
      occurredAt: 10_100,
    });
    expect(staleEnd.status).toBe("orphaned");

    const freshEnd = await correlator.recordEnd({
      sessionId: "ses_1",
      scope: "tool",
      scopeKey: "fresh",
      eventId: "evt_end2",
      occurredAt: 10_100,
    });
    expect(freshEnd.status).toBe("matched");
  });

  it("bounds a cleanup sweep by maxEntries", async () => {
    const clock = createFixedClock();
    const stateStore = createInMemoryStateStore({ clock });
    const correlator = createSpanCorrelator({ stateStore, clock });

    for (let index = 0; index < 10; index += 1) {
      await correlator.recordStart({
        sessionId: "ses_1",
        scope: "tool",
        scopeKey: `call_${index}`,
        eventId: `evt_${index}`,
        occurredAt: 0,
      });
    }
    clock.advance(10_000);

    const result = await correlator.cleanup(1_000, { maxEntries: 3 });
    expect(result.scanned).toBe(3);
    expect(result.removed).toBe(3);
  });
});
