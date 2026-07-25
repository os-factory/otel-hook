import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import type { InstrumentationScope } from "@opentelemetry/core";
import { resourceFromAttributes, type Resource } from "@opentelemetry/resources";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";

import type { ExporterPolicy } from "../config/schema.js";
import { createErrorInfo, type OtelHookErrorInfo } from "../errors/index.js";
import { createHealthTracker, type DeliveryHealthSnapshot } from "../diagnostics/health.js";
import type { Clock, Logger, TelemetryEmitResult, TelemetrySink } from "../runtime/ports.js";
import type { DurableSpool, SerializedSpan, SpoolBatch } from "./durable-spool.js";
import {
  assembleReadableSpan,
  canonicalEventsToReadableSpans,
  DEFAULT_INSTRUMENTATION_SCOPE,
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
 * spool write failure) degrades to a reported diagnostic rather than a thrown
 * error, preserving the hook's fail-open contract.
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
  const resource = resourceFromAttributes({
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
    const batchResource = resourceFromAttributes(batch.resourceAttributes);
    const spans = batch.spans.map((span) => deserializeSpan(span, batchResource, batch.instrumentationScope));
    const result = await exportSpans(spans);
    return result.code === ExportResultCode.SUCCESS;
  };

  const emit = async (events: Parameters<TelemetrySink["emit"]>[0]): Promise<TelemetryEmitResult> => {
    if (events.length === 0) {
      return { accepted: 0, rejected: 0, errors: [] };
    }
    const spans = canonicalEventsToReadableSpans(events, { resource, instrumentationScope: scope });
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
