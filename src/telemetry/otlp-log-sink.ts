import { TraceFlags, type AttributeValue, type Attributes, type SpanContext } from "@opentelemetry/api";
import type { LogAttributes } from "@opentelemetry/api-logs";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { millisToHrTime, type InstrumentationScope } from "@opentelemetry/core";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import type { Resource } from "@opentelemetry/resources";
import type { ReadableLogRecord } from "@opentelemetry/sdk-logs";

import type { ExporterPolicy } from "../config/schema.js";
import { createHealthTracker, type DeliveryHealthSnapshot } from "../diagnostics/health.js";
import { createErrorInfo, type OtelHookErrorInfo } from "../errors/index.js";
import type { CanonicalEvent } from "../model/events.js";
import type { Clock, Logger, TelemetryEmitResult, TelemetrySink } from "../runtime/ports.js";
import type { DurableLogSpool, LogSpoolBatch, SerializedLogRecord } from "./durable-log-spool.js";
import { replayResource, resourceFromExporterPolicy } from "./exporter-resource.js";
import {
  canonicalEventsToLogRecords,
  NO_LOG_CONTENT,
  type LogContentPolicy,
} from "./log-records.js";
import {
  DEFAULT_INSTRUMENTATION_SCOPE,
  type SpanCorrelation,
  type SpanCorrelationResolver,
} from "./semconv.js";

/**
 * OTLP HTTP/protobuf log sink.
 *
 * The logs counterpart of `otlp-sink.ts`, and deliberately its mirror image:
 * semantic mapping lives entirely in `log-records.ts`, and this module owns only
 * batching, delivery, bounded flush/shutdown, health tracking, and — when a spool
 * is configured — persisting what a down collector rejected. Every failure mode
 * (disabled config, missing or underivable endpoint, export failure, timeout,
 * spool write failure) degrades to a reported diagnostic rather than a thrown
 * error, preserving the hook's fail-open contract.
 *
 * The two sinks are separate objects rather than one exporter with two encoders
 * because they fail independently: a collector that has no logs receiver, or an
 * operator who pointed logs at the wrong port, must cost the logs signal and
 * nothing else. The trace pipeline is the one an installation already depends on.
 */

const OTLP_TRACES_PATH = "/v1/traces";
const OTLP_LOGS_PATH = "/v1/logs";

/**
 * Where log records are posted.
 *
 * Resolution order, highest first:
 *
 * 1. `logs.endpoint` — stated outright, used verbatim.
 * 2. the trace endpoint with a trailing `/v1/traces` swapped for `/v1/logs`, which
 *    is the shape a collector configured for both signals actually has.
 * 3. the trace endpoint treated as a base URL, with `/v1/logs` appended — the
 *    convention the OTLP specification defines for a signal-less endpoint.
 *
 * Returned as a discriminated result rather than a bare string because "no logs
 * endpoint could be derived" has to be reportable: silently posting an
 * `ExportLogsServiceRequest` to a traces receiver produces a rejection whose cause
 * is a configuration mistake, and an operator reading "collector rejected a batch"
 * would go looking at the collector.
 */
export const resolveLogsEndpoint = (
  exporter: ExporterPolicy,
): { readonly endpoint: string; readonly derived: boolean } | { readonly unresolvable: "no-endpoint" } => {
  if (exporter.logs.endpoint !== undefined) {
    return { endpoint: exporter.logs.endpoint, derived: false };
  }
  if (exporter.endpoint === undefined) {
    return { unresolvable: "no-endpoint" };
  }
  const trimmed = exporter.endpoint.replace(/\/+$/, "");
  if (trimmed.endsWith(OTLP_LOGS_PATH)) {
    return { endpoint: trimmed, derived: true };
  }
  if (trimmed.endsWith(OTLP_TRACES_PATH)) {
    return {
      endpoint: `${trimmed.slice(0, trimmed.length - OTLP_TRACES_PATH.length)}${OTLP_LOGS_PATH}`,
      derived: true,
    };
  }
  return { endpoint: `${trimmed}${OTLP_LOGS_PATH}`, derived: true };
};

