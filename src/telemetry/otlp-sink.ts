import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import type { InstrumentationScope } from "@opentelemetry/core";
import { resourceFromAttributes, type Resource } from "@opentelemetry/resources";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";

import {
  checkResourceAttributeKey,
  isReservedResourceAttributeKey,
  MAX_RESOURCE_ATTRIBUTE_VALUE_LENGTH,
  MAX_RESOURCE_ATTRIBUTES,
  sanitizeResourceAttributes,
} from "../config/resource-attributes.js";
import type { ExporterPolicy } from "../config/schema.js";
import { createErrorInfo, type OtelHookErrorInfo } from "../errors/index.js";
import { createHealthTracker, type DeliveryHealthSnapshot } from "../diagnostics/health.js";
import type { CanonicalEvent } from "../model/events.js";
import { MAX_IDENTIFIER_LENGTH } from "../model/primitives.js";
import type { Clock, Logger, TelemetryEmitResult, TelemetrySink } from "../runtime/ports.js";
import type { DurableSpool, SerializedSpan, SpoolBatch } from "./durable-spool.js";
import {
  assembleReadableSpan,
  canonicalEventsToReadableSpans,
  DEFAULT_INSTRUMENTATION_SCOPE,
  type SpanCorrelation,
  type SpanCorrelationResolver,
} from "./semconv.js";

