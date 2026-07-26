import type { Attributes } from "@opentelemetry/api";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";

import type { Clock, Logger } from "../runtime/ports.js";
import { namespaceSegments, type StoreNamespace } from "../state/keys.js";

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

export type SpoolEnqueueResult =
  | { readonly spooled: true }
  | { readonly spooled: false; readonly reason: "capacity-exceeded" };

export type SpoolDrainResult = {
  readonly drained: number;
  readonly remaining: number;
  readonly failed: number;
  /**
   * Batches removed from the queue because they were unusable rather than
   * undeliverable.
   *
   * Distinct from `failed`, which means "the collector would not take it, try
   * later". A quarantined batch will never become deliverable, so counting it
   * separately is what stops a permanent problem from reading as transient.
   */
  readonly quarantined: number;
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

const isErrnoException = (thrown: unknown, code: string): boolean =>
  thrown instanceof Error && (thrown as NodeJS.ErrnoException).code === code;

export const createFileDurableSpool = (options: DurableSpoolOptions): DurableSpool => {
  const [providerSegment, installationSegment] = namespaceSegments(options);
  const spoolDir = path.join(options.rootDir, providerSegment, installationSegment, "spool");
  const corruptDir = path.join(options.rootDir, providerSegment, installationSegment, "spool-corrupt");
  const maxSpoolFiles = options.maxSpoolFiles ?? 500;

  let dirsReady: Promise<void> | undefined;
  const ensureDirs = async (): Promise<void> => {
    if (dirsReady !== undefined) {
      return dirsReady;
    }
    const promise = (async (): Promise<void> => {
      await mkdir(spoolDir, { recursive: true });
      await mkdir(corruptDir, { recursive: true });
    })();
    dirsReady = promise;
    try {
      await promise;
    } catch (thrown) {
      dirsReady = undefined;
      throw thrown;
    }
  };

  const listSorted = async (): Promise<readonly string[]> => {
    let entries: string[];
    try {
      entries = await readdir(spoolDir);
    } catch (thrown) {
      if (isErrnoException(thrown, "ENOENT")) {
        return [];
      }
      throw thrown;
    }
    return entries.filter((entry) => entry.endsWith(".json") && !entry.startsWith(".tmp-")).sort();
  };

  const enqueue = async (batch: SpoolBatch): Promise<SpoolEnqueueResult> => {
    await ensureDirs();
    const existing = await listSorted();
    if (existing.length >= maxSpoolFiles) {
      options.logger?.warn("durable spool at capacity; batch dropped", {
        "spool.max_files": maxSpoolFiles,
      });
      return { spooled: false, reason: "capacity-exceeded" };
    }
    const fileName = `${String(options.clock.now()).padStart(16, "0")}-${randomBytes(6).toString("hex")}.json`;
    const target = path.join(spoolDir, fileName);
    const tmp = path.join(spoolDir, `.tmp-${randomBytes(6).toString("hex")}.json`);
    await writeFile(tmp, JSON.stringify(batch), "utf8");
    await rename(tmp, target);
    return { spooled: true };
  };

  const drain = async (
    send: (batch: SpoolBatch) => Promise<boolean>,
    drainOptions?: { readonly maxBatches?: number },
  ): Promise<SpoolDrainResult> => {
    await ensureDirs();
    const cap = drainOptions?.maxBatches ?? 20;
    const files = await listSorted();
    let drained = 0;
    let failed = 0;
    let quarantined = 0;
    let index = 0;

    for (; index < files.length && index < cap; index += 1) {
      const fileName = files[index];
      if (fileName === undefined) {
        break;
      }
      const filePath = path.join(spoolDir, fileName);

      /**
       * Move a file out of the queue, or delete it if quarantine is unavailable.
       *
       * Getting it *out of the queue* is the part that matters. A file the drain
       * cannot use and cannot move would be re-read on every pass, and because the
       * head is processed first it would block every healthy batch behind it — the
       * one failure mode a retry queue must not have. So a failed quarantine falls
       * back to deleting: losing one unusable batch beats losing all the usable
       * ones queued behind it.
       */
      const quarantine = async (rejection: string): Promise<void> => {
        quarantined += 1;
        options.logger?.error("durable spool quarantined an unusable batch", {
          "spool.rejection": rejection,
          "spool.file": fileName,
        });
        try {
          await rename(filePath, path.join(corruptDir, fileName));
        } catch {
          await unlink(filePath).catch(() => undefined);
        }
      };

      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
      } catch {
        await quarantine("unparseable-json");
        continue;
      }

      const validation = validateSpoolBatch(parsed, {
        providerId: options.providerId,
        installationId: options.installationId,
      });
      if ("rejection" in validation) {
        await quarantine(validation.rejection);
        continue;
      }
      const batch = validation.batch;

      let delivered: boolean;
      try {
        delivered = await send(batch);
      } catch {
        delivered = false;
      }
      if (delivered) {
        await unlink(filePath).catch(() => undefined);
        drained += 1;
      } else {
        failed += 1;
        break;
      }
    }

    const remaining = (await listSorted()).length;
    return { drained, remaining, failed, quarantined };
  };

  return {
    enqueue,
    drain,
    size: async (): Promise<number> => {
      await ensureDirs();
      return (await listSorted()).length;
    },
  };
};
