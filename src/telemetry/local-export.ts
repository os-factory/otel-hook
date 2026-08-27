import { appendFile, chmod, mkdir, rename, rm, stat } from "node:fs/promises";
import * as path from "node:path";

import { isForbiddenJsonlPath } from "../config/jsonl-path.js";
import type { JsonlExportPolicy, LocalExportPolicy } from "../config/schema.js";
import { createErrorInfo, errorInfoFromThrown, type OtelHookErrorInfo } from "../errors/index.js";
import { FileLockTimeoutError, withFileLock } from "../install/file-lock.js";
import type { CanonicalEvent } from "../model/events.js";
import type { Clock, Logger, TelemetryEmitResult, TelemetrySink } from "../runtime/ports.js";

export { isForbiddenJsonlPath };

/**
 * Versioned local-export envelope.
 *
 * Independent of `CANONICAL_SCHEMA_VERSION` and `LOG_MAPPING_VERSION`: this
 * describes the *file format*, not the event model. Adding an envelope field is
 * non-breaking; reinterpreting `event` or renaming `schema` requires a bump.
 */
export const LOCAL_EXPORT_SCHEMA = "otelhook.local-export" as const;
export const LOCAL_EXPORT_SCHEMA_VERSION = 1;

export type LocalExportEnvelope = {
  readonly schema: typeof LOCAL_EXPORT_SCHEMA;
  readonly schemaVersion: typeof LOCAL_EXPORT_SCHEMA_VERSION;
  readonly event: CanonicalEvent;
};

const isErrno = (thrown: unknown, code: string): boolean =>
  thrown instanceof Error && (thrown as NodeJS.ErrnoException).code === code;

/**
 * Recursively sort object keys so the same event always serializes to the same
 * bytes, regardless of insertion order. Arrays keep their order.
 */
const sortValue = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const child = record[key];
    if (child !== undefined) {
      sorted[key] = sortValue(child);
    }
  }
  return sorted;
};

export const stableStringify = (value: unknown): string => JSON.stringify(sortValue(value));

/**
 * One JSONL record: the versioned envelope, no trailing newline.
 *
 * Deterministic given the event. The export clock is deliberately absent — a
 * wall-clock `exportedAt` would make two replays of the same callback produce
 * different files.
 */
export const serializeLocalExportLine = (event: CanonicalEvent): string =>
  stableStringify({
    schema: LOCAL_EXPORT_SCHEMA,
    schemaVersion: LOCAL_EXPORT_SCHEMA_VERSION,
    event,
  } satisfies LocalExportEnvelope);

const localExportError = (detail: string, reason: string): OtelHookErrorInfo =>
  createErrorInfo({
    code: "telemetry-export-failure",
    phase: "export",
    detail,
    details: { "local.exporter": "jsonl", "local.reason": reason },
  });

export type ConsoleSinkOptions = {
  /**
   * Destination for one JSONL line including the trailing newline.
   *
   * Defaults to `process.stderr.write`. Must never target stdout.
   */
  readonly write?: (line: string) => void;
};

export const createConsoleSink = (options: ConsoleSinkOptions = {}): TelemetrySink => {
  const write =
    options.write ??
    ((line: string): void => {
      process.stderr.write(line);
    });

  return {
    emit: (events): Promise<TelemetryEmitResult> => {
      const errors: OtelHookErrorInfo[] = [];
      let accepted = 0;
      for (const event of events) {
        try {
          write(`${serializeLocalExportLine(event)}\n`);
          accepted += 1;
        } catch (thrown) {
          errors.push(errorInfoFromThrown(thrown, { code: "telemetry-export-failure", phase: "export" }));
        }
      }
      return Promise.resolve({ accepted, rejected: events.length - accepted, errors });
    },
    flush: (): Promise<void> => Promise.resolve(),
    shutdown: (): Promise<void> => Promise.resolve(),
  };
};

export type JsonlSinkOptions = {
  readonly path: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly clock: Clock;
  readonly logger?: Logger;
};

const rotateJsonlFile = async (
  filePath: string,
  maxBytes: number,
  maxFiles: number,
): Promise<void> => {
  let size = 0;
  try {
    size = (await stat(filePath)).size;
  } catch (thrown) {
    if (!isErrno(thrown, "ENOENT")) {
      throw thrown;
    }
  }
  if (size < maxBytes) {
    return;
  }
  if (maxFiles <= 1) {
    await rm(filePath, { force: true });
    return;
  }
  await rm(`${filePath}.${String(maxFiles - 1)}`, { force: true });
  for (let index = maxFiles - 2; index >= 1; index -= 1) {
    const from = `${filePath}.${String(index)}`;
    const to = `${filePath}.${String(index + 1)}`;
    try {
      await rename(from, to);
    } catch (thrown) {
      if (!isErrno(thrown, "ENOENT")) {
        throw thrown;
      }
    }
  }
  await rename(filePath, `${filePath}.1`);
};

