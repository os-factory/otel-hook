import { z } from "zod";

import type { OtelHookErrorInfo } from "../errors/index.js";
import { modelDescriptorSchema, type CanonicalEvent } from "../model/events.js";
import {
  attributesSchema,
  epochMillisSchema,
  sequenceNumberSchema,
  type Attributes,
  type EpochMillis,
  type EventId,
  type InvocationId,
} from "../model/primitives.js";
import type { WorktreeKind } from "../model/target.js";
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

/**
 * Which delivery's observations are already folded into a stored total.
 *
 * The reason this rides *inside* the total's own record rather than beside it: the
 * store has no multi-key transaction, so a marker in a second key could be written
 * without the total or the other way round, and a marker that can disagree with
 * what it describes is worse than none. In one record the two move together under a
 * single write, which is what makes re-applying a redelivered callback's usage a
 * no-op instead of a double count.
 *
 * `callbackId` is an opaque digest supplied by the caller, never a host's raw
 * delivery id: a state record is somewhere a raw provider or host identifier must
 * not appear as a side effect of deduplicating on it.
 */
export const appliedDeliverySchema = z.strictObject({
  callbackId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  /** How many of that delivery's observations are folded in, counted from one. */
  applications: z.number().int().min(1).max(4_096),
});
export type AppliedDelivery = z.infer<typeof appliedDeliverySchema>;

/** Values the state store may hold. Restricted so state stays inspectable. */
export const stateValueSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("usage-cumulative"),
    usage: canonicalUsageSchema,
    /**
     * Optional: absent on every record written before this field existed, which
     * reads as "unknown provenance" and simply forgoes the idempotency check
     * rather than resetting a baseline to gain it.
     */
    appliedDelivery: appliedDeliverySchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("sequence"),
    next: sequenceNumberSchema,
  }),
  z.strictObject({
    kind: z.literal("attributes"),
    attributes: attributesSchema,
  }),
  /**
   * The model a session last reported, so a later invocation whose payload names
   * none (Claude Code's `Stop`) can still say which model it was. A model id is
   * not sensitive (`modelDescriptorSchema`), and the descriptor is the strict,
   * bounded canonical shape, never a payload fragment.
   */
  z.strictObject({
    kind: z.literal("session-model"),
    model: modelDescriptorSchema,
  }),
  /**
   * How far a {@link PayloadEnricher} has read a session's append-only source
   * (Claude Code's transcript), so the next read starts where the last ended.
   * `source` is an opaque digest of what was read, never a path.
   */
  z.strictObject({
    kind: z.literal("read-cursor"),
    source: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
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

/** A git worktree found on the local filesystem. Holds a path: never exported. */
export type LocatedWorktree = {
  /** Absolute path of the worktree's top-level directory (the one holding `.git`). */
  readonly root: string;
  /** Branch checked out there, from `HEAD`; absent when HEAD is detached. */
  readonly branch?: string;
  /** Main checkout or linked worktree; absent when the locator does not tell. */
  readonly kind?: WorktreeKind;
  /**
   * Absolute path of the repository's main worktree — `root` itself for a main
   * worktree. Absent when there is none to name: a bare repository, a main
   * checkout that is gone, or a layout the locator cannot read.
   */
  readonly mainRoot?: string;
};

/**
 * Finds the git worktree containing a local path (ADR 0008).
 *
 * The only port that reads the filesystem on behalf of event content, which is
 * why it is a port: the core decides *when* to ask and what of the answer may be
 * exported, the implementation only answers. Implementations must never throw or
 * reject — any failure is `undefined` — and must not spawn processes.
 */
export interface WorktreeLocator {
  locate(absolutePath: string): Promise<LocatedWorktree | undefined>;
}

/** Where an enricher stopped reading a session's source; see the `read-cursor` state value. */
export type ReadCursor = {
  /** Opaque digest naming the source, so a cursor never applies to another file. */
  readonly source: string;
  /** Byte offset the next read starts at. */
  readonly offset: number;
};

export type PayloadEnrichmentInput = {
  readonly payload: unknown;
  readonly sessionId: string;
  /** The cursor this enricher stored for this session last time, if any. */
  readonly cursor?: ReadCursor;
};

export type PayloadEnrichment = {
  /** The payload the adapter parses: the input, or a copy with fields attached. */
  readonly payload: unknown;
  /** A cursor to store for this session; absent leaves the stored one as it is. */
  readonly cursor?: ReadCursor;
  /** Short, non-sensitive notes for the debug log (why a read fell back, ...). */
  readonly notes?: readonly string[];
};

/**
 * Host-side step that attaches facts to a provider payload before its adapter
 * parses it — for facts the provider writes somewhere other than the hook
 * payload, such as Claude Code's transcript.
 *
 * Not an adapter capability, on purpose: adapters get no filesystem handle (ADR
 * 0003). An enricher is configured by the host, runs inside the session lock so
 * its cursor is read and written atomically, and must be bounded and never throw
 * (a throw is contained and the original payload is parsed). It never runs for a
 * redelivered callback, which is not a new observation.
 */
export interface PayloadEnricher {
  /** Stable id; namespaces the enricher's cursor in the state store. */
  readonly id: string;
  /** The provider whose payloads it enriches. Others are never passed to it. */
  readonly providerId: string;
  enrich(input: PayloadEnrichmentInput): Promise<PayloadEnrichment>;
}