/**
 * Narrow a log record's attributes to what a spool file can hold.
 *
 * `LogAttributes` admits nested maps and byte strings; the spool's own validator
 * does not, and neither does `assembleReadableSpan`'s sibling contract for traces.
 * This mapping only ever produces primitives, so the filter is unreachable in
 * practice — it is here so that "what the live path emits" and "what survives a
 * spool round-trip" cannot silently diverge if a future attribute is richer than
 * the queue's schema.
 */
const toSpoolAttributes = (attributes: LogAttributes): Attributes => {
  const safe: Record<string, AttributeValue> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      safe[key] = value;
      continue;
    }
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      safe[key] = value;
    }
  }
  return safe;
};

const serializeRecord = (record: ReadableLogRecord): SerializedLogRecord => {
  const context = record.spanContext;
  return {
    eventName: record.eventName ?? "otelhook.record",
    severityNumber: record.severityNumber ?? 0,
    ...(record.severityText === undefined ? {} : { severityText: record.severityText }),
    ...(typeof record.body === "string" ? { body: record.body } : {}),
    timeMillis: record.hrTime[0] * 1000 + Math.round(record.hrTime[1] / 1e6),
    observedTimeMillis:
      record.hrTimeObserved[0] * 1000 + Math.round(record.hrTimeObserved[1] / 1e6),
    ...(context === undefined ? {} : { traceId: context.traceId, spanId: context.spanId }),
    attributes: toSpoolAttributes(record.attributes),
  };
};

const deserializeRecord = (
  serialized: SerializedLogRecord,
  resource: Resource,
  scope: InstrumentationScope,
): ReadableLogRecord => {
  const spanContext: SpanContext | undefined =
    serialized.traceId === undefined || serialized.spanId === undefined
      ? undefined
      : {
          traceId: serialized.traceId,
          spanId: serialized.spanId,
          traceFlags: TraceFlags.SAMPLED,
          isRemote: false,
        };
  return {
    hrTime: millisToHrTime(serialized.timeMillis),
    hrTimeObserved: millisToHrTime(serialized.observedTimeMillis),
    ...(spanContext === undefined ? {} : { spanContext }),
    severityNumber: serialized.severityNumber,
    ...(serialized.severityText === undefined ? {} : { severityText: serialized.severityText }),
    ...(serialized.body === undefined ? {} : { body: serialized.body }),
    eventName: serialized.eventName,
    resource,
    instrumentationScope: scope,
    attributes: serialized.attributes,
    droppedAttributesCount: 0,
  };
};

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

export type OtlpLogSinkOptions = {
  readonly exporter: ExporterPolicy;
  /** Header values, kept out of the resolved-config snapshot (ADR: config carries only header *names*). */
  readonly headers?: Readonly<Record<string, string>>;
  readonly providerId: string;
  readonly installationId: string;
  readonly clock: Clock;
  readonly logger?: Logger;
  /** Persists batches an unreachable collector rejected, for a later retry. */
  readonly spool?: DurableLogSpool;
  readonly instrumentationScope?: InstrumentationScope;
  /**
   * Whether disclosed content text may reach a log body. Defaults to
   * {@link NO_LOG_CONTENT}, which is what an unconfigured installation gets.
   */
  readonly content?: LogContentPolicy;
  /**
   * Supplies cross-process pairing so a record correlates to the span id the trace
   * pipeline actually exported. Omitted, records still carry a derived trace and
   * span id, computed from the batch alone.
   *
   * Injected as a plain function rather than as a correlator so the telemetry layer
   * keeps no dependency on lifecycle or on the state store (ADR 0006). When both
   * sinks are wired, the fanout resolves correlation *once* and hands the same
   * answer to each — `correlateBatch` writes state, so calling it twice per batch
   * would record a start edge twice.
   */
  readonly correlate?: SpanCorrelationResolver;
};

export interface OtlpLogTelemetrySink extends TelemetrySink {
  health(): DeliveryHealthSnapshot;
  /** Attempts to resend previously spooled batches, bounded by `maxBatches`. */
  drainSpool(
    maxBatches?: number,
  ): Promise<{ readonly drained: number; readonly remaining: number; readonly failed: number }>;
}

