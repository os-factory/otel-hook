import { SpanStatusCode } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { describe, expect, it } from "vitest";

import { createTestIdentity } from "../../src/testing/index.js";
import { canonicalEventsToReadableSpans } from "../../src/telemetry/semconv.js";
import { normalizeUsageOrThrow } from "../../src/model/usage.js";
import { parseCanonicalEvent, type CanonicalEvent } from "../../src/model/events.js";
import { CANONICAL_SCHEMA_VERSION } from "../../src/model/version.js";

const resource = resourceFromAttributes({ "service.name": "test" });
const identity = createTestIdentity();

const buildEvent = (overrides: Record<string, unknown>): CanonicalEvent =>
  parseCanonicalEvent({
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    invocationId: identity.invocationId,
    sessionId: identity.sessionId,
    provenance: identity.provenance,
    workspace: identity.workspace,
    extensions: {},
    ...overrides,
  });

describe("canonicalEventsToReadableSpans", () => {
  it("merges a start/end pair present in the same batch into one span with a real duration", () => {
    const events = [
      buildEvent({
        type: "tool.start",
        eventId: "e1",
        sequence: 0,
        occurredAt: 1_000,
        toolCallId: "call_1",
        toolName: "read_file",
        toolKind: "read",
      }),
      buildEvent({
        type: "tool.end",
        eventId: "e2",
        sequence: 1,
        occurredAt: 1_200,
        toolCallId: "call_1",
        toolName: "read_file",
        outcome: "ok",
      }),
    ];

    const spans = canonicalEventsToReadableSpans(events, { resource });
    expect(spans).toHaveLength(1);
    const span = spans[0];
    expect(span?.name).toBe("tool read_file");
    expect(span?.attributes["otelhook.span.paired"]).toBe(true);
    expect(span?.attributes["gen_ai.tool.call.id"]).toBe("call_1");
    const durationMillis = (span?.duration[0] ?? 0) * 1000 + (span?.duration[1] ?? 0) / 1e6;
    expect(durationMillis).toBeCloseTo(200, 5);
    expect(span?.status.code).toBe(SpanStatusCode.UNSET);
  });

  it("exports nothing for a lone start, because the end edge exports the whole span", () => {
    const events = [
      buildEvent({
        type: "generation.start",
        eventId: "e1",
        sequence: 0,
        occurredAt: 1_000,
        generationId: "gen_1",
        model: { modelId: "test-model" },
      }),
    ];

    // A lifecycle span id is derived from (provider, session, family, scopeKey),
    // so a start-edge record and the later end-edge record would carry the same
    // trace and span id — and OTLP cannot revise a span, so a collector would see
    // a duplicate rather than an update. The start is durable in the correlator's
    // state instead, and the end edge emits one complete span.
    expect(canonicalEventsToReadableSpans(events, { resource })).toHaveLength(0);
  });

  it("never emits two records with one span id across a start batch and an end batch", () => {
    const start = buildEvent({
      type: "tool.start",
      eventId: "e1",
      sequence: 0,
      occurredAt: 1_000,
      toolCallId: "call_1",
      toolName: "read_file",
      toolKind: "read",
    });
    const end = buildEvent({
      type: "tool.end",
      eventId: "e2",
      sequence: 1,
      occurredAt: 1_400,
      toolCallId: "call_1",
      toolName: "read_file",
      outcome: "ok",
    });

    // Two separate hook processes, each mapping its own batch. The second is told
    // (as the correlator would) that the start is on record.
    const first = canonicalEventsToReadableSpans([start], { resource });
    const second = canonicalEventsToReadableSpans([end], {
      resource,
      correlations: [
        {
          providerId: identity.provenance.providerId,
          sessionId: identity.sessionId,
          ref: { family: "tool", scopeKey: "call_1" },
          pairing: "cross-process",
          orphan: "none",
          disposition: "emit",
          startMillis: 1_000,
          endMillis: 1_400,
        },
      ],
    });

    const ids = [...first, ...second].map((span) => span.spanContext().spanId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(1);
    // The single record is the complete one, with the real duration.
    const durationMillis = (second[0]?.duration[0] ?? 0) * 1000 + (second[0]?.duration[1] ?? 0) / 1e6;
    expect(durationMillis).toBeCloseTo(400, 5);
    expect(second[0]?.attributes["otelhook.span.paired"]).toBe(true);
  });

  it("gives a second, distinct end its own span id instead of reusing a closed one", () => {
    const end = buildEvent({
      type: "tool.end",
      eventId: "e9",
      sequence: 4,
      occurredAt: 2_000,
      toolCallId: "call_1",
      toolName: "read_file",
      outcome: "ok",
    });
    const base = {
      providerId: identity.provenance.providerId,
      sessionId: identity.sessionId,
      ref: { family: "tool", scopeKey: "call_1" } as const,
    };

    const closed = canonicalEventsToReadableSpans([end], {
      resource,
      correlations: [{ ...base, pairing: "cross-process", orphan: "none", disposition: "emit" }],
    });
    const alreadyClosed = canonicalEventsToReadableSpans([end], {
      resource,
      correlations: [
        {
          ...base,
          pairing: "unpaired",
          orphan: "already-closed",
          disposition: "emit",
          spanIdDiscriminator: "e9",
        },
      ],
    });

    expect(closed[0]?.spanContext().spanId).not.toBe(alreadyClosed[0]?.spanContext().spanId);
    expect(alreadyClosed[0]?.attributes["otelhook.span.orphan"]).toBe("already-closed");
  });

  it("maps error.raised to an ERROR status span", () => {
    const events = [
      buildEvent({
        type: "error.raised",
        eventId: "e1",
        sequence: 0,
        occurredAt: 1_000,
        errorCode: "telemetry-export-failure",
        severity: "warning",
        phase: "export",
        retryable: true,
      }),
    ];

    const spans = canonicalEventsToReadableSpans(events, { resource });
    expect(spans[0]?.status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[0]?.attributes["error.type"]).toBe("telemetry-export-failure");
  });

  it("carries usage counters onto the merged generation span", () => {
    const usage = normalizeUsageOrThrow({
      temporality: "delta",
      inputTokens: 12,
      outputTokens: 4,
      cachedInputTokens: 2,
    });
    const events = [
      buildEvent({
        type: "generation.start",
        eventId: "e1",
        sequence: 0,
        occurredAt: 1_000,
        generationId: "gen_1",
        model: { modelId: "test-model" },
      }),
      buildEvent({
        type: "generation.end",
        eventId: "e2",
        sequence: 1,
        occurredAt: 1_100,
        generationId: "gen_1",
        model: { modelId: "test-model" },
        outcome: "ok",
        usage,
      }),
    ];

    const spans = canonicalEventsToReadableSpans(events, { resource });
    expect(spans[0]?.attributes["gen_ai.usage.input_tokens"]).toBe(12);
    expect(spans[0]?.attributes["gen_ai.usage.output_tokens"]).toBe(4);
  });

  it("derives the same trace id for every span of one invocation", () => {
    const events = [
      // An *end* edge: a lone start is deferred, so it would contribute no span.
      buildEvent({
        type: "session.end",
        eventId: "e1",
        sequence: 0,
        occurredAt: 1_000,
        reason: "completed",
      }),
      buildEvent({
        type: "prompt.submitted",
        eventId: "e2",
        sequence: 1,
        occurredAt: 1_001,
        promptSource: "user",
      }),
    ];

    const spans = canonicalEventsToReadableSpans(events, { resource });
    expect(spans).toHaveLength(2);
    const [first, second] = spans;
    expect(first?.spanContext().traceId).toBe(second?.spanContext().traceId);
    expect(first?.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(first?.spanContext().spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is a pure function: identical input produces byte-identical span ids", () => {
    const events = [
      buildEvent({
        type: "tool.start",
        eventId: "e1",
        sequence: 0,
        occurredAt: 1_000,
        toolCallId: "call_1",
        toolName: "read_file",
        toolKind: "read",
      }),
    ];

    const a = canonicalEventsToReadableSpans(events, { resource });
    const b = canonicalEventsToReadableSpans(events, { resource });
    expect(a[0]?.spanContext()).toEqual(b[0]?.spanContext());
  });

  it("hangs a generation under its session and a tool under its generation", () => {
    const events = [
      buildEvent({
        type: "session.start",
        eventId: "e1",
        sequence: 0,
        occurredAt: 1_000,
        sessionKind: "interactive",
      }),
      buildEvent({
        type: "generation.start",
        eventId: "e2",
        sequence: 1,
        occurredAt: 1_001,
        generationId: "gen_1",
        model: { modelId: "test-model" },
      }),
      buildEvent({
        type: "tool.start",
        eventId: "e3",
        sequence: 2,
        occurredAt: 1_002,
        toolCallId: "call_1",
        toolName: "read_file",
        toolKind: "read",
        generationId: "gen_1",
      }),
    ];

    const spans = canonicalEventsToReadableSpans(events, { resource });
    const byName = new Map(spans.map((span) => [span.name, span]));
    const session = byName.get("session");
    const generation = byName.get("generation test-model");
    const tool = byName.get("tool read_file");

    expect(session?.parentSpanContext).toBeUndefined();
    expect(generation?.parentSpanContext?.spanId).toBe(session?.spanContext().spanId);
    expect(tool?.parentSpanContext?.spanId).toBe(generation?.spanContext().spanId);
    // A parent always shares its child's trace: the tree is one trace, not three.
    expect(tool?.parentSpanContext?.traceId).toBe(tool?.spanContext().traceId);
  });

  it("puts two processes of the same session in one trace and two sessions in two", () => {
    const edge = (sessionId: string, invocationId: string, eventId: string) =>
      buildEvent({
        sessionId,
        invocationId,
        // An end edge, so each single-event batch produces a span to compare.
        type: "tool.end",
        eventId,
        sequence: 0,
        occurredAt: 1_000,
        toolCallId: "call_1",
        toolName: "read_file",
        outcome: "ok",
      });

    // Same session, two short-lived processes: the invocation id differs by
    // construction, and that must not split the trace.
    const [processA] = canonicalEventsToReadableSpans([edge(identity.sessionId, "inv_a", "e1")], {
      resource,
    });
    const [processB] = canonicalEventsToReadableSpans([edge(identity.sessionId, "inv_b", "e2")], {
      resource,
    });
    expect(processA?.spanContext().traceId).toBe(processB?.spanContext().traceId);
    expect(processA?.spanContext().spanId).toBe(processB?.spanContext().spanId);

    const [otherSession] = canonicalEventsToReadableSpans([edge("ses_other", "inv_c", "e3")], {
      resource,
    });
    expect(otherSession?.spanContext().traceId).not.toBe(processA?.spanContext().traceId);
    expect(otherSession?.spanContext().spanId).not.toBe(processA?.spanContext().spanId);
  });

  it("keeps two providers that reuse one session id in separate traces", () => {
    const edge = (providerId: string) =>
      buildEvent({
        provenance: { ...identity.provenance, providerId },
        type: "tool.end",
        eventId: "e1",
        sequence: 0,
        occurredAt: 1_000,
        toolCallId: "call_1",
        toolName: "read_file",
        outcome: "ok",
      });

    const [first] = canonicalEventsToReadableSpans([edge("fixture")], { resource });
    const [second] = canonicalEventsToReadableSpans([edge("other-provider")], { resource });
    expect(first?.spanContext().traceId).not.toBe(second?.spanContext().traceId);
    expect(first?.spanContext().spanId).not.toBe(second?.spanContext().spanId);
  });

  it("completes an end-only span from a correlation resolved out of state", () => {
    const events = [
      buildEvent({
        type: "tool.end",
        eventId: "e2",
        sequence: 0,
        occurredAt: 1_450,
        toolCallId: "call_1",
        toolName: "read_file",
        outcome: "ok",
      }),
    ];

    const spans = canonicalEventsToReadableSpans(events, {
      resource,
      correlations: [
        {
          providerId: identity.provenance.providerId,
          sessionId: identity.sessionId,
          ref: { family: "tool", scopeKey: "call_1" },
          pairing: "cross-process",
          orphan: "none",
          startMillis: 1_000,
          endMillis: 1_450,
          parent: { family: "generation", scopeKey: "gen_1" },
          attributes: { "otelhook.tool.kind": "read" },
        },
      ],
    });

    expect(spans).toHaveLength(1);
    const span = spans[0];
    expect(span?.attributes["otelhook.span.paired"]).toBe(true);
    expect(span?.attributes["otelhook.span.pairing"]).toBe("cross-process");
    expect(span?.attributes["otelhook.span.orphan"]).toBe("none");
    // The start process's tool kind survives into a span built from the end alone.
    expect(span?.attributes["otelhook.tool.kind"]).toBe("read");
    const durationMillis = (span?.duration[0] ?? 0) * 1000 + (span?.duration[1] ?? 0) / 1e6;
    expect(durationMillis).toBeCloseTo(450, 5);
    // The parent recorded at start time wins over the session default the end
    // event alone would have implied.
    expect(span?.parentSpanContext?.spanId).toBeDefined();
  });

  it("labels an orphaned end explicitly instead of inventing a start", () => {
    const events = [
      buildEvent({
        type: "tool.end",
        eventId: "e2",
        sequence: 0,
        occurredAt: 2_000,
        toolCallId: "call_gone",
        toolName: "read_file",
        outcome: "ok",
      }),
    ];

    const spans = canonicalEventsToReadableSpans(events, {
      resource,
      correlations: [
        {
          providerId: identity.provenance.providerId,
          sessionId: identity.sessionId,
          ref: { family: "tool", scopeKey: "call_gone" },
          pairing: "unpaired",
          orphan: "expired-start",
          endMillis: 2_000,
        },
      ],
    });

    expect(spans[0]?.attributes["otelhook.span.paired"]).toBe(false);
    expect(spans[0]?.attributes["otelhook.span.orphan"]).toBe("expired-start");
    // No fabricated duration: the span collapses onto the instant we saw.
    expect(spans[0]?.duration).toEqual([0, 0]);
  });

  it("lets a live edge override an attribute recovered from the start process", () => {
    const events = [
      buildEvent({
        type: "generation.end",
        eventId: "e2",
        sequence: 0,
        occurredAt: 1_100,
        generationId: "gen_1",
        model: { modelId: "responded-model" },
        outcome: "error",
      }),
    ];

    const spans = canonicalEventsToReadableSpans(events, {
      resource,
      correlations: [
        {
          providerId: identity.provenance.providerId,
          sessionId: identity.sessionId,
          ref: { family: "generation", scopeKey: "gen_1" },
          pairing: "cross-process",
          orphan: "none",
          startMillis: 1_000,
          endMillis: 1_100,
          attributes: { "gen_ai.request.model": "requested-model" },
        },
      ],
    });

    expect(spans[0]?.attributes["gen_ai.request.model"]).toBe("requested-model");
    expect(spans[0]?.attributes["gen_ai.response.model"]).toBe("responded-model");
    expect(spans[0]?.status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[0]?.attributes["error.type"]).toBe("error");
  });

  it("re-exports an identical span for a redelivered end", () => {
    const events = [
      buildEvent({
        type: "tool.end",
        eventId: "e2",
        sequence: 0,
        occurredAt: 1_450,
        toolCallId: "call_1",
        toolName: "read_file",
        outcome: "ok",
      }),
    ];
    const correlations = [
      {
        providerId: identity.provenance.providerId,
        sessionId: identity.sessionId,
        ref: { family: "tool", scopeKey: "call_1" } as const,
        pairing: "cross-process" as const,
        orphan: "none" as const,
        startMillis: 1_000,
        endMillis: 1_450,
      },
    ];

    const first = canonicalEventsToReadableSpans(events, { resource, correlations });
    const second = canonicalEventsToReadableSpans(events, { resource, correlations });
    expect(first[0]?.spanContext()).toEqual(second[0]?.spanContext());
    expect(first[0]?.startTime).toEqual(second[0]?.startTime);
    expect(first[0]?.endTime).toEqual(second[0]?.endTime);
  });

  it("ignores a correlation for a scope that is not in the batch", () => {
    const events = [
      buildEvent({
        type: "tool.start",
        eventId: "e1",
        sequence: 0,
        occurredAt: 1_000,
        toolCallId: "call_1",
        toolName: "read_file",
        toolKind: "read",
      }),
    ];

    const spans = canonicalEventsToReadableSpans(events, {
      resource,
      correlations: [
        {
          providerId: identity.provenance.providerId,
          sessionId: identity.sessionId,
          ref: { family: "tool", scopeKey: "some_other_call" },
          pairing: "cross-process",
          orphan: "none",
          startMillis: 1,
          endMillis: 99_999,
        },
      ],
    });

    // The correlation names a different scope, so it is not applied. With no
    // correlation of its own the lone start is deferred, and crucially it does
    // *not* borrow the other scope's recovered 1..99_999 window.
    expect(spans).toHaveLength(0);
  });

  it("does not apply another scope's correlation to an end edge", () => {
    const events = [
      buildEvent({
        type: "tool.end",
        eventId: "e2",
        sequence: 1,
        occurredAt: 1_000,
        toolCallId: "call_1",
        toolName: "read_file",
        outcome: "ok",
      }),
    ];

    const spans = canonicalEventsToReadableSpans(events, {
      resource,
      correlations: [
        {
          providerId: identity.provenance.providerId,
          sessionId: identity.sessionId,
          ref: { family: "tool", scopeKey: "some_other_call" },
          pairing: "cross-process",
          orphan: "none",
          disposition: "emit",
          startMillis: 1,
          endMillis: 99_999,
        },
      ],
    });

    expect(spans).toHaveLength(1);
    expect(spans[0]?.attributes["otelhook.span.orphan"]).toBe("missing-start");
    // Collapsed on the end instant, not stretched to the unrelated scope's window.
    expect(spans[0]?.duration).toEqual([0, 0]);
  });
});
