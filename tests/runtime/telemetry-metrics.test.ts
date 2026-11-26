/**
 * Hook-derived metrics (issue #69): derivation, cumulative series state, and
 * spool validation. Every event here is synthetic.
 */
import { resourceFromAttributes } from "@opentelemetry/resources";
import { describe, expect, it } from "vitest";

import { createMetricSeriesStore } from "../../src/lifecycle/metric-series.js";
import { parseCanonicalEvent, type CanonicalEvent } from "../../src/model/events.js";
import { normalizeUsageOrThrow } from "../../src/model/usage.js";
import { CANONICAL_SCHEMA_VERSION } from "../../src/model/version.js";
import { createFixedClock } from "../../src/runtime/clock.js";
import { createInMemoryStateStore } from "../../src/runtime/memory.js";
import { createTestIdentity } from "../../src/testing/index.js";
import { validateMetricSpoolBatch } from "../../src/telemetry/durable-metric-spool.js";
import {
  aggregateDeltaPoints,
  bucketIndex,
  deriveMetricObservations,
  withoutAccountIdentity,
  type MetricObservation,
} from "../../src/telemetry/metric-model.js";

const identity = createTestIdentity();
const resource = resourceFromAttributes({ "service.name": "test" });

let sequence = 0;
const build = (fields: Record<string, unknown>): CanonicalEvent =>
  parseCanonicalEvent({
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    invocationId: identity.invocationId,
    sessionId: identity.sessionId,
    provenance: identity.provenance,
    workspace: identity.workspace,
    extensions: {},
    eventId: `e${String((sequence += 1))}`,
    sequence,
    occurredAt: 1_700_000_010_000,
    ...fields,
  });

const usage = (input: number, output: number, cached = 0) =>
  normalizeUsageOrThrow({ temporality: "delta", inputTokens: input, outputTokens: output, cachedInputTokens: cached });

const model = { modelId: "synthetic-model", vendor: "anthropic" };