/**
 * Sink that swallows every batch: logs disabled, or configured but unroutable.
 *
 * Reports **zero accepted and zero rejected**, which is the one place this differs
 * from the trace sink's disabled path — and it has to. The counts a sink returns are
 * what `classifyDurability` decides commit-or-retry from, and they are summed across
 * signals. A disabled signal that claimed to have accepted the batch would make a
 * *total* trace loss look like a partial delivery: `accepted > 0` from a sink that
 * sent nothing, `rejected > 0` from the sink that failed, so the callback would
 * commit as terminally-partial instead of releasing its claim for retry. Contributing
 * nothing is the truthful answer, and it leaves durability decided entirely by the
 * signals that actually tried — so an installation with logs off behaves exactly as
 * it did before logs existed.
 *
 * Health still records the batch as accepted: nothing failed, and a disabled signal
 * must not read as unhealthy.
 */
const createDisabledSink = (): OtlpLogTelemetrySink => {
  const health = createHealthTracker("telemetry-log-sink");
  return {
    emit: (events): Promise<TelemetryEmitResult> => {
      health.recordSuccess(events.length);
      return Promise.resolve({ accepted: 0, rejected: 0, errors: [] });
    },
    flush: (): Promise<void> => Promise.resolve(),
    shutdown: (): Promise<void> => Promise.resolve(),
    health: (): DeliveryHealthSnapshot => health.snapshot(),
    drainSpool: (): Promise<{
      readonly drained: number;
      readonly remaining: number;
      readonly failed: number;
    }> => Promise.resolve({ drained: 0, remaining: 0, failed: 0 }),
  };
};

/**
 * Whether this configuration can deliver logs at all.
 *
 * Separated from the constructor so `doctor` can report the same verdict without
 * building an exporter, and so each refusal names itself rather than collapsing
 * into one "disabled" state an operator then has to bisect.
 */
export type LogsDeliverability =
  | { readonly status: "configured"; readonly endpoint: string; readonly derivedEndpoint: boolean }
  | {
      readonly status: "disabled";
      readonly reason:
        | "logs-disabled"
        | "exporter-disabled"
        | "protocol-none"
        | "protocol-unsupported"
        | "no-endpoint";
    };

export const describeLogsDeliverability = (exporter: ExporterPolicy): LogsDeliverability => {
  if (!exporter.logs.enabled) {
    return { status: "disabled", reason: "logs-disabled" };
  }
  if (!exporter.enabled) {
    return { status: "disabled", reason: "exporter-disabled" };
  }
  if (exporter.protocol === "none") {
    return { status: "disabled", reason: "protocol-none" };
  }
  if (exporter.protocol !== "http/protobuf") {
    return { status: "disabled", reason: "protocol-unsupported" };
  }
  const resolved = resolveLogsEndpoint(exporter);
  if ("unresolvable" in resolved) {
    return { status: "disabled", reason: "no-endpoint" };
  }
  return { status: "configured", endpoint: resolved.endpoint, derivedEndpoint: resolved.derived };
};

const DISABLED_DETAIL: Readonly<Record<Extract<LogsDeliverability, { status: "disabled" }>["reason"], string>> =
  Object.freeze({
    "logs-disabled": "otlp log sink disabled: exporter.logs.enabled is false",
    "exporter-disabled": "otlp log sink disabled: the exporter is disabled",
    "protocol-none": "otlp log sink disabled: protocol is none",
    "protocol-unsupported":
      "otlp log sink disabled: protocol not supported by this build, falling back to disabled",
    "no-endpoint": "otlp log sink disabled: no logs endpoint configured and none could be derived",
  });

/**
 * OTLP HTTP/protobuf {@link TelemetrySink} for the logs signal.
 *
 * A disabled sink never calls `correlate`: with nothing being exported there is no
 * span to correlate to, and writing correlation state anyway would leave a disabled
 * installation quietly accumulating files.
 */
