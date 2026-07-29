import type { Attributes } from "@opentelemetry/api";

import type { Clock, Logger } from "../runtime/ports.js";
import type { StoreNamespace } from "../state/keys.js";
import {
  createSpoolQueue,
  type SpoolDrainResult,
  type SpoolEnqueueResult,
  type SpoolValidation,
} from "./spool-queue.js";

/**
 * One log record, flattened to plain JSON so it survives a process exit.
 *
 * `body` is a string or absent, never a nested value: the mapping only ever
 * produces a disclosed text body, and admitting anything richer here would make a
 * spool file a route for a structure the live path would have refused.
 */
export type SerializedLogRecord = {
  readonly eventName: string;
  readonly severityNumber: number;
  readonly severityText?: string;
  readonly body?: string;
  readonly timeMillis: number;
  readonly observedTimeMillis: number;
  /** Absent only on a record that was mapped without trace correlation. */
  readonly traceId?: string;
  readonly spanId?: string;
  readonly attributes: Attributes;
};

export type LogSpoolBatch = {
  readonly providerId: string;
  readonly installationId: string;
  readonly resourceAttributes: Attributes;
  readonly instrumentationScope: { readonly name: string; readonly version?: string };
  readonly records: readonly SerializedLogRecord[];
  readonly enqueuedAt: number;
};

/** Upper bounds on a replayed batch. A spool file is untrusted input. */
export const MAX_SPOOLED_LOG_RECORDS_PER_BATCH = 4_096;
export const MAX_SPOOLED_LOG_STRING_LENGTH = 8_192;
/**
 * Longest replayed body.
 *
 * Matches the live mapping's `MAX_LOG_BODY_CHARACTERS`, because "what the mapping
 * would have put on the wire" and "what is accepted back off disk" diverging is
 * the whole vulnerability — a hand-edited spool file must not be able to export a
 * body the live path would have cut.
 */
export const MAX_SPOOLED_LOG_BODY_LENGTH = 8_192;
const MAX_SPOOLED_ATTRIBUTES_PER_RECORD = 256;
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;

const isFiniteNonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const isBoundedString = (value: unknown, maxLength = MAX_SPOOLED_LOG_STRING_LENGTH): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maxLength;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isReplayableAttributeValue = (value: unknown): boolean => {
  if (Array.isArray(value)) {
    // OTLP permits homogeneous primitive arrays; anything nested is not an
    // attribute and would fail encoding.
    return value.every(
      (item) =>
        (typeof item === "string" && item.length <= MAX_SPOOLED_LOG_STRING_LENGTH) ||
        (typeof item === "number" && Number.isFinite(item)) ||
        typeof item === "boolean" ||
        item === null,
    );
  }
  return (
    (typeof value === "string" && value.length <= MAX_SPOOLED_LOG_STRING_LENGTH) ||
    (typeof value === "number" && Number.isFinite(value)) ||
    typeof value === "boolean" ||
    value === undefined
  );
};

/**
 * Whether one recorded log record can be replayed.
 *
 * Every field is checked, not just the ones a happy path reads. The rebuilt record
 * goes straight to the OTLP encoder, which assumes the shapes the type declares —
 * so a `severityNumber` of `null`, a nested object in `attributes`, or a trace id
 * of the wrong width becomes an encoder error deep inside the exporter rather than
 * a rejected file here. Trace and span ids are held to their hex forms because a
 * malformed id is not a correlation a collector can resolve.
 */
const isReplayableLogRecord = (value: unknown): value is SerializedLogRecord => {
  if (!isPlainObject(value)) {
    return false;
  }
  if (!isBoundedString(value.eventName)) {
    return false;
  }
  if (!isFiniteNonNegative(value.severityNumber)) {
    return false;
  }
  if (value.severityText !== undefined && typeof value.severityText !== "string") {
    return false;
  }
  if (
    value.body !== undefined &&
    (typeof value.body !== "string" || value.body.length > MAX_SPOOLED_LOG_BODY_LENGTH)
  ) {
    return false;
  }
  if (!isFiniteNonNegative(value.timeMillis) || !isFiniteNonNegative(value.observedTimeMillis)) {
    return false;
  }
  // Correlation is all-or-nothing: a trace id without a span id (or the reverse)
  // is not a span reference, and half of one would export as a record pointing at
  // span `0000000000000000`.
  const hasTrace = value.traceId !== undefined;
  const hasSpan = value.spanId !== undefined;
  if (hasTrace !== hasSpan) {
    return false;
  }
  if (hasTrace && (typeof value.traceId !== "string" || !TRACE_ID_PATTERN.test(value.traceId))) {
    return false;
  }
  if (hasSpan && (typeof value.spanId !== "string" || !SPAN_ID_PATTERN.test(value.spanId))) {
    return false;
  }
  if (!isPlainObject(value.attributes)) {
    return false;
  }
  const entries = Object.entries(value.attributes);
  if (entries.length > MAX_SPOOLED_ATTRIBUTES_PER_RECORD) {
    return false;
  }
  return entries.every(([, attribute]) => isReplayableAttributeValue(attribute));
};