const chunk = <T,>(items: readonly T[], size: number): readonly (readonly T[])[] => {
  if (size <= 0 || items.length <= size) {
    return [items];
  }
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

const serializeSpan = (span: ReadableSpan): SerializedSpan => ({
  name: span.name,
  kind: span.kind,
  traceId: span.spanContext().traceId,
  spanId: span.spanContext().spanId,
  ...(span.parentSpanContext === undefined
    ? {}
    : { parentSpanId: span.parentSpanContext.spanId }),
  startMillis: span.startTime[0] * 1000 + Math.round(span.startTime[1] / 1e6),
  endMillis: span.endTime[0] * 1000 + Math.round(span.endTime[1] / 1e6),
  attributes: { ...span.attributes },
  statusCode: span.status.code,
  ...(span.status.message === undefined ? {} : { statusMessage: span.status.message }),
});

const deserializeSpan = (
  serialized: SerializedSpan,
  resource: Resource,
  scope: InstrumentationScope,
): ReadableSpan =>
  assembleReadableSpan({
    name: serialized.name,
    kind: serialized.kind,
    startMillis: serialized.startMillis,
    endMillis: serialized.endMillis,
    attributes: serialized.attributes,
    status: { code: serialized.statusCode, ...(serialized.statusMessage === undefined ? {} : { message: serialized.statusMessage }) },
    traceId: serialized.traceId,
    spanId: serialized.spanId,
    ...(serialized.parentSpanId === undefined ? {} : { parentSpanId: serialized.parentSpanId }),
    resource,
    instrumentationScope: scope,
  });

/**
 * A spool file is a plain JSON file in a state directory, so everything read
 * back out of one is untrusted input — it can be hand-edited, truncated, or
 * written by an older release with a different schema. These bounds mirror the
 * live path's, because "what the exporter would have refused from a flag" and
 * "what it accepts from disk" diverging is the whole vulnerability.
 */
const isReplayableValue = (
  value: unknown,
): value is string | number | boolean =>
  (typeof value === "string" && value.length <= MAX_RESOURCE_ATTRIBUTE_VALUE_LENGTH) ||
  (typeof value === "number" && Number.isFinite(value)) ||
  typeof value === "boolean";

/**
 * Validate a service identity read back from a spool file.
 *
 * `service.name` decides which service every replayed span is attributed to, so
 * a spool that could set it freely could attribute this installation's telemetry
 * to somebody else's service — the one resource field where a forged value is a
 * reporting-integrity problem rather than a cosmetic one. It is therefore held to
 * the same contract as the typed policy field: a non-empty string within
 * {@link MAX_IDENTIFIER_LENGTH}. Anything else is not "replayed as recorded", it
 * is discarded in favour of the draining process's own policy.
 */
const replayableServiceIdentity = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH
    ? value
    : undefined;

/**
 * Rebuild the resource a spooled batch was recorded with.
 *
 * A recorded `service.name` is a fact about the process that made the
 * observation, not about the one draining the spool, so a *valid* one is
 * replayed as recorded. But every field is re-validated on the way out, at the
 * same bounds the live path enforces: custom keys must pass
 * {@link checkResourceAttributeKey} (which refuses reserved and secret-looking
 * names), values must be primitives within the length bound, the custom count is
 * capped, and the two reserved service fields must look like the identifiers they
 * are. A batch that fails the service check falls back to the live policy rather
 * than exporting with no service identity, because a resource without
 * `service.name` is rejected or bucketed as "unknown_service" by most collectors
 * — losing the batch to a tampered byte would make the validation itself the
 * outage.
 */
const replayResource = (
  attributes: SpoolBatch["resourceAttributes"],
  policy: ExporterPolicy,
): Resource => {
  const safe: Record<string, string | number | boolean> = {};
  let customCount = 0;
  for (const [key, value] of Object.entries(attributes)) {
    if (isReservedResourceAttributeKey(key)) {
      // Handled below against the policy fallback, never copied verbatim.
      continue;
    }
    if (!isReplayableValue(value)) {
      continue;
    }
    if (checkResourceAttributeKey(key) !== undefined || customCount >= MAX_RESOURCE_ATTRIBUTES) {
      continue;
    }
    customCount += 1;
    safe[key] = value;
  }

  // Reserved keys last and unconditionally, so a spooled custom attribute can
  // never occupy the slot a service field is about to be written into.
  const recordedName = replayableServiceIdentity(attributes["service.name"]);
  const recordedNamespace = replayableServiceIdentity(attributes["service.namespace"]);
  safe["service.name"] = recordedName ?? policy.serviceName;
  const namespace = recordedNamespace ?? policy.serviceNamespace;
  if (namespace !== undefined) {
    safe["service.namespace"] = namespace;
  }

  return resourceFromAttributes(safe);
};

export type OtlpTraceSinkOptions = {
  readonly exporter: ExporterPolicy;
  /** Header values, kept out of the resolved-config snapshot (ADR: config carries only header *names*). */
  readonly headers?: Readonly<Record<string, string>>;
  readonly providerId: string;
  readonly installationId: string;
  readonly clock: Clock;
  readonly logger?: Logger;
  /** Persists batches an unreachable collector rejected, for a later retry. */
  readonly spool?: DurableSpool;
  readonly instrumentationScope?: InstrumentationScope;
  /**
   * Supplies cross-process pairing for lifecycle spans, normally the
   * {@link SpanCorrelator}. Omitted, the sink pairs only within a batch.
   *
   * Injected as a plain function rather than as a correlator so the telemetry
   * layer keeps no dependency on lifecycle or on the state store (ADR 0006).
   */
  readonly correlate?: SpanCorrelationResolver;
};

export interface OtlpTelemetrySink extends TelemetrySink {
  health(): DeliveryHealthSnapshot;
  /** Attempts to resend previously spooled batches, bounded by `maxBatches`. */
  drainSpool(maxBatches?: number): Promise<{ readonly drained: number; readonly remaining: number; readonly failed: number }>;
}

/** Sink that accepts every batch and does nothing else: exporter disabled or protocol `none`. */
const createDisabledSink = (): OtlpTelemetrySink => {
  const health = createHealthTracker("telemetry-sink");
  return {
    emit: (events): Promise<TelemetryEmitResult> => {
      health.recordSuccess(events.length);
      return Promise.resolve({ accepted: events.length, rejected: 0, errors: [] });
    },
    flush: (): Promise<void> => Promise.resolve(),
    shutdown: (): Promise<void> => Promise.resolve(),
    health: (): DeliveryHealthSnapshot => health.snapshot(),
    drainSpool: (): Promise<{ readonly drained: number; readonly remaining: number; readonly failed: number }> =>
      Promise.resolve({ drained: 0, remaining: 0, failed: 0 }),
  };
};

/**
 * OTLP HTTP/protobuf {@link TelemetrySink}.
 *
 * Semantic mapping lives entirely in `semconv.ts`; this module only owns
 * batching, delivery, bounded flush/shutdown, health tracking, and — when a
 * spool is configured — persisting what a down collector rejected. Every
 * failure mode (disabled config, missing endpoint, export failure, timeout,
 * spool write failure, unreadable correlation state) degrades to a reported
 * diagnostic rather than a thrown error, preserving the hook's fail-open
 * contract.
 *
 * A disabled sink never calls `correlate`: with nothing being exported there is
 * no span to pair, and writing correlation state anyway would leave a disabled
 * installation quietly accumulating files.
 */
export const createOtlpTraceSink = (options: OtlpTraceSinkOptions): OtlpTelemetrySink => {
  if (!options.exporter.enabled || options.exporter.protocol === "none") {
    return createDisabledSink();
  }
  if (options.exporter.endpoint === undefined) {
    options.logger?.warn("otlp sink disabled: no endpoint configured", {});
    return createDisabledSink();
  }
  if (options.exporter.protocol !== "http/protobuf") {
    options.logger?.warn("otlp sink: protocol not supported by this build, falling back to disabled", {
      "exporter.protocol": options.exporter.protocol,
    });
    return createDisabledSink();
  }

  const scope = options.instrumentationScope ?? DEFAULT_INSTRUMENTATION_SCOPE;
  // Custom attributes first, then service identity: spread order makes the
  // policy fields structurally unoverridable. `sanitizeResourceAttributes`
  // already drops the reserved keys, so this is belt-and-braces for a caller
  // who hand-built an ExporterPolicy without running it through the schema —
  // but between them, `service.name` can only ever come from policy.
  const resource = resourceFromAttributes({
    ...sanitizeResourceAttributes(options.exporter.resourceAttributes),
    "service.name": options.exporter.serviceName,
    ...(options.exporter.serviceNamespace === undefined
      ? {}
      : { "service.namespace": options.exporter.serviceNamespace }),
  });
  const health = createHealthTracker("telemetry-sink");
  const exporter = new OTLPTraceExporter({
    url: options.exporter.endpoint,
    headers: { ...options.headers },
    timeoutMillis: options.exporter.timeoutMillis,
  });
  let shutdownCompleted = false;

  const exportSpans = (spans: readonly ReadableSpan[]): Promise<ExportResult> =>
    new Promise((resolve) => {
      exporter.export([...spans], (result: ExportResult) => resolve(result));
    });

  const toSpoolBatch = (spans: readonly ReadableSpan[]): SpoolBatch => ({
    providerId: options.providerId,
    installationId: options.installationId,
    resourceAttributes: { ...resource.attributes },
    instrumentationScope: { name: scope.name, ...(scope.version === undefined ? {} : { version: scope.version }) },
    spans: spans.map(serializeSpan),
    enqueuedAt: options.clock.now(),
  });

  const sendSerializedBatch = async (batch: SpoolBatch): Promise<boolean> => {
    const batchResource = replayResource(batch.resourceAttributes, options.exporter);
    const spans = batch.spans.map((span) => deserializeSpan(span, batchResource, batch.instrumentationScope));
    const result = await exportSpans(spans);
    return result.code === ExportResultCode.SUCCESS;
  };

  /**
   * Cross-process pairing is an enrichment, never a precondition: if state is
   * unreadable the batch still exports, with each lifecycle span flagged
   * unpaired rather than dropped.
   *
   * `available` is reported separately from the (possibly empty) list because the
   * mapping needs the two apart. An empty list from a healthy correlator and an
   * empty list from a correlator that threw look identical, and only the first
   * means "the state store is holding these starts". Conflating them would drop an
   * unpaired start that nothing recorded, and the export would then report zero
   * rejections — so a caller would commit a callback whose telemetry went nowhere.
   */
  const resolveCorrelations = async (
    events: readonly CanonicalEvent[],
  ): Promise<{
    readonly correlations: readonly SpanCorrelation[];
    readonly available: boolean | undefined;
  }> => {
    if (options.correlate === undefined) {
      return { correlations: [], available: undefined };
    }
    try {
      return { correlations: await options.correlate(events), available: true };
    } catch {
      options.logger?.warn("span correlation unavailable; exporting unpaired spans", {});
      return { correlations: [], available: false };
    }
  };

  const emit = async (events: Parameters<TelemetrySink["emit"]>[0]): Promise<TelemetryEmitResult> => {
    if (events.length === 0) {
      return { accepted: 0, rejected: 0, errors: [] };
    }
    const resolved = await resolveCorrelations(events);
    const spans = canonicalEventsToReadableSpans(events, {
      resource,
      instrumentationScope: scope,
      correlations: resolved.correlations,
      ...(resolved.available === undefined ? {} : { correlationAvailable: resolved.available }),
    });
    const errors: OtelHookErrorInfo[] = [];
    let accepted = 0;
    let rejected = 0;

    for (const batch of chunk(spans, options.exporter.maxBatchSize)) {
      let result: ExportResult;
      try {
        result = await exportSpans(batch);
      } catch (thrown) {
        result = { code: ExportResultCode.FAILED, error: thrown instanceof Error ? thrown : new Error("export threw") };
      }
      if (result.code === ExportResultCode.SUCCESS) {
        accepted += batch.length;
        health.recordSuccess(batch.length, options.clock.now());
        continue;
      }

      health.recordFailure("telemetry-export-failure", batch.length, options.clock.now());
      if (options.spool !== undefined) {
        const spoolResult = await options.spool.enqueue(toSpoolBatch(batch)).catch(() => ({
          spooled: false as const,
          reason: "capacity-exceeded" as const,
        }));
        if (spoolResult.spooled) {
          accepted += batch.length;
          continue;
        }
      }
      rejected += batch.length;
      errors.push(
        createErrorInfo({
          code: "telemetry-export-failure",
          phase: "export",
          detail: "collector rejected or was unreachable for a span batch",
          details: { "export.batch_size": batch.length },
        }),
      );
    }

    return { accepted, rejected, errors };
  };

  const drainSpool = async (
    maxBatches?: number,
  ): Promise<{ readonly drained: number; readonly remaining: number; readonly failed: number }> => {
    if (options.spool === undefined) {
      return { drained: 0, remaining: 0, failed: 0 };
    }
    const result = await options.spool.drain(sendSerializedBatch, { ...(maxBatches === undefined ? {} : { maxBatches }) });
    if (result.drained > 0) {
      health.recordSuccess(result.drained, options.clock.now());
    }
    return result;
  };

  const flush = async (): Promise<void> => {
    try {
      await exporter.forceFlush();
    } catch {
      // Best-effort: flush failures are reported through health, never thrown.
    }
    await drainSpool().catch(() => undefined);
  };

  const shutdown = async (): Promise<void> => {
    if (shutdownCompleted) {
      return;
    }
    shutdownCompleted = true;
    await flush();
    try {
      await exporter.shutdown();
    } catch {
      // Idempotent, non-throwing per the TelemetrySink contract.
    }
  };

  return {
    emit,
    flush,
    shutdown,
    health: (): DeliveryHealthSnapshot => health.snapshot(),
    drainSpool,
  };
};
