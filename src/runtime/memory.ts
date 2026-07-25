import { createErrorInfo } from "../errors/index.js";
import type { CanonicalEvent } from "../model/events.js";
import type { Attributes } from "../model/primitives.js";
import type { Clock, Logger, LogLevel, StateRecord, StateStore, StateValue, TelemetryEmitResult, TelemetrySink } from "./ports.js";
import { stateRecordSchema } from "./ports.js";
import { LOG_LEVEL_RANK } from "./ports.js";

export type InMemoryStateStoreOptions = {
  readonly clock: Clock;
  /**
   * Fail the next N operations. Used to prove the pipeline degrades instead of
   * throwing when state is unavailable.
   */
  readonly failOperations?: number;
};

export interface InMemoryStateStore extends StateStore {
  /** Direct view of stored records, for assertions. */
  snapshot(): ReadonlyMap<string, StateRecord>;
  /** Make the next `count` operations reject. */
  failNext(count: number): void;
  clear(): void;
}

export const createInMemoryStateStore = (
  options: InMemoryStateStoreOptions,
): InMemoryStateStore => {
  const records = new Map<string, StateRecord>();
  let failures = options.failOperations ?? 0;

  const guard = (operation: string): void => {
    if (failures > 0) {
      failures -= 1;
      throw new Error(`in-memory state store failure injected during ${operation}`);
    }
  };

  return {
    read: (key: string): Promise<StateRecord | undefined> => {
      guard("read");
      return Promise.resolve(records.get(key));
    },
    write: (key: string, value: StateValue): Promise<StateRecord> => {
      guard("write");
      const previous = records.get(key);
      const record = stateRecordSchema.parse({
        revision: (previous?.revision ?? 0) + 1,
        updatedAt: options.clock.now(),
        value,
      });
      records.set(key, record);
      return Promise.resolve(record);
    },
    delete: (key: string): Promise<void> => {
      guard("delete");
      records.delete(key);
      return Promise.resolve();
    },
    keys: (prefix: string): Promise<readonly string[]> => {
      guard("keys");
      return Promise.resolve([...records.keys()].filter((key) => key.startsWith(prefix)).sort());
    },
    snapshot: (): ReadonlyMap<string, StateRecord> => new Map(records),
    failNext: (count: number): void => {
      failures += count;
    },
    clear: (): void => {
      records.clear();
    },
  };
};

export type RecordingTelemetrySinkOptions = {
  /** Reject the next N batches, reporting an export failure. */
  readonly failBatches?: number;
};

export interface RecordingTelemetrySink extends TelemetrySink {
  /** Batches in emit order. */
  batches(): readonly (readonly CanonicalEvent[])[];
  /** All events, flattened. */
  events(): readonly CanonicalEvent[];
  flushCount(): number;
  shutdownCount(): number;
  failNext(count: number): void;
  clear(): void;
}

export const createRecordingTelemetrySink = (
  options: RecordingTelemetrySinkOptions = {},
): RecordingTelemetrySink => {
  const batches: (readonly CanonicalEvent[])[] = [];
  let failures = options.failBatches ?? 0;
  let flushes = 0;
  let shutdowns = 0;

  return {
    emit: (events: readonly CanonicalEvent[]): Promise<TelemetryEmitResult> => {
      if (failures > 0) {
        failures -= 1;
        return Promise.resolve({
          accepted: 0,
          rejected: events.length,
          errors: [
            createErrorInfo({
              code: "telemetry-export-failure",
              phase: "export",
              detail: "recording sink rejected the batch",
              details: { "export.batch_size": events.length },
            }),
          ],
        });
      }
      batches.push([...events]);
      return Promise.resolve({ accepted: events.length, rejected: 0, errors: [] });
    },
    flush: (): Promise<void> => {
      flushes += 1;
      return Promise.resolve();
    },
    shutdown: (): Promise<void> => {
      shutdowns += 1;
      return Promise.resolve();
    },
    batches: (): readonly (readonly CanonicalEvent[])[] => batches.map((batch) => [...batch]),
    events: (): readonly CanonicalEvent[] => batches.flat(),
    flushCount: (): number => flushes,
    shutdownCount: (): number => shutdowns,
    failNext: (count: number): void => {
      failures += count;
    },
    clear: (): void => {
      batches.length = 0;
    },
  };
};

/** Sink that accepts and discards everything. */
export const createNullTelemetrySink = (): TelemetrySink => ({
  emit: (events: readonly CanonicalEvent[]): Promise<TelemetryEmitResult> =>
    Promise.resolve({ accepted: events.length, rejected: 0, errors: [] }),
  flush: (): Promise<void> => Promise.resolve(),
  shutdown: (): Promise<void> => Promise.resolve(),
});

export type LogRecord = {
  readonly level: Exclude<LogLevel, "silent">;
  readonly message: string;
  readonly fields?: Attributes;
};

export interface RecordingLogger extends Logger {
  records(): readonly LogRecord[];
  clear(): void;
}

export const createRecordingLogger = (level: LogLevel = "debug"): RecordingLogger => {
  const records: LogRecord[] = [];
  const threshold = LOG_LEVEL_RANK[level];
  const push = (
    entryLevel: Exclude<LogLevel, "silent">,
    message: string,
    fields?: Attributes,
  ): void => {
    if (threshold === 0 || LOG_LEVEL_RANK[entryLevel] > threshold) {
      return;
    }
    records.push({ level: entryLevel, message, ...(fields === undefined ? {} : { fields }) });
  };

  return {
    error: (message: string, fields?: Attributes): void => {
      push("error", message, fields);
    },
    warn: (message: string, fields?: Attributes): void => {
      push("warn", message, fields);
    },
    info: (message: string, fields?: Attributes): void => {
      push("info", message, fields);
    },
    debug: (message: string, fields?: Attributes): void => {
      push("debug", message, fields);
    },
    records: (): readonly LogRecord[] => [...records],
    clear: (): void => {
      records.length = 0;
    },
  };
};
