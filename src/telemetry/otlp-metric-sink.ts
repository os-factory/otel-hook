import { ValueType } from "@opentelemetry/api";
import { ExportResultCode, millisToHrTime, type ExportResult, type InstrumentationScope } from "@opentelemetry/core";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { resourceFromAttributes, type Resource } from "@opentelemetry/resources";
import {
  AggregationTemporality,
  DataPointType,
  type MetricData,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";

import { siblingSignalEndpoint } from "../config/otlp-endpoint.js";
import type { ExporterPolicy } from "../config/schema.js";
import { createHealthTracker, type DeliveryHealthSnapshot } from "../diagnostics/health.js";
import { createErrorInfo, type OtelHookErrorInfo } from "../errors/index.js";
import type { Clock, Logger } from "../runtime/ports.js";
import type { DurableMetricSpool, MetricSpoolBatch } from "./durable-metric-spool.js";
import { isPermanentExportFailure } from "./export-failure.js";
import { replayResource, resourceFromExporterPolicy, resourceWithContext } from "./exporter-resource.js";
import { METRIC_INSTRUMENTS, withoutAccountIdentity, type MetricPoint } from "./metric-model.js";
import { DEFAULT_INSTRUMENTATION_SCOPE } from "./semconv.js";
import type { SpoolSendOutcome } from "./spool-queue.js";

/**
 * OTLP HTTP/protobuf sink for hook-derived metrics (issue #69).
 *
 * Unlike the trace and log sinks, it does not take canonical events: the points it
 * sends are already aggregated (see `metric-model.ts` and
 * `lifecycle/metric-series.ts`), because cumulative aggregation needs state the
 * telemetry layer must not own. This module only encodes, sends, spools what a
 * destination could not take, and replays the spool on flush.
 *
 * There is deliberately no `MeterProvider` and no periodic reader. A hook process
 * lives for one callback; a reader that collects on an interval would either never
 * fire or hold the process open. Points are exported once, right after the
 * callback's telemetry, inside the same bounded flush window.
 *
 * Fails open like the other sinks: every failure is a diagnostic, never a throw.
 */

export type MetricsEndpointResolution =
  | { readonly endpoint: string; readonly derived: boolean }
  | { readonly unresolvable: "no-endpoint" };

/**
 * Where metric points are posted: `metrics.endpoint` as stated, else the traces
 * endpoint with `/v1/traces` swapped for `/v1/metrics` (or `/v1/metrics` appended
 * to a base URL).
 */
export const resolveMetricsEndpoint = (exporter: ExporterPolicy): MetricsEndpointResolution => {
  const stated = exporter.metrics?.endpoint;
  if (stated !== undefined) {
    return { endpoint: stated, derived: false };
  }
  if (exporter.endpoint === undefined) {
    return { unresolvable: "no-endpoint" };
  }
  return { endpoint: siblingSignalEndpoint(exporter.endpoint, "metrics"), derived: true };
};

export type MetricsDeliverability =
  | { readonly status: "configured"; readonly endpoint: string; readonly derivedEndpoint: boolean }
  | {
      readonly status: "disabled";
      readonly reason:
        | "metrics-disabled"
        | "exporter-disabled"
        | "protocol-none"
        | "protocol-unsupported"
        | "no-endpoint";
    };

export const describeMetricsDeliverability = (exporter: ExporterPolicy): MetricsDeliverability => {
  if (exporter.metrics?.enabled !== true) {
    return { status: "disabled", reason: "metrics-disabled" };
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
  const resolved = resolveMetricsEndpoint(exporter);
  if ("unresolvable" in resolved) {
    return { status: "disabled", reason: "no-endpoint" };
  }
  return { status: "configured", endpoint: resolved.endpoint, derivedEndpoint: resolved.derived };
};

const DISABLED_DETAIL: Readonly<
  Record<Exclude<Extract<MetricsDeliverability, { status: "disabled" }>["reason"], "metrics-disabled">, string>
> = Object.freeze({
  "exporter-disabled": "otlp metric sink disabled: the exporter is disabled",
  "protocol-none": "otlp metric sink disabled: protocol is none",
  "protocol-unsupported": "otlp metric sink disabled: protocol not supported by this build",
  "no-endpoint": "otlp metric sink disabled: no metrics endpoint configured and none could be derived",
});

export type MetricExportResult = {
  /** Points delivered or spooled. */
  readonly accepted: number;
  readonly rejected: number;
  readonly errors: readonly OtelHookErrorInfo[];
};

export interface OtlpMetricTelemetrySink {
  /** Whether this sink sends anything. A disabled sink accepts nothing and reports nothing. */
  readonly enabled: boolean;
  /**
   * `context`: the session context the points' events agree on (see
   * `agreedContextAttributes`). It overrides the same keys on the Resource for
   * this export, as the trace and log sinks do; the points carry it already.
   */
  exportPoints(
    points: readonly MetricPoint[],
    context?: Readonly<Record<string, string | number | boolean>>,
  ): Promise<MetricExportResult>;
  /** Replays spooled batches; bounded, best-effort, never throws. */
  flush(): Promise<void>;
  shutdown(): Promise<void>;
  health(): DeliveryHealthSnapshot;
  drainSpool(
    maxBatches?: number,
  ): Promise<{ readonly drained: number; readonly remaining: number; readonly failed: number }>;
}

export type OtlpMetricSinkOptions = {
  readonly exporter: ExporterPolicy;
  readonly headers?: Readonly<Record<string, string>>;
  readonly providerId: string;
  readonly installationId: string;
  readonly clock: Clock;
  readonly logger?: Logger;
  readonly spool?: DurableMetricSpool;
  readonly instrumentationScope?: InstrumentationScope;
  /** Export destination this sink delivers to. */
  readonly destination?: string;
};

const createDisabledMetricSink = (destination?: string): OtlpMetricTelemetrySink => {
  const health = createHealthTracker(
    "telemetry-metric-sink",
    destination === undefined ? {} : { destination },
  );
  return {
    enabled: false,
    exportPoints: (): Promise<MetricExportResult> => Promise.resolve({ accepted: 0, rejected: 0, errors: [] }),
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

/** A sink for a destination that does not take metrics, or a build with metrics off. */
export const createDisabledOtlpMetricSink = createDisabledMetricSink;

const toMetricData = (points: readonly MetricPoint[]): MetricData[] => {
  const byInstrument = new Map<string, MetricPoint[]>();
  for (const point of points) {
    const key = `${point.instrument}|${point.temporality}`;
    const group = byInstrument.get(key) ?? [];
    group.push(point);
    byInstrument.set(key, group);
  }
  const metrics: MetricData[] = [];
  for (const group of byInstrument.values()) {
    const first = group[0];
    if (first === undefined) {
      continue;
    }
    const instrument = METRIC_INSTRUMENTS[first.instrument];
    const descriptor = {
      name: instrument.name,
      description: instrument.description,
      unit: instrument.unit,
      valueType: instrument.valueType === "int" ? ValueType.INT : ValueType.DOUBLE,
    };
    const aggregationTemporality =
      first.temporality === "cumulative" ? AggregationTemporality.CUMULATIVE : AggregationTemporality.DELTA;
    const times = (point: MetricPoint): { startTime: [number, number]; endTime: [number, number] } => ({
      startTime: millisToHrTime(point.startTimeMillis),
      endTime: millisToHrTime(point.timeMillis),
    });
    if (instrument.kind === "counter") {
      metrics.push({
        descriptor,
        aggregationTemporality,
        dataPointType: DataPointType.SUM,
        isMonotonic: true,
        dataPoints: group.map((point) => ({
          ...times(point),
          attributes: { ...point.attributes },
          value: point.value ?? 0,
        })),
      });
      continue;
    }
    metrics.push({
      descriptor,
      aggregationTemporality,
      dataPointType: DataPointType.HISTOGRAM,
      dataPoints: group.map((point) => {
        const histogram = point.histogram;
        return {
          ...times(point),
          attributes: { ...point.attributes },
          value: {
            buckets: {
              boundaries: [...(instrument.boundaries ?? [])],
              counts: [...(histogram?.bucketCounts ?? [])],
            },
            count: histogram?.count ?? 0,
            sum: histogram?.sum ?? 0,
            ...(histogram === undefined || histogram.count === 0
              ? {}
              : { min: histogram.min, max: histogram.max }),
          },
        };
      }),
    });
  }
  return metrics;
};

export const createOtlpMetricSink = (options: OtlpMetricSinkOptions): OtlpMetricTelemetrySink => {
  const destinationFields =
    options.destination === undefined ? {} : { "export.destination": options.destination };
  const deliverability = describeMetricsDeliverability(options.exporter);
  if (deliverability.status === "disabled") {
    if (deliverability.reason !== "metrics-disabled") {
      options.logger?.warn(DISABLED_DETAIL[deliverability.reason], {
        "exporter.protocol": options.exporter.protocol,
        ...destinationFields,
      });
    }
    return createDisabledMetricSink(options.destination);
  }

  const scope = options.instrumentationScope ?? DEFAULT_INSTRUMENTATION_SCOPE;
  // No account identity on any metric, even if an operator put it on the resource.
  const resource = resourceFromAttributes(
    withoutAccountIdentity(resourceFromExporterPolicy(options.exporter).attributes),
  );
  const health = createHealthTracker(
    "telemetry-metric-sink",
    options.destination === undefined ? {} : { destination: options.destination },
  );
  const exporter = new OTLPMetricExporter({
    url: deliverability.endpoint,
    headers: { ...options.headers },
    timeoutMillis: options.exporter.timeoutMillis,
  });
  let shutdownCompleted = false;

  const exportResourceMetrics = (
    points: readonly MetricPoint[],
    batchResource: Resource,
    batchScope: InstrumentationScope,
  ): Promise<ExportResult> =>
    new Promise((resolve) => {
      const payload: ResourceMetrics = {
        resource: batchResource,
        scopeMetrics: [{ scope: batchScope, metrics: toMetricData(points) }],
      };
      try {
        exporter.export(payload, (result: ExportResult) => resolve(result));
      } catch (thrown) {
        resolve({
          code: ExportResultCode.FAILED,
          error: thrown instanceof Error ? thrown : new Error("export threw"),
        });
      }
    });

  const toSpoolBatch = (points: readonly MetricPoint[], batchResource: Resource): MetricSpoolBatch => ({
    providerId: options.providerId,
    installationId: options.installationId,
    resourceAttributes: { ...batchResource.attributes },
    instrumentationScope: {
      name: scope.name,
      ...(scope.version === undefined ? {} : { version: scope.version }),
    },
    points: points.map((point) => ({ ...point })),
    enqueuedAt: options.clock.now(),
  });

  const sendSerializedBatch = async (batch: MetricSpoolBatch): Promise<SpoolSendOutcome> => {
    const batchResource = resourceFromAttributes(
      withoutAccountIdentity(replayResource(batch.resourceAttributes, options.exporter).attributes),
    );
    const result = await exportResourceMetrics(batch.points, batchResource, batch.instrumentationScope);
    if (result.code === ExportResultCode.SUCCESS) {
      return true;
    }
    return isPermanentExportFailure(result) ? "discard" : false;
  };

  const exportPoints = async (
    points: readonly MetricPoint[],
    context?: Readonly<Record<string, string | number | boolean>>,
  ): Promise<MetricExportResult> => {
    if (points.length === 0) {
      return { accepted: 0, rejected: 0, errors: [] };
    }
    const batchResource = context === undefined ? resource : resourceWithContext(resource, context);
    const result = await exportResourceMetrics(points, batchResource, scope);
    if (result.code === ExportResultCode.SUCCESS) {
      health.recordSuccess(points.length, options.clock.now());
      return { accepted: points.length, rejected: 0, errors: [] };
    }
    health.recordFailure("telemetry-export-failure", points.length, options.clock.now());
    const permanent = isPermanentExportFailure(result);
    if (options.spool !== undefined && !permanent) {
      const spooled = await options.spool.enqueue(toSpoolBatch(points, batchResource)).catch(() => ({
        spooled: false as const,
        reason: "capacity-exceeded" as const,
      }));
      if (spooled.spooled) {
        options.logger?.warn("metric batch not delivered; spooled for the next invocation", {
          "export.batch_size": points.length,
          ...destinationFields,
        });
        return { accepted: points.length, rejected: 0, errors: [] };
      }
    }
    return {
      accepted: 0,
      rejected: points.length,
      errors: [
        createErrorInfo({
          code: "telemetry-export-failure",
          phase: "export",
          detail: permanent
            ? "collector refused a metric batch with a non-retryable status"
            : "collector rejected or was unreachable for a metric batch",
          details: {
            "export.batch_size": points.length,
            "export.signal": "metrics",
            ...destinationFields,
          },
        }),
      ],
    };
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
      // Best-effort; reported through health.
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
      // Idempotent and non-throwing.
    }
  };

  return {
    enabled: true,
    exportPoints,
    flush,
    shutdown,
    health: (): DeliveryHealthSnapshot => health.snapshot(),
    drainSpool,
  };
};