describe("deriveMetricObservations", () => {
  it("records sessions, tool calls, durations and per-type tokens, and nothing account-shaped", () => {
    const end = build({
      type: "generation.end",
      generationId: "g1",
      model,
      outcome: "ok",
      durationMillis: 2_500,
      usage: usage(100, 20, 60),
    });
    const events = [
      build({ type: "session.start", sessionKind: "interactive" }),
      build({ type: "tool.end", toolCallId: "t1", toolName: "Read", outcome: "ok" }),
      end,
    ];
    const observations = deriveMetricObservations({
      events,
      usage: [{ eventId: end.eventId, scope: "generation", delta: usage(100, 20, 60) }],
      resource: resourceFromAttributes({ "service.name": "test", "session.id": "launcher-key" }),
    });
    const summary = observations.map((observation) => [
      observation.instrument,
      observation.attributes["gen_ai.token.type"] ?? observation.attributes["gen_ai.tool.name"] ?? "",
      observation.value,
    ]);
    expect(summary).toEqual([
      ["otelhook.sessions", "", 1],
      ["otelhook.tool.calls", "Read", 1],
      ["gen_ai.client.operation.duration", "", 2.5],
      ["gen_ai.client.token.usage", "input", 100],
      ["gen_ai.client.token.usage", "output", 20],
      ["gen_ai.client.token.usage", "cache_read", 60],
    ]);
    for (const observation of observations) {
      expect(observation.attributes["session.id"]).toBe("launcher-key");
      expect(Object.keys(observation.attributes).some((key) => key.startsWith("user."))).toBe(false);
    }
    const token = observations.find((observation) => observation.instrument === "gen_ai.client.token.usage");
    expect(token?.attributes).toMatchObject({
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "anthropic",
      "gen_ai.request.model": "synthetic-model",
      "gen_ai.response.model": "synthetic-model",
    });
  });

  it("measures a duration from a start recovered from an earlier process, and never invents one", () => {
    const end = build({ type: "generation.end", generationId: "g2", model, outcome: "error" });
    const without = deriveMetricObservations({ events: [end], usage: [], resource });
    expect(without).toEqual([]);

    const recovered = deriveMetricObservations({
      events: [end],
      usage: [],
      resource,
      generationStarts: (id) => (id === "g2" ? { startMillis: end.occurredAt - 1_500, requestModel: "asked-for" } : undefined),
    });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.value).toBe(1.5);
    expect(recovered[0]?.attributes["error.type"]).toBe("error");
    expect(recovered[0]?.attributes["gen_ai.request.model"]).toBe("asked-for");
  });

  it("never measures from a start synthesized in the same callback, and falls back to the turn's prompt", () => {
    const start = build({ type: "generation.start", generationId: "g5", model: { modelId: "asked" } });
    const end = build({ type: "generation.end", generationId: "g5", model, outcome: "ok" });
    expect(deriveMetricObservations({ events: [start, end], usage: [], resource })).toEqual([]);

    const fromTurn = deriveMetricObservations({
      events: [start, end],
      usage: [],
      resource,
      turnStart: () => end.occurredAt - 7_000,
    });
    expect(fromTurn.map((observation) => [observation.value, observation.attributes["gen_ai.request.model"]])).toEqual([
      [7, "asked"],
    ]);

    // A prompt recorded after the end belongs to the next turn.
    expect(
      deriveMetricObservations({ events: [end], usage: [], resource, turnStart: () => end.occurredAt + 1 }),
    ).toEqual([]);
  });

  it("counts a subagent's generation tokens, but never times it from the parent's prompt (issue #68)", () => {
    const end = build({
      type: "generation.end",
      generationId: "g-sub",
      subagentId: "agent-1",
      model: { modelId: "subagent-model" },
      outcome: "ok",
      usage: usage(40, 8),
    });
    const observations = deriveMetricObservations({
      events: [end],
      usage: [{ eventId: end.eventId, scope: "generation", delta: usage(40, 8) }],
      resource,
      turnStart: () => end.occurredAt - 7_000,
    });
    expect(
      observations.map((observation) => [
        observation.instrument,
        observation.attributes["gen_ai.token.type"] ?? "",
        observation.value,
        observation.attributes["gen_ai.response.model"],
      ]),
    ).toEqual([
      ["gen_ai.client.token.usage", "input", 40, "subagent-model"],
      ["gen_ai.client.token.usage", "output", 8, "subagent-model"],
    ]);
  });

  it("ignores session and subagent usage scopes, which restate generation spend", () => {
    const end = build({ type: "session.end", reason: "completed", usage: normalizeUsageOrThrow({ temporality: "cumulative", inputTokens: 5 }) });
    const observations = deriveMetricObservations({
      events: [end],
      usage: [{ eventId: end.eventId, scope: "session", delta: usage(5, 0) }],
      resource,
    });
    expect(observations).toEqual([]);
  });

  it("counts provider-reported USD cost only, and drops session.id when asked", () => {
    const reported = build({
      type: "generation.end",
      generationId: "g3",
      model,
      outcome: "ok",
      cost: { currency: "USD", amount: 0.25, source: "provider-reported" },
    });
    const computed = build({
      type: "generation.end",
      generationId: "g4",
      model,
      outcome: "ok",
      cost: { currency: "USD", amount: 9, source: "computed" },
    });
    const observations = deriveMetricObservations({
      events: [reported, computed],
      usage: [],
      resource,
      includeSessionId: false,
    });
    expect(observations.map((observation) => [observation.instrument, observation.value])).toEqual([
      ["otelhook.cost.usage", 0.25],
    ]);
    expect(observations[0]?.attributes["session.id"]).toBeUndefined();
  });
});

