import type { Attributes } from "@opentelemetry/api";

import type { Clock, Logger } from "../runtime/ports.js";
import type { StoreNamespace } from "../state/keys.js";
// Deliberately not re-exported: `spool-queue.js` is their one home, and a second
// `export *` path to the same names makes them ambiguous in the barrel below.
import {
  createSpoolQueue,
  type SpoolDrainResult,
  type SpoolEnqueueResult,
} from "./spool-queue.js";

export type SerializedSpan = {
  readonly name: string;
  readonly kind: number;
  readonly traceId: string;
  readonly spanId: string;
  /** Absent on batches spooled before cross-process parenting existed, and on root spans. */
  readonly parentSpanId?: string;
  readonly startMillis: number;
  readonly endMillis: number;
  readonly attributes: Attributes;
  readonly statusCode: number;
  readonly statusMessage?: string;
};

export type SpoolBatch = {
  readonly providerId: string;
  readonly installationId: string;
  readonly resourceAttributes: Attributes;
  readonly instrumentationScope: { readonly name: string; readonly version?: string };
  readonly spans: readonly SerializedSpan[];
  readonly enqueuedAt: number;
};

/** Upper bounds on a replayed batch. A spool file is untrusted input. */
export const MAX_SPOOLED_SPANS_PER_BATCH = 4_096;
export const MAX_SPOOLED_STRING_LENGTH = 8_192;
const MAX_SPOOLED_ATTRIBUTES_PER_SPAN = 256;
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;

const isFiniteNonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const isBoundedString = (value: unknown, maxLength = MAX_SPOOLED_STRING_LENGTH): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maxLength;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Whether one recorded span can be replayed.
 *
 * Every field is checked, not just the ones a happy path reads. `assembleReadableSpan`
 * hands its output straight to the OTLP encoder, which assumes the shapes the type
 * declares — so a `spanId` of the wrong length, a `startMillis` of `null`, or an
 * `attributes` value holding a nested object becomes an encoder error deep inside
 * the exporter rather than a rejected file here. Trace and span ids are further held
 * to their hex forms, because a malformed id is not a span a collector can place.
 */
const isReplayableSpan = (value: unknown): value is SerializedSpan => {
  if (!isPlainObject(value)) {
    return false;
  }
  if (!isBoundedString(value.name) || !isFiniteNonNegative(value.kind)) {
    return false;
  }
  if (typeof value.traceId !== "string" || !TRACE_ID_PATTERN.test(value.traceId)) {
    return false;
  }
  if (typeof value.spanId !== "string" || !SPAN_ID_PATTERN.test(value.spanId)) {
    return false;
  }
  if (
    value.parentSpanId !== undefined &&
    (typeof value.parentSpanId !== "string" || !SPAN_ID_PATTERN.test(value.parentSpanId))
  ) {
    return false;
  }
  if (!isFiniteNonNegative(value.startMillis) || !isFiniteNonNegative(value.endMillis)) {
    return false;
  }
  if (!isFiniteNonNegative(value.statusCode)) {
    return false;
  }
  if (
    value.statusMessage !== undefined &&
    typeof value.statusMessage !== "string"
  ) {
    return false;
  }
  if (!isPlainObject(value.attributes)) {
    return false;
  }
  const entries = Object.entries(value.attributes);
  if (entries.length > MAX_SPOOLED_ATTRIBUTES_PER_SPAN) {
    return false;
  }
  return entries.every(([, attribute]) => {
    if (Array.isArray(attribute)) {
      // OTLP permits homogeneous primitive arrays; anything nested is not a span
      // attribute and would fail encoding.
      return attribute.every(
        (item) =>
          (typeof item === "string" && item.length <= MAX_SPOOLED_STRING_LENGTH) ||
          (typeof item === "number" && Number.isFinite(item)) ||
          typeof item === "boolean" ||
          item === null,
      );
    }
    return (
      (typeof attribute === "string" && attribute.length <= MAX_SPOOLED_STRING_LENGTH) ||
      (typeof attribute === "number" && Number.isFinite(attribute)) ||
      typeof attribute === "boolean" ||
      attribute === undefined
    );
  });
};