export const createOtlpLogSink = (options: OtlpLogSinkOptions): OtlpLogTelemetrySink => {
  const deliverability = describeLogsDeliverability(options.exporter);
  if (deliverability.status === "disabled") {
    if (deliverability.reason !== "logs-disabled") {
      // `logs-disabled` is the default posture, not a misconfiguration, so it is
      // not worth a warning on every invocation. The rest are: somebody asked for
      // logs and will not get them.
      options.logger?.warn(DISABLED_DETAIL[deliverability.reason], {
        "exporter.protocol": options.exporter.protocol,
      });
    }
    return createDisabledSink();
  }

  const scope = options.instrumentationScope ?? DEFAULT_INSTRUMENTATION_SCOPE;
  const resource = resourceFromExporterPolicy(options.exporter);
  const content = options.content ?? NO_LOG_CONTENT;
  const health = createHealthTracker("telemetry-log-sink");
  const exporter = new OTLPLogExporter({
    url: deliverability.endpoint,
    headers: { ...options.headers },
    timeoutMillis: options.exporter.timeoutMillis,
  });
  let shutdownCompleted = false;

  const exportRecords = (records: readonly ReadableLogRecord[]): Promise<ExportResult> =>
    new Promise((resolve) => {
      exporter.export([...records], (result: ExportResult) => resolve(result));
    });

  const toSpoolBatch = (records: readonly ReadableLogRecord[]): LogSpoolBatch => ({
    providerId: options.providerId,
    installationId: options.installationId,
    resourceAttributes: { ...resource.attributes },
    instrumentationScope: {
      name: scope.name,
      ...(scope.version === undefined ? {} : { version: scope.version }),
    },
    records: records.map(serializeRecord),
    enqueuedAt: options.clock.now(),
  });

  const sendSerializedBatch = async (batch: LogSpoolBatch): Promise<boolean> => {
    const batchResource = replayResource(batch.resourceAttributes, options.exporter);
    const records = batch.records.map((record) =>
      deserializeRecord(record, batchResource, batch.instrumentationScope),
    );
    const result = await exportRecords(records);
    return result.code === ExportResultCode.SUCCESS;
  };

  /**
   * Cross-process pairing is an enrichment, never a precondition: if state is
   * unreadable the batch still exports, with each record correlated from the batch
   * alone rather than dropped.
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
      options.logger?.warn("span correlation unavailable; exporting uncorrelated log records", {});
      return { correlations: [], available: false };
    }
  };

  const emit = async (events: Parameters<TelemetrySink["emit"]>[0]): Promise<TelemetryEmitResult> => {
    if (events.length === 0) {
      return { accepted: 0, rejected: 0, errors: [] };
    }
    const resolved = await resolveCorrelations(events);
    const mapped = canonicalEventsToLogRecords(events, {
      resource,
      instrumentationScope: scope,
      content,
      correlations: resolved.correlations,
      ...(resolved.available === undefined ? {} : { correlationAvailable: resolved.available }),
    });
    if (mapped.droppedFacts > 0) {
      // Said out loud rather than truncated silently: a caller that saw only
      // "accepted" would read a clipped batch as a complete one.
      options.logger?.warn("log records dropped: batch or per-event bound reached", {
        "logs.dropped_facts": mapped.droppedFacts,
      });
    }
    const errors: OtelHookErrorInfo[] = [];
    let accepted = 0;
    let rejected = 0;

    for (const batch of chunk(mapped.records, options.exporter.logs.maxBatchSize)) {
      if (batch.length === 0) {
        continue;
      }
      let result: ExportResult;
      try {
        result = await exportRecords(batch);
      } catch (thrown) {
        result = {
          code: ExportResultCode.FAILED,
          error: thrown instanceof Error ? thrown : new Error("export threw"),
        };
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
          detail: "collector rejected or was unreachable for a log record batch",
          details: { "export.batch_size": batch.length, "export.signal": "logs" },
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
    const result = await options.spool.drain(sendSerializedBatch, {
      ...(maxBatches === undefined ? {} : { maxBatches }),
    });
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