export const createJsonlSink = (options: JsonlSinkOptions): TelemetrySink => {
  if (isForbiddenJsonlPath(options.path)) {
    return {
      emit: (events): Promise<TelemetryEmitResult> =>
        Promise.resolve({
          accepted: 0,
          rejected: events.length,
          errors: [localExportError("jsonl path is not a regular file", "forbidden-path")],
        }),
      flush: (): Promise<void> => Promise.resolve(),
      shutdown: (): Promise<void> => Promise.resolve(),
    };
  }

  const filePath = path.resolve(options.path);

  const appendLine = async (line: string): Promise<void> => {
    await withFileLock(filePath, { clock: options.clock }, async () => {
      await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      await rotateJsonlFile(filePath, options.maxBytes, options.maxFiles);
      await appendFile(filePath, `${line}\n`, { encoding: "utf8", mode: 0o600, flag: "a" });
      try {
        await chmod(filePath, 0o600);
      } catch {
        // Some platforms ignore mode; the create-time mode is the real guarantee.
      }
    });
  };

  return {
    emit: async (events): Promise<TelemetryEmitResult> => {
      const errors: OtelHookErrorInfo[] = [];
      let accepted = 0;
      for (const event of events) {
        const line = serializeLocalExportLine(event);
        if (Buffer.byteLength(line, "utf8") >= options.maxBytes) {
          errors.push(
            createErrorInfo({
              code: "limit-exceeded",
              phase: "export",
              detail: "jsonl record exceeds the configured file size bound",
              details: { "local.exporter": "jsonl", "local.reason": "line-too-large" },
            }),
          );
          continue;
        }
        try {
          await appendLine(line);
          accepted += 1;
        } catch (thrown) {
          if (thrown instanceof FileLockTimeoutError) {
            errors.push(localExportError("jsonl sink timed out waiting for the file lock", "lock-timeout"));
            continue;
          }
          errors.push(errorInfoFromThrown(thrown, { code: "telemetry-export-failure", phase: "export" }));
        }
      }
      return { accepted, rejected: events.length - accepted, errors };
    },
    flush: (): Promise<void> => Promise.resolve(),
    shutdown: (): Promise<void> => Promise.resolve(),
  };
};

/**
 * Fan a batch to extra sinks *after* the primary sink, without letting those
 * extras change durability.
 *
 * Local exporters are debugging tools. A JSONL disk-full must not turn a
 * successful OTLP export into `partial` and suppress the delivery claim.
 * Extra errors are still reported so an operator can see the disk failed.
 */
export const attachLocalExporters = (
  primary: TelemetrySink,
  extras: readonly TelemetrySink[],
): TelemetrySink => {
  if (extras.length === 0) {
    return primary;
  }
  return {
    emit: async (events): Promise<TelemetryEmitResult> => {
      const primaryResult = await primary.emit(events);
      const extraErrors: OtelHookErrorInfo[] = [];
      for (const extra of extras) {
        try {
          const result = await extra.emit(events);
          extraErrors.push(...result.errors);
        } catch (thrown) {
          extraErrors.push(errorInfoFromThrown(thrown, { code: "telemetry-export-failure", phase: "export" }));
        }
      }
      return extraErrors.length === 0
        ? primaryResult
        : { ...primaryResult, errors: [...primaryResult.errors, ...extraErrors] };
    },
    flush: async (): Promise<void> => {
      await primary.flush();
      await Promise.all(extras.map((extra) => extra.flush().catch(() => undefined)));
    },
    shutdown: async (): Promise<void> => {
      await primary.shutdown();
      await Promise.all(extras.map((extra) => extra.shutdown().catch(() => undefined)));
    },
  };
};

export type LocalExportSinksOptions = {
  readonly policy: LocalExportPolicy;
  readonly clock: Clock;
  readonly logger?: Logger;
  readonly consoleWrite?: (line: string) => void;
};

/**
 * Construct the configured local sinks. Missing or forbidden JSONL paths become
 * a warning and a no-op rather than a thrown error.
 */
export const createLocalExportSinks = (options: LocalExportSinksOptions): readonly TelemetrySink[] => {
  const sinks: TelemetrySink[] = [];
  if (options.policy.console.enabled) {
    sinks.push(createConsoleSink({ ...(options.consoleWrite === undefined ? {} : { write: options.consoleWrite }) }));
  }
  if (options.policy.jsonl.enabled) {
    const jsonlPath = options.policy.jsonl.path;
    if (jsonlPath === undefined || isForbiddenJsonlPath(jsonlPath)) {
      options.logger?.warn("jsonl sink disabled: no usable path configured", {});
    } else {
      sinks.push(
        createJsonlSink({
          path: jsonlPath,
          maxBytes: options.policy.jsonl.maxBytes,
          maxFiles: options.policy.jsonl.maxFiles,
          clock: options.clock,
          ...(options.logger === undefined ? {} : { logger: options.logger }),
        }),
      );
    }
  }
  return sinks;
};

export type JsonlDeliverability =
  | { readonly status: "disabled" }
  | { readonly status: "configured" }
  | { readonly status: "unusable"; readonly reason: "no-path" | "forbidden-path" };

/**
 * Whether the JSONL sink could actually write, reported the same way logs are:
 * off is a passing diagnosis, asked-for-and-unusable is not.
 */
export const describeJsonlDeliverability = (policy: JsonlExportPolicy): JsonlDeliverability => {
  if (!policy.enabled) {
    return { status: "disabled" };
  }
  if (policy.path === undefined) {
    return { status: "unusable", reason: "no-path" };
  }
  if (isForbiddenJsonlPath(policy.path)) {
    return { status: "unusable", reason: "forbidden-path" };
  }
  return { status: "configured" };
};