export type SpoolBatchRejection =
  | "not-an-object"
  | "identity-mismatch"
  | "resource-attributes-invalid"
  | "instrumentation-scope-invalid"
  | "spans-invalid"
  | "span-field-invalid";

/**
 * Validate a whole batch read back from disk, before any of it reaches an exporter.
 *
 * The identity check alone is not enough. `spans` being anything other than an array
 * makes the sink's `spans.map(...)` throw, and a throwing send is indistinguishable
 * from an unreachable collector — so the drain would treat a permanently poisoned
 * file as a transient failure and stop at it on every pass, wedging the queue head
 * and every batch behind it forever. Validation is what turns that into a single
 * quarantined file.
 */
export const validateSpoolBatch = (
  value: unknown,
  identity: StoreNamespace,
): { readonly batch: SpoolBatch } | { readonly rejection: SpoolBatchRejection } => {
  if (!isPlainObject(value)) {
    return { rejection: "not-an-object" };
  }
  if (
    value.providerId !== identity.providerId ||
    value.installationId !== identity.installationId
  ) {
    return { rejection: "identity-mismatch" };
  }
  if (!isPlainObject(value.resourceAttributes)) {
    // Not merely absent: `replayResource` iterates it, and a string or an array
    // would silently produce a resource built from its indices.
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
  if (!Array.isArray(value.spans) || value.spans.length === 0) {
    return { rejection: "spans-invalid" };
  }
  if (value.spans.length > MAX_SPOOLED_SPANS_PER_BATCH) {
    return { rejection: "spans-invalid" };
  }
  if (!value.spans.every(isReplayableSpan)) {
    return { rejection: "span-field-invalid" };
  }
  if (!isFiniteNonNegative(value.enqueuedAt)) {
    return { rejection: "not-an-object" };
  }
  return { batch: value as unknown as SpoolBatch };
};

export type DurableSpoolOptions = StoreNamespace & {
  readonly rootDir: string;
  readonly clock: Clock;
  readonly logger?: Logger;
  /** Refuses new entries once this many are queued, rather than growing without bound. Default 500. */
  readonly maxSpoolFiles?: number;
};

/**
 * Durable filesystem queue for export batches a collector could not accept.
 *
 * A hook process is short-lived, so "retry later" means "persist and let a
 * later invocation retry" rather than an in-process backoff loop. Each
 * instance is rooted at `<rootDir>/<providerId>/<installationId>/spool`; two
 * spools for different providers or installations never share a directory,
 * so a batch from one identity cannot physically land in another's drain —
 * batches cannot mix identities by construction, not by a runtime check
 * alone (the check in {@link DurableSpool.drain} is defense in depth for a
 * hand-edited or misplaced file).
 */
export interface DurableSpool {
  enqueue(batch: SpoolBatch): Promise<SpoolEnqueueResult>;
  /** Sequential, bounded drain: stops after the first failed send, or after `maxBatches`. */
  drain(
    send: (batch: SpoolBatch) => Promise<boolean>,
    options?: { readonly maxBatches?: number },
  ): Promise<SpoolDrainResult>;
  size(): Promise<number>;
}

/** Default bound on queued trace batches, so the spool cannot grow without limit. */
export const DEFAULT_MAX_SPOOL_FILES = 500;

export const createFileDurableSpool = (options: DurableSpoolOptions): DurableSpool =>
  createSpoolQueue<SpoolBatch>({
    rootDir: options.rootDir,
    providerId: options.providerId,
    installationId: options.installationId,
    clock: options.clock,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    maxFiles: options.maxSpoolFiles ?? DEFAULT_MAX_SPOOL_FILES,
    queueName: "spool",
    validate: validateSpoolBatch,
  });
