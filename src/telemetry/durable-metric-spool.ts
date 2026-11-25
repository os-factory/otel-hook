import type { Attributes } from "@opentelemetry/api";

import type { Clock, Logger } from "../runtime/ports.js";
import type { StoreNamespace } from "../state/keys.js";
import { isMetricInstrumentName, METRIC_INSTRUMENTS, type MetricPoint } from "./metric-model.js";
import {
  createSpoolQueue,
  type SpoolDrainResult,
  type SpoolEnqueueResult,
  type SpoolOverflowPolicy,
  type SpoolSendOutcome,
  type SpoolStats,
  type SpoolValidation,
} from "./spool-queue.js";

/**
 * A batch of metric points a destination could not take, kept for the next
 * invocation.
 *
 * Points are plain JSON (`MetricPoint`), so a batch replays without the process
 * that recorded it. A cumulative point is a snapshot of a running total: replaying
 * an old one after a newer one was delivered restates an earlier value with an
 * earlier timestamp, which a receiver orders by time rather than adding.
 */
export type MetricSpoolBatch = {
  readonly providerId: string;
  readonly installationId: string;
  readonly resourceAttributes: Attributes;
  readonly instrumentationScope: { readonly name: string; readonly version?: string };
  readonly points: readonly MetricPoint[];
  readonly enqueuedAt: number;
};

export const MAX_SPOOLED_METRIC_POINTS_PER_BATCH = 4_096;
const MAX_STRING_LENGTH = 8_192;
const MAX_ATTRIBUTES_PER_POINT = 64;
const MAX_BUCKETS = 64;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const isBoundedString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_STRING_LENGTH;

const isPrimitiveAttribute = (value: unknown): boolean =>
  (typeof value === "string" && value.length <= MAX_STRING_LENGTH) ||
  (typeof value === "number" && Number.isFinite(value)) ||
  typeof value === "boolean";

/**
 * Whether one spooled point can be replayed. A spool file is untrusted input, and
 * a malformed point would otherwise fail inside the OTLP encoder, where it reads
 * as an unreachable collector and wedges the queue head.
 */
const isReplayablePoint = (value: unknown): value is MetricPoint => {
  if (!isPlainObject(value) || !isMetricInstrumentName(value.instrument)) {
    return false;
  }
  if (value.temporality !== "cumulative" && value.temporality !== "delta") {
    return false;
  }
  if (!isFiniteNonNegative(value.startTimeMillis) || !isFiniteNonNegative(value.timeMillis)) {
    return false;
  }
  if (!isPlainObject(value.attributes)) {
    return false;
  }
  const entries = Object.entries(value.attributes);
  if (entries.length > MAX_ATTRIBUTES_PER_POINT || !entries.every(([, item]) => isPrimitiveAttribute(item))) {
    return false;
  }
  const instrument = METRIC_INSTRUMENTS[value.instrument];
  if (instrument.kind === "counter") {
    return isFiniteNonNegative(value.value) && value.histogram === undefined;
  }
  const histogram = value.histogram;
  if (!isPlainObject(histogram) || value.value !== undefined) {
    return false;
  }
  const buckets = histogram.bucketCounts;
  return (
    isFiniteNonNegative(histogram.count) &&
    Number.isInteger(histogram.count) &&
    isFiniteNonNegative(histogram.sum) &&
    typeof histogram.min === "number" &&
    typeof histogram.max === "number" &&
    Array.isArray(buckets) &&
    buckets.length <= MAX_BUCKETS &&
    buckets.length === (instrument.boundaries?.length ?? 0) + 1 &&
    buckets.every((count) => isFiniteNonNegative(count) && Number.isInteger(count))
  );
};

export const validateMetricSpoolBatch = (
  value: unknown,
  identity: StoreNamespace,
): SpoolValidation<MetricSpoolBatch> => {
  if (!isPlainObject(value)) {
    return { rejection: "not-an-object" };
  }
  if (value.providerId !== identity.providerId || value.installationId !== identity.installationId) {
    return { rejection: "identity-mismatch" };
  }
  if (!isPlainObject(value.resourceAttributes)) {
    return { rejection: "resource-attributes-invalid" };
  }
  if (!isPlainObject(value.instrumentationScope) || !isBoundedString(value.instrumentationScope.name)) {
    return { rejection: "instrumentation-scope-invalid" };
  }
  if (
    value.instrumentationScope.version !== undefined &&
    typeof value.instrumentationScope.version !== "string"
  ) {
    return { rejection: "instrumentation-scope-invalid" };
  }
  if (
    !Array.isArray(value.points) ||
    value.points.length === 0 ||
    value.points.length > MAX_SPOOLED_METRIC_POINTS_PER_BATCH
  ) {
    return { rejection: "points-invalid" };
  }
  if (!value.points.every(isReplayablePoint)) {
    return { rejection: "point-field-invalid" };
  }
  if (!isFiniteNonNegative(value.enqueuedAt)) {
    return { rejection: "not-an-object" };
  }
  return { batch: value as unknown as MetricSpoolBatch };
};

export interface DurableMetricSpool {
  enqueue(batch: MetricSpoolBatch): Promise<SpoolEnqueueResult>;
  drain(
    send: (batch: MetricSpoolBatch) => Promise<SpoolSendOutcome>,
    options?: { readonly maxBatches?: number },
  ): Promise<SpoolDrainResult>;
  size(): Promise<number>;
  stats?(): Promise<SpoolStats>;
}

export type DurableMetricSpoolOptions = StoreNamespace & {
  readonly rootDir: string;
  readonly clock: Clock;
  readonly logger?: Logger;
  readonly maxSpoolFiles?: number;
  /** Queue directory below the identity namespace. Default `spool-metrics`. */
  readonly queueName?: string;
  readonly maxBytes?: number;
  readonly maxAgeMillis?: number;
  readonly overflow?: SpoolOverflowPolicy;
};

export const DEFAULT_MAX_METRIC_SPOOL_FILES = 500;

/** Durable queue for metric batches, in its own directory beside the trace and log spools. */
export const createFileDurableMetricSpool = (options: DurableMetricSpoolOptions): DurableMetricSpool =>
  createSpoolQueue<MetricSpoolBatch>({
    rootDir: options.rootDir,
    providerId: options.providerId,
    installationId: options.installationId,
    clock: options.clock,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    maxFiles: options.maxSpoolFiles ?? DEFAULT_MAX_METRIC_SPOOL_FILES,
    queueName: options.queueName ?? "spool-metrics",
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    ...(options.maxAgeMillis === undefined ? {} : { maxAgeMillis: options.maxAgeMillis }),
    ...(options.overflow === undefined ? {} : { overflow: options.overflow }),
    validate: validateMetricSpoolBatch,
  });
