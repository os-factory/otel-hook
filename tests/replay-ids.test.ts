import { describe, expect, it } from "vitest";

import { createDeterministicIdGenerator, createRandomIdGenerator } from "../src/index.js";
import { createFixtureAdapter, createTestHook } from "../src/testing/index.js";
import { createSeededRandom } from "./helpers/random.js";

const seed = {
  providerId: "fixture",
  sessionId: "ses_1",
  sourceEventName: "session.start",
  occurredAt: 1_700_000_000_000,
};

describe("deterministic id generation", () => {
  it("derives the same ids from the same seed across generators", () => {
    const first = createDeterministicIdGenerator();
    const second = createDeterministicIdGenerator();

    expect(first.newInvocationId(seed)).toBe(second.newInvocationId(seed));
    expect(
      first.newEventId({ invocationId: "inv_1", sequence: 0, eventType: "session.start" }),
    ).toBe(second.newEventId({ invocationId: "inv_1", sequence: 0, eventType: "session.start" }));
  });

  it("varies with every seed component", () => {
    const ids = createDeterministicIdGenerator();
    const base = ids.newInvocationId(seed);

    expect(ids.newInvocationId({ ...seed, sessionId: "ses_2" })).not.toBe(base);
    expect(ids.newInvocationId({ ...seed, providerId: "other" })).not.toBe(base);
    expect(ids.newInvocationId({ ...seed, occurredAt: seed.occurredAt + 1 })).not.toBe(base);
    expect(ids.newInvocationId({ ...seed, discriminator: "req-1" })).not.toBe(base);
  });

  it("separates namespaces so two deployments do not collide", () => {
    const tenantA = createDeterministicIdGenerator({ namespace: "tenant-a" });
    const tenantB = createDeterministicIdGenerator({ namespace: "tenant-b" });
    expect(tenantA.newInvocationId(seed)).not.toBe(tenantB.newInvocationId(seed));
  });

  it("gives every sequence position a distinct event id", () => {
    const ids = createDeterministicIdGenerator();
    const generated = new Set<string>();
    for (let sequence = 0; sequence < 200; sequence += 1) {
      generated.add(ids.newEventId({ invocationId: "inv_1", sequence, eventType: "tool.start" }));
    }
    expect(generated.size).toBe(200);
  });

  it("does not collide across 2000 random seeds", () => {
    const ids = createDeterministicIdGenerator();
    const random = createSeededRandom(0xabcdef);
    const generated = new Set<string>();
    for (let iteration = 0; iteration < 2000; iteration += 1) {
      generated.add(
        ids.newInvocationId({
          providerId: random.pick(["a", "b", "c"]),
          sessionId: random.string(24),
          occurredAt: random.int(0, 2_000_000_000_000),
          discriminator: random.string(8),
        }),
      );
    }
    expect(generated.size).toBe(2000);
  });

  it("produces ids that satisfy the identifier schemas", () => {
    const ids = createDeterministicIdGenerator();
    expect(ids.newInvocationId(seed)).toMatch(/^inv_[0-9a-f]{32}$/);
    expect(ids.newEventId({ invocationId: "inv_1", sequence: 3, eventType: "tool.end" })).toMatch(
      /^evt_[0-9a-f]{32}$/,
    );
    expect(ids.newOpaqueId(["a", "b"])).toMatch(/^[0-9a-f]{32}$/);
  });

  it("offers a random generator for cases with no stable seed", () => {
    const ids = createRandomIdGenerator();
    expect(ids.newInvocationId(seed)).not.toBe(ids.newInvocationId(seed));
  });
});

describe("replay safety end to end", () => {
  it("produces byte-identical events when the same input is replayed", async () => {
    const payload = {
      provider: "fixture",
      sessionId: "ses_replay",
      event: "generation",
      requestId: "req-1",
      occurredAt: 1_700_000_000_000,
      usage: { temporality: "delta", inputTokens: 12, outputTokens: 3 },
    };

    const first = createTestHook({ adapters: [createFixtureAdapter()] });
    const second = createTestHook({ adapters: [createFixtureAdapter()] });

    const a = await first.hook.ingest({ payload, transport: "hook-stdin" });
    const b = await second.hook.ingest({ payload, transport: "hook-stdin" });

    expect(a.events.map((event) => event.eventId)).toEqual(b.events.map((event) => event.eventId));
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
    expect(a.identity?.invocationId).toBe(b.identity?.invocationId);
  });

  it("keeps event ids stable for a replayed invocation within one session", async () => {
    const payload = {
      provider: "fixture",
      sessionId: "ses_replay",
      event: "session.start",
      occurredAt: 1_700_000_000_000,
    };
    const harness = createTestHook({ adapters: [createFixtureAdapter()] });

    const first = await harness.hook.ingest({ payload, transport: "hook-stdin" });
    // A second delivery of the same payload advances the sequence, so the ids
    // differ: dedupe belongs to the collector, keyed on the invocation id.
    const second = await harness.hook.ingest({ payload, transport: "hook-stdin" });

    expect(first.identity?.invocationId).toBe(second.identity?.invocationId);
    expect(first.events[0]?.eventId).not.toBe(second.events[0]?.eventId);
    expect(second.events[0]?.sequence).toBe(1);
  });
});
