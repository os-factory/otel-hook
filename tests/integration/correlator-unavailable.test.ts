import { resourceFromAttributes } from "@opentelemetry/resources";
import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../../src/config/schema.js";
import { createSpanCorrelator } from "../../src/lifecycle/span-correlator.js";
import { parseCanonicalEvent, type CanonicalEvent } from "../../src/model/events.js";
import { CANONICAL_SCHEMA_VERSION } from "../../src/model/version.js";
import { createFixedClock } from "../../src/runtime/clock.js";
import { createInMemoryStateStore } from "../../src/runtime/memory.js";
import { canonicalEventsToReadableSpans } from "../../src/telemetry/semconv.js";
import { createOtlpTraceSink } from "../../src/telemetry/otlp-sink.js";
import { createTestIdentity } from "../../src/testing/index.js";
import { startCapturingCollector } from "../helpers/collector.js";
import { decodeAllExportedSpans } from "../helpers/otlp.js";

/**
 * What happens to an unpaired `*.start` when the state store cannot hold it.
 *
 * Deferring a lone start is only safe because the correlator has just written a
 * record for it — the end edge will publish the completed span from that record.
 * When the write fails, deferring becomes a silent drop: the observation is
 * neither persisted nor exported, the export reports zero rejections, and a caller
 * that keys its commit decision on rejections marks the callback handled forever.
 *
 * So a start that nothing recorded must be exported, and it must not claim the span
 * id a later end will publish for the same scope.
 */

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

const toolStart = buildEvent({
  type: "tool.start",
  eventId: "evt_start_1",
  sequence: 0,
  occurredAt: 1_000,
  toolCallId: "call_1",
  toolName: "read_file",
  toolKind: "read",
});

const toolEnd = buildEvent({
  type: "tool.end",
  eventId: "evt_end_1",
  sequence: 1,
  occurredAt: 1_800,
  toolCallId: "call_1",
  toolName: "read_file",
  outcome: "ok",
});

describe("an unpaired start is only dropped when something is holding it", () => {
  it("defers when the correlator says the record is durable", () => {
    const spans = canonicalEventsToReadableSpans([toolStart], {
      resource,
      correlationAvailable: true,
      correlations: [
        {
          providerId: identity.provenance.providerId,
          sessionId: identity.sessionId,
          ref: { family: "tool", scopeKey: "call_1" },
          pairing: "unpaired",
          orphan: "missing-end",
          disposition: "defer",
        },
      ],
    });

    // The state store is holding it; the end edge will publish the complete span.
    expect(spans).toHaveLength(0);
  });

  it("exports a uniquely identified fallback when the correlator failed", () => {
    const spans = canonicalEventsToReadableSpans([toolStart], {
      resource,
      // The correlator was consulted and could not answer, so nothing recorded
      // this start.
      correlationAvailable: false,
      correlations: [],
    });

    expect(spans).toHaveLength(1);
    expect(spans[0]?.attributes["otelhook.span.orphan"]).toBe("state-unavailable");
    expect(spans[0]?.attributes["otelhook.span.paired"]).toBe(false);

    // Crucially, not the scope's canonical span id: a later end will publish that
    // id itself as an orphan, and two records claiming one identity is exactly what
    // OTLP cannot reconcile.
    const canonical = canonicalEventsToReadableSpans([toolEnd], {
      resource,
      correlationAvailable: true,
      correlations: [
        {
          providerId: identity.provenance.providerId,
          sessionId: identity.sessionId,
          ref: { family: "tool", scopeKey: "call_1" },
          pairing: "unpaired",
          orphan: "missing-start",
          disposition: "emit",
        },
      ],
    });
    expect(canonical).toHaveLength(1);
    expect(spans[0]?.spanContext().spanId).not.toBe(canonical[0]?.spanContext().spanId);
    // Same trace, so the two records still belong to one session's tree.
    expect(spans[0]?.spanContext().traceId).toBe(canonical[0]?.spanContext().traceId);
  });

  it("exports a fallback when the correlator ran but reported nothing for the scope", () => {
    const spans = canonicalEventsToReadableSpans([toolStart], {
      resource,
      correlationAvailable: true,
      correlations: [],
    });

    // A correlator that answered without mentioning this scope has not claimed to
    // be holding it, so the start is exported rather than assumed safe.
    expect(spans).toHaveLength(1);
    expect(spans[0]?.attributes["otelhook.span.orphan"]).toBe("state-unavailable");
  });

  it("still defers when no correlator is wired at all", () => {
    // Cross-process pairing was never on offer, so this is the documented
    // no-state-root degradation rather than a failure to persist something.
    expect(canonicalEventsToReadableSpans([toolStart], { resource })).toHaveLength(0);
  });
});

describe("the correlator reports an unrecordable start as emittable", () => {
  it("marks state-unavailable start-only groups emit, with a discriminator", async () => {
    const clock = createFixedClock();
    const stateStore = createInMemoryStateStore({ clock });
    const correlator = createSpanCorrelator({ stateStore, clock });

    // Fail every state operation the correlation attempt makes.
    stateStore.failNext(10);
    const correlations = await correlator.correlateBatch([toolStart]);

    expect(correlations).toHaveLength(1);
    expect(correlations[0]?.orphan).toBe("state-unavailable");
    // Not deferrable: deferring means "the store is holding this", and the store is
    // exactly what failed.
    expect(correlations[0]?.disposition).toBe("emit");
    expect(correlations[0]?.spanIdDiscriminator).toBe("evt_start_1");
  });
});

describe("the sink does not report success for a start it dropped", () => {
  it("exports the start and counts it, so the caller can commit honestly", async () => {
    const collector = await startCapturingCollector();
    try {
      const clock = createFixedClock();
      const sink = createOtlpTraceSink({
        exporter: { ...DEFAULT_CONFIG.exporter, endpoint: collector.url, timeoutMillis: 5_000 },
        providerId: "fixture",
        installationId: "install-1",
        clock,
        // A correlator that is wired and broken — the case that used to produce a
        // committed callback with nothing on the wire and nothing on disk.
        correlate: () => Promise.reject(new Error("state store unavailable")),
      });

      const result = await sink.emit([toolStart]);

      // Something reached the collector, so `accepted > 0` and the callback's claim
      // may honestly be committed.
      expect(result.accepted).toBe(1);
      expect(result.rejected).toBe(0);

      const spans = decodeAllExportedSpans(collector.bodies());
      expect(spans).toHaveLength(1);
      expect(spans[0]?.attributes["otelhook.span.orphan"]).toBe("state-unavailable");
    } finally {
      await collector.close();
    }
  });

  it("reports a total loss when the fallback itself cannot be exported", async () => {
    const clock = createFixedClock();
    const sink = createOtlpTraceSink({
      exporter: {
        ...DEFAULT_CONFIG.exporter,
        endpoint: "http://127.0.0.1:1/v1/traces",
        timeoutMillis: 200,
        maxRetryAttempts: 0,
      },
      providerId: "fixture",
      installationId: "install-1",
      clock,
      correlate: () => Promise.reject(new Error("state store unavailable")),
    });

    const result = await sink.emit([toolStart]);

    // Neither persisted nor exported, and now *said* so — which is what releases
    // the claim instead of committing a loss.
    expect(result.accepted).toBe(0);
    expect(result.rejected).toBeGreaterThan(0);
  });
});
