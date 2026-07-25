import { z } from "zod";

import type { OtelHookErrorInfo } from "../errors/index.js";
import type { CanonicalEvent } from "../model/events.js";
import {
  attributesSchema,
  epochMillisSchema,
  sequenceNumberSchema,
  type Attributes,
  type EpochMillis,
  type EventId,
  type InvocationId,
} from "../model/primitives.js";
import { canonicalUsageSchema } from "../model/usage.js";

/**
 * Time source.
 *
 * Injected rather than read from `Date.now()` so tests are deterministic and so
 * a host with its own time authority can supply it.
 */
export interface Clock {
  /** Wall-clock time in whole milliseconds since the Unix epoch. */
  now(): EpochMillis;
  /** Monotonic reading for durations; unrelated to wall clock. */
  monotonicMillis(): number;
}

/** Stable inputs from which an invocation id is derived. */
export type InvocationIdSeed = {
  readonly providerId: string;
  readonly sessionId: string;
  readonly sourceEventName?: string;
  readonly occurredAt: number;
  /** Provider-supplied uniqueness, e.g. a request id. */
  readonly discriminator?: string;
};

/** Stable inputs from which an event id is derived. */
export type EventIdSeed = {
  readonly invocationId: string;
  readonly sequence: number;
  readonly eventType: string;
  readonly discriminator?: string;
};

/**
 * Identifier factory.
 *
 * Seeds are structured rather than free-form so the default implementation can
 * be a pure function of its inputs: replaying the same source data produces the
 * same ids, which lets a collector dedupe instead of double-counting.
 */
export interface IdGenerator {
  newInvocationId(seed: InvocationIdSeed): InvocationId;
  newEventId(seed: EventIdSeed): EventId;
  /** Short opaque id for spans and generations, derived from its parts. */
  newOpaqueId(parts: readonly string[]): string;
}

/** Values the state store may hold. Restricted so state stays inspectable. */
export const stateValueSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("usage-cumulative"),
    usage: canonicalUsageSchema,
  }),
  z.strictObject({
    kind: z.literal("sequence"),
    next: sequenceNumberSchema,
  }),
  z.strictObject({
    kind: z.literal("attributes"),
    attributes: attributesSchema,
  }),
]);
export type StateValue = z.infer<typeof stateValueSchema>;

export const stateRecordSchema = z.strictObject({
  /** Incremented on each write; lets callers detect lost updates. */
  revision: z.number().int().min(0),
  updatedAt: epochMillisSchema,
  value: stateValueSchema,
});
export type StateRecord = z.infer<typeof stateRecordSchema>;

/**
 * Durable-ish key/value state.
 *
 * Needed because a hook process is short-lived but usage accounting spans an
 * entire session. The interface is intentionally minimal: no transactions, no
 * queries, nothing a file or a KV row cannot provide.
 */
export interface StateStore {
  read(key: string): Promise<StateRecord | undefined>;
  /** Writes unconditionally, returning the stored record. */
  write(key: string, value: StateValue): Promise<StateRecord>;
  delete(key: string): Promise<void>;
  keys(prefix: string): Promise<readonly string[]>;
}

export type TelemetryEmitResult = {
  readonly accepted: number;
  readonly rejected: number;
  readonly errors: readonly OtelHookErrorInfo[];
};

/**
 * Destination for canonical events.
 *
 * The sink receives canonical events only — never provider payloads — so an
 * exporter cannot become a second, unaudited disclosure path.
 */
export interface TelemetrySink {
  emit(events: readonly CanonicalEvent[]): Promise<TelemetryEmitResult>;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

export const logLevelSchema = z.enum(["silent", "error", "warn", "info", "debug"]);
export type LogLevel = z.infer<typeof logLevelSchema>;

export const LOG_LEVEL_RANK: Readonly<Record<LogLevel, number>> = Object.freeze({
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
});

/**
 * Diagnostic logger.
 *
 * Fields are attribute values, not arbitrary objects, so a log line cannot
 * become a way to print a provider payload. Implementations must never write to
 * stdout (ADR 0004).
 */
export interface Logger {
  error(message: string, fields?: Attributes): void;
  warn(message: string, fields?: Attributes): void;
  info(message: string, fields?: Attributes): void;
  debug(message: string, fields?: Attributes): void;
}
