import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import type { InstrumentationScope } from "@opentelemetry/core";
import type { Resource } from "@opentelemetry/resources";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";

import type { ExporterPolicy } from "../config/schema.js";
import { createErrorInfo, type OtelHookErrorInfo } from "../errors/index.js";
import { createHealthTracker, type DeliveryHealthSnapshot } from "../diagnostics/health.js";
import type { CanonicalEvent } from "../model/events.js";
import type { Clock, Logger, TelemetryEmitResult, TelemetrySink } from "../runtime/ports.js";
import type { DurableSpool, SerializedSpan, SpoolBatch } from "./durable-spool.js";
import { replayResource, resourceFromExporterPolicy } from "./exporter-resource.js";
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
  const resource = resourceFromExporterPolicy(options.exporter);
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
