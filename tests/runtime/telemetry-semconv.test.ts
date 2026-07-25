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

  it("gives a lone start (no end in this batch) a degenerate zero-duration span flagged unpaired", () => {
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

    const spans = canonicalEventsToReadableSpans(events, { resource });
    expect(spans).toHaveLength(1);
    expect(spans[0]?.attributes["otelhook.span.paired"]).toBe(false);
    expect(spans[0]?.duration).toEqual([0, 0]);
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
      buildEvent({
        type: "session.start",
        eventId: "e1",
        sequence: 0,
        occurredAt: 1_000,
        sessionKind: "interactive",
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
});
