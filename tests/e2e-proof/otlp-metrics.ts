/**
 * Synthetic OTLP metrics requests for the e2e proof tests: hand-built
 * `ResourceMetrics` serialized by the OpenTelemetry SDK's own OTLP serializers,
 * so the decoder is tested against the wire format a real exporter writes, not
 * against a format the test invented.
 */
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { ValueType, type Attributes } from "@opentelemetry/api";
import { JsonMetricsSerializer, ProtobufMetricsSerializer } from "@opentelemetry/otlp-transformer";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { AggregationTemporality, DataPointType, type MetricData, type ResourceMetrics } from "@opentelemetry/sdk-metrics";

/** Seconds since the epoch used as every synthetic series' default start time. */
export const SYNTHETIC_START = 1_780_000_000;

export type MetricPointSpec = {
  readonly name: string;
  readonly kind: "sum" | "histogram" | "gauge";
  readonly unit: string;
  readonly temporality: "cumulative" | "delta";
  readonly attributes: Attributes;
  /** Sum or gauge value; for a histogram, its `sum`. */
  readonly value: number;
  /** Histogram only: number of recorded values (default 1). */
  readonly count?: number;
  /** Seconds since the epoch (default SYNTHETIC_START). */
  readonly start?: number;
  /** Seconds since the epoch. */
  readonly time: number;
};

export const SYNTHETIC_RESOURCE: Readonly<Record<string, string>> = {
  "service.name": "otel-hook",
  "session.id": "har-synthetic-session-0002",
};

const metricData = (name: string, points: readonly MetricPointSpec[]): MetricData => {
  const first = points[0];
  if (first === undefined) {
    throw new Error("a metric needs at least one point");
  }
  const descriptor = { name, description: "", unit: first.unit, valueType: ValueType.DOUBLE };
  const aggregationTemporality =
    first.temporality === "delta" ? AggregationTemporality.DELTA : AggregationTemporality.CUMULATIVE;
  const times = (point: MetricPointSpec): { startTime: [number, number]; endTime: [number, number] } => ({
    startTime: [point.start ?? SYNTHETIC_START, 0],
    endTime: [point.time, 0],
  });
  if (first.kind === "histogram") {
    return {
      descriptor,
      aggregationTemporality,
      dataPointType: DataPointType.HISTOGRAM,
      dataPoints: points.map((point) => ({
        ...times(point),
        attributes: point.attributes,
        value: {
          buckets: { boundaries: [], counts: [point.count ?? 1] },
          sum: point.value,
          count: point.count ?? 1,
          min: 0,
          max: point.value,
        },
      })),
    };
  }
  const dataPoints = points.map((point) => ({ ...times(point), attributes: point.attributes, value: point.value }));
  return first.kind === "gauge"
    ? { descriptor, aggregationTemporality, dataPointType: DataPointType.GAUGE, dataPoints }
    : { descriptor, aggregationTemporality, dataPointType: DataPointType.SUM, dataPoints, isMonotonic: true };
};

export const resourceMetrics = (
  points: readonly MetricPointSpec[],
  resource: Readonly<Record<string, string>> = SYNTHETIC_RESOURCE,
): ResourceMetrics => {
  const byName = new Map<string, MetricPointSpec[]>();
  for (const point of points) {
    byName.set(point.name, [...(byName.get(point.name) ?? []), point]);
  }
  return {
    resource: resourceFromAttributes(resource),
    scopeMetrics: [
      {
        scope: { name: "@osfactory/otel-hook", version: "0.0.0-synthetic" },
        metrics: [...byName].map(([name, list]) => metricData(name, list)),
      },
    ],
  };
};

export const protobufMetricsBody = (
  points: readonly MetricPointSpec[],
  resource?: Readonly<Record<string, string>>,
): Uint8Array => {
  const body = ProtobufMetricsSerializer.serializeRequest(resourceMetrics(points, resource));
  if (body === undefined) {
    throw new Error("protobuf metrics serializer returned nothing");
  }
  return body;
};

export const jsonMetricsBody = (
  points: readonly MetricPointSpec[],
  resource?: Readonly<Record<string, string>>,
): Uint8Array => {
  const body = JsonMetricsSerializer.serializeRequest(resourceMetrics(points, resource));
  if (body === undefined) {
    throw new Error("JSON metrics serializer returned nothing");
  }
  return body;
};

/** Write one request of a capture directory, in the receiver's file layout. */
export const writeCaptureRequest = async (
  captureDir: string,
  seq: number,
  body: Uint8Array,
  options: { readonly signal?: string; readonly contentType?: string; readonly status?: number } = {},
): Promise<void> => {
  await mkdir(captureDir, { recursive: true });
  const signal = options.signal ?? "metrics";
  const contentType = options.contentType ?? "application/x-protobuf";
  const stem = `${String(seq).padStart(4, "0")}-${signal}`;
  await writeFile(path.join(captureDir, `${stem}.body`), body);
  const status = options.status ?? 200;
  await writeFile(
    path.join(captureDir, `${stem}.json`),
    JSON.stringify({
      format: "otel-hook.otlp-capture/v1",
      seq,
      method: "POST",
      path: `/v1/${signal}`,
      signal,
      contentType,
      contentEncoding: "",
      encoding: contentType.includes("json") ? "json" : "protobuf",
      bytes: body.length,
      empty: body.length === 0,
      responseStatus: status,
      injectedFailure: status !== 200,
      headers: { "content-type": contentType },
    }),
  );
};

/** A complete, passing set of otel-hook metric points for one generation and one tool call. */
export const passingMetricPoints = (
  temporality: "cumulative" | "delta",
  time: number,
  tokens: Readonly<Record<string, number>> = { input: 200, output: 8, cache_read: 80, cache_creation: 0 },
): MetricPointSpec[] => {
  const base = { "otelhook.provider.id": "codex", "session.id": "ses-synthetic-provider-0002" };
  const generation = { ...base, "gen_ai.operation.name": "chat", "gen_ai.request.model": "synthetic-model" };
  return [
    ...Object.entries(tokens).map(([type, value]) => ({
      name: "gen_ai.client.token.usage",
      kind: "histogram" as const,
      unit: "{token}",
      temporality,
      attributes: { ...generation, "gen_ai.token.type": type },
      value,
      time,
    })),
    { name: "gen_ai.client.operation.duration", kind: "histogram", unit: "s", temporality, attributes: generation, value: 2.5, time },
    { name: "otelhook.sessions", kind: "sum", unit: "{session}", temporality, attributes: { ...base, "otelhook.session.kind": "interactive" }, value: 1, time },
    { name: "otelhook.tool.calls", kind: "sum", unit: "{call}", temporality, attributes: { ...base, "gen_ai.tool.name": "shell", "otelhook.outcome": "success" }, value: 1, time },
  ];
};