export type LogSpoolBatchRejection =
  | "not-an-object"
  | "identity-mismatch"
  | "resource-attributes-invalid"
  | "instrumentation-scope-invalid"
  | "records-invalid"
  | "record-field-invalid";

/**
 * Validate a whole batch read back from disk, before any of it reaches an exporter.
 *
 * The identity check alone is not enough. `records` being anything other than an
 * array makes the sender's `records.map(...)` throw, and a throwing send is
 * indistinguishable from an unreachable collector — so the drain would treat a
 * permanently poisoned file as a transient failure and stop at it on every pass,
 * wedging the queue head and every batch behind it forever. Validation is what
 * turns that into a single quarantined file.
 */
export const validateLogSpoolBatch = (
  value: unknown,
  identity: StoreNamespace,
): SpoolValidation<LogSpoolBatch> => {
  if (!isPlainObject(value)) {
    return { rejection: "not-an-object" satisfies LogSpoolBatchRejection };
  }
  if (
    value.providerId !== identity.providerId ||
    value.installationId !== identity.installationId
  ) {
    return { rejection: "identity-mismatch" satisfies LogSpoolBatchRejection };
  }
  if (!isPlainObject(value.resourceAttributes)) {
    // Not merely absent: the resource is rebuilt by iterating it, and a string or
    // an array would silently produce a resource built from its indices.
    return { rejection: "resource-attributes-invalid" satisfies LogSpoolBatchRejection };
  }
  if (
    !isPlainObject(value.instrumentationScope) ||
    !isBoundedString(value.instrumentationScope.name)
  ) {
    return { rejection: "instrumentation-scope-invalid" satisfies LogSpoolBatchRejection };
  }
  if (
    value.instrumentationScope.version !== undefined &&
    typeof value.instrumentationScope.version !== "string"
  ) {
    return { rejection: "instrumentation-scope-invalid" satisfies LogSpoolBatchRejection };
  }
  if (!Array.isArray(value.records) || value.records.length === 0) {
    return { rejection: "records-invalid" satisfies LogSpoolBatchRejection };
  }
  if (value.records.length > MAX_SPOOLED_LOG_RECORDS_PER_BATCH) {
    return { rejection: "records-invalid" satisfies LogSpoolBatchRejection };
  }
  if (!value.records.every(isReplayableLogRecord)) {
    return { rejection: "record-field-invalid" satisfies LogSpoolBatchRejection };
  }
  if (!isFiniteNonNegative(value.enqueuedAt)) {
    return { rejection: "not-an-object" satisfies LogSpoolBatchRejection };
  }
  return { batch: value as unknown as LogSpoolBatch };
};

export type DurableLogSpoolOptions = StoreNamespace & {
  readonly rootDir: string;
  readonly clock: Clock;
  readonly logger?: Logger;
  /** Refuses new entries once this many are queued. Default 500. */
  readonly maxSpoolFiles?: number;
};

/**
 * Durable filesystem queue for log batches a collector could not accept.
 *
 * Rooted at `<rootDir>/<providerId>/<installationId>/spool-logs`, deliberately a
 * different directory from the trace spool: the two hold different encodings, so a
 * single mixed queue would have each signal's sender quarantining the other's
 * perfectly deliverable batches. Separate directories also mean a logs outage
 * cannot consume the trace spool's capacity, which is what keeps the primary
 * signal unaffected by a misconfigured logs endpoint.
 */
export interface DurableLogSpool {
  enqueue(batch: LogSpoolBatch): Promise<SpoolEnqueueResult>;
  /** Sequential, bounded drain: stops after the first failed send, or after `maxBatches`. */
  drain(
    send: (batch: LogSpoolBatch) => Promise<boolean>,
    options?: { readonly maxBatches?: number },
  ): Promise<SpoolDrainResult>;
  size(): Promise<number>;
}

export const DEFAULT_MAX_LOG_SPOOL_FILES = 500;

export const createFileDurableLogSpool = (options: DurableLogSpoolOptions): DurableLogSpool =>
  createSpoolQueue<LogSpoolBatch>({
    rootDir: options.rootDir,
    providerId: options.providerId,
    installationId: options.installationId,
    clock: options.clock,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    maxFiles: options.maxSpoolFiles ?? DEFAULT_MAX_LOG_SPOOL_FILES,
    queueName: "spool-logs",
    validate: validateLogSpoolBatch,
  });