describe("metric aggregation", () => {
  const observation = (value: number, sessionId = "s1", tool = "Read"): MetricObservation => ({
    instrument: "otelhook.tool.calls",
    value,
    attributes: { "otelhook.provider.id": "codex", "gen_ai.tool.name": tool },
    timeMillis: 1_700_000_000_000,
    sessionId,
  });

  it("places histogram values in OTLP explicit buckets (upper bound inclusive)", () => {
    expect(bucketIndex([1, 4, 16], 0)).toBe(0);
    expect(bucketIndex([1, 4, 16], 1)).toBe(0);
    expect(bucketIndex([1, 4, 16], 2)).toBe(1);
    expect(bucketIndex([1, 4, 16], 17)).toBe(3);
  });

  it("folds one batch's observations into delta points per series", () => {
    const points = aggregateDeltaPoints([observation(1), observation(1), observation(1, "s1", "Bash")], 1_700_000_005_000);
    expect(points.map((point) => [point.attributes["gen_ai.tool.name"], point.value, point.temporality])).toEqual([
      ["Read", 2, "delta"],
      ["Bash", 1, "delta"],
    ]);
  });

  it("continues a cumulative series across processes, and restates it on a replayed delivery", async () => {
    const clock = createFixedClock({ startMillis: 1_700_000_001_000, tickMillis: 10 });
    const stateStore = createInMemoryStateStore({ clock });
    // Two stores over one state: two hook processes.
    const first = createMetricSeriesStore({ stateStore, clock });
    const second = createMetricSeriesStore({ stateStore, clock });

    const a = await first.recordCumulative([observation(1)], { deliveryToken: "d1" });
    const b = await second.recordCumulative([observation(1), observation(1)], { deliveryToken: "d2" });
    const replay = await second.recordCumulative([observation(1), observation(1)], { deliveryToken: "d2" });

    expect(a.map((point) => point.value)).toEqual([1]);
    expect(b.map((point) => point.value)).toEqual([3]);
    expect(replay.map((point) => point.value)).toEqual([3]);
    expect(new Set([...a, ...b, ...replay].map((point) => point.startTimeMillis)).size).toBe(1);
    expect(b[0]?.temporality).toBe("cumulative");
  });

  it("keeps per-session series apart, and shares one series when session.id is off", async () => {
    const clock = createFixedClock();
    const store = createMetricSeriesStore({ stateStore: createInMemoryStateStore({ clock }), clock });
    await store.recordCumulative([observation(1, "s1")]);
    const other = await store.recordCumulative([observation(1, "s2")]);
    expect(other.map((point) => point.value)).toEqual([1]);

    await store.recordCumulative([observation(1, "s1")], { perSession: false });
    const shared = await store.recordCumulative([observation(1, "s2")], { perSession: false });
    expect(shared.map((point) => point.value)).toEqual([2]);
  });

  it("keeps the latest turn start and never moves it backwards", async () => {
    const clock = createFixedClock();
    const store = createMetricSeriesStore({ stateStore: createInMemoryStateStore({ clock }), clock });
    expect(await store.readTurnStart("s1")).toBeUndefined();
    await store.recordTurnStart("s1", 2_000);
    await store.recordTurnStart("s1", 1_000);
    expect(await store.readTurnStart("s1")).toBe(2_000);
    expect(await store.readTurnStart("s2")).toBeUndefined();
  });

  it("accumulates histograms and sweeps aged-out series", async () => {
    const clock = createFixedClock({ startMillis: 1_700_000_000_000, tickMillis: 1_000 });
    const stateStore = createInMemoryStateStore({ clock });
    const store = createMetricSeriesStore({ stateStore, clock });
    const token = (value: number): MetricObservation => ({
      instrument: "gen_ai.client.token.usage",
      value,
      attributes: { "gen_ai.token.type": "input" },
      timeMillis: 1_700_000_000_000,
      sessionId: "s1",
    });
    await store.recordCumulative([token(10)]);
    const [point] = await store.recordCumulative([token(3_000)]);
    expect(point?.histogram).toMatchObject({ count: 2, sum: 3_010, min: 10, max: 3_000 });
    expect(point?.histogram?.bucketCounts.reduce((sum, count) => sum + count, 0)).toBe(2);

    const swept = await store.cleanup(1, { sessionId: "s1" });
    expect(swept.removed).toBe(1);
  });
});

describe("metric spool validation", () => {
  const namespace = { providerId: "codex", installationId: "default" };
  const batch = (points: unknown) => ({
    ...namespace,
    resourceAttributes: { "service.name": "test" },
    instrumentationScope: { name: "@osfactory/otel-hook" },
    points,
    enqueuedAt: 1,
  });
  const counter = {
    instrument: "otelhook.sessions",
    temporality: "cumulative",
    attributes: { "otelhook.provider.id": "codex" },
    startTimeMillis: 1,
    timeMillis: 2,
    value: 1,
  };

  it("accepts a well-formed batch and refuses a poisoned one", () => {
    expect("batch" in validateMetricSpoolBatch(batch([counter]), namespace)).toBe(true);
    expect(validateMetricSpoolBatch(batch([{ ...counter, instrument: "made.up" }]), namespace)).toEqual({
      rejection: "point-field-invalid",
    });
    expect(validateMetricSpoolBatch(batch([{ ...counter, value: -1 }]), namespace)).toEqual({
      rejection: "point-field-invalid",
    });
    expect(validateMetricSpoolBatch(batch([{ ...counter, attributes: { nested: { a: 1 } } }]), namespace)).toEqual({
      rejection: "point-field-invalid",
    });
    expect(validateMetricSpoolBatch(batch([counter]), { ...namespace, providerId: "other" })).toEqual({
      rejection: "identity-mismatch",
    });
  });

  it("strips account identity from metric attributes", () => {
    expect(
      withoutAccountIdentity({ "user.email": "x", "organization.id": "y", "enduser.id": "z", "service.name": "s" }),
    ).toEqual({ "service.name": "s" });
  });
});
