import type { Attributes as SpanAttributes } from "@opentelemetry/api";

import type { CanonicalEvent } from "../model/events.js";
import {
  MAX_ATTRIBUTE_STRING_LENGTH,
  MAX_IDENTIFIER_LENGTH,
  type Attributes,
} from "../model/primitives.js";
import type { Clock, StateStore, StateValue } from "../runtime/ports.js";
import { withOptionalSessionLock } from "../state/store.js";
import {
  MAX_RECOVERED_START_ATTRIBUTES,
  parentScopeRefOf,
  spanScopeRefOf,
  startOnlySpanAttributes,
  type SpanCorrelation,
  type SpanFamily,
  type SpanOrphanClassification,
  type SpanScopeRef,
} from "../telemetry/semconv.js";
import { spanKey, spanScanPrefix } from "./keys.js";

/** Correlation scopes that pair a `*.start` event with a later `*.end` event. */
export type LifecycleScope = SpanFamily;

/**
 * Shape version of a persisted span record.
 *
 * A record written under a different version is discarded on read rather than
 * interpreted: guessing at an older layout is exactly the kind of silent
 * mis-attribution this library refuses to do. See `docs/state-retention.md`.
 */
export const SPAN_RECORD_VERSION = 2;

/** Facts about a span recovered from, or written to, persisted state. */
export type SpanCorrelationFacts = {
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly parent?: SpanScopeRef;
  readonly attributes?: SpanAttributes;
};

export type SpanStartInput = {
  readonly sessionId: string;
  /** Attribution boundary: a scope recorded by one provider never pairs with another's. */
  readonly providerId: string;
  readonly scope: LifecycleScope;
  readonly scopeKey: string;
  /** The canonical event id of the start event; used to detect redelivery. */
  readonly eventId: string;
  readonly occurredAt: number;
  /** Where this span hangs, so an end-only process reparents it identically. */
  readonly parent?: SpanScopeRef;
  /** Attributes only the start edge knows; carried forward to the end-side span. */
  readonly attributes?: SpanAttributes;
};

export type SpanEndInput = {
  readonly sessionId: string;
  readonly providerId: string;
  readonly scope: LifecycleScope;
  readonly scopeKey: string;
  readonly eventId: string;
  readonly occurredAt: number;
};

export type SpanStartResult =
  | { readonly status: "recorded"; readonly facts: SpanCorrelationFacts }
  /** The same start (by event id) was already recorded; state is unchanged. */
  | { readonly status: "duplicate"; readonly facts: SpanCorrelationFacts }
  /**
   * The record was completed, but an OTLP record for this scope has already been
   * published under its span id — so this edge must not export one.
   */
  | { readonly status: "published"; readonly facts: SpanCorrelationFacts }
  /** A different provider owns this scope key in this session; nothing was written. */
  | { readonly status: "conflict"; readonly reason: "provider-mismatch" };

/** Why an end could not be paired with a recorded start. */
export type SpanEndOrphanReason =
  | "no-start-recorded"
  | "start-expired"
  | "already-closed"
  | "provider-mismatch"
  | "state-incompatible"
  | "state-corrupt";

export type SpanEndResult =
  | {
      readonly status: "matched";
      readonly startedAt: number;
      readonly durationMillis: number;
      readonly facts: SpanCorrelationFacts;
    }
  /** This exact end (by event id) was already applied; the same facts are replayed. */
  | { readonly status: "duplicate"; readonly facts: SpanCorrelationFacts }
  | {
      readonly status: "orphaned";
      readonly reason: SpanEndOrphanReason;
      readonly facts: SpanCorrelationFacts;
    };

export type SpanCleanupResult = {
  readonly removed: number;
  readonly scanned: number;
  /**
   * Records dropped that held a start and never received an end.
   *
   * These are the spans that will never be exported at all: the end edge is what
   * emits a lifecycle span, so a scope whose end never arrives — a session the
   * host killed, a tool call that outlived the retention window — produces no
   * OTLP record. That is the standard OpenTelemetry outcome for a span that never
   * ends, and it is deliberately not papered over with a synthetic end time,
   * because a fabricated duration is a wrong measurement rather than a missing
   * one. Counting them keeps the cost visible: a non-zero number here means real
   * activity went unreported, which is a signal about the host or the retention
   * window rather than noise. See `docs/state-retention.md`.
   */
  readonly expiredOpen: number;
};

/**
 * Cross-invocation start/end correlation for session, generation, tool, and
 * subagent scopes.
 *
 * A coding-agent hook fires once per lifecycle edge, usually as a separate
 * short-lived process for the start and for the end. This records an open span
 * in the shared state store so the end side can report a real start time,
 * duration, parent, and start-only attributes even though its process has no
 * memory of the start — and so a redelivered start or end (an at-least-once
 * host retry) re-exports an identical span instead of being double-counted.
 *
 * ## What it refuses to do
 *
 * - **Pair across sessions.** The state key is session-scoped, so two sessions
 *   cannot see each other's open spans.
 * - **Pair across providers.** The key is provider-scoped *and* the record
 *   carries the provider that wrote it, so a mismatch is reported rather than
 *   guessed at — the same defense in depth the durable spool uses.
 * - **Trust a stale start.** A start older than `maxStartAgeMillis` when its end
 *   arrives is dropped and classified `start-expired`, rather than reporting a
 *   duration that really measures a machine suspend or a reused id.
 * - **Interpret a record it does not understand.** A corrupt or wrong-version
 *   record is deleted and classified, never partially read.
 */
export interface SpanCorrelator {
  recordStart(input: SpanStartInput): Promise<SpanStartResult>;
  recordEnd(input: SpanEndInput): Promise<SpanEndResult>;
  /**
   * Records every lifecycle edge in a batch and reports what the exported spans
   * should say. Never rejects: a state failure degrades one scope to
   * `state-unavailable` rather than losing the batch (fail-open telemetry).
   */
  correlateBatch(events: readonly CanonicalEvent[]): Promise<readonly SpanCorrelation[]>;
  /** Bounded sweep: drops spans untouched for longer than `maxAgeMillis`. */
  cleanup(
    maxAgeMillis: number,
    options?: { readonly maxEntries?: number; readonly sessionId?: string },
  ): Promise<SpanCleanupResult>;
}

export type SpanCorrelatorDependencies = {
  readonly stateStore: StateStore;
  readonly clock: Clock;
  /**
   * A recorded start older than this when its end arrives is not trusted.
   * Default 24 hours, matching the janitor's retention window.
   */
  readonly maxStartAgeMillis?: number;
};

const DEFAULT_MAX_START_AGE_MILLIS = 24 * 60 * 60 * 1000;
const ATTRIBUTE_PREFIX = "a:";

type SpanRecord = {
  readonly providerId: string;
  readonly startEventId?: string;
  readonly startedAt?: number;
  readonly endEventId?: string;
  readonly endedAt?: number;
  readonly parent?: SpanScopeRef;
  readonly attributes?: SpanAttributes;
  /**
   * True once an OTLP record has been produced for this scope under its derived
   * span id.
   *
   * Needed for the ordering nobody controls: the end edge can be mapped before
   * the start edge, and then the end has already exported an orphan carrying the
   * scope's canonical span id. Without this flag the late start would look like
   * the benign "end raced ahead" case and export a *second* record with that same
   * id — the duplicate the whole defer strategy exists to avoid. So the flag turns
   * "was this scope already published?" into a fact on disk rather than an
   * assumption about arrival order.
   */
  readonly exported?: boolean;
};

type DecodedRecord =
  | { readonly kind: "absent" }
  | { readonly kind: "incompatible" }
  | { readonly kind: "corrupt" }
  | { readonly kind: "present"; readonly record: SpanRecord };

const SPAN_FAMILIES: readonly SpanFamily[] = ["session", "generation", "tool", "subagent"];

const isSpanFamily = (value: unknown): value is SpanFamily =>
  typeof value === "string" && (SPAN_FAMILIES as readonly string[]).includes(value);

const optionalNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/**
 * Persisted attributes are flattened under a prefix rather than nested: the
 * state schema admits only flat primitives, which is what keeps a provider
 * payload from ever being smuggled through the state store.
 */
const encodeAttributes = (attributes: SpanAttributes | undefined): Attributes => {
  const encoded: Record<string, string | number | boolean> = {};
  let count = 0;
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (count >= MAX_RECOVERED_START_ATTRIBUTES) {
      break;
    }
    const encodedKey = `${ATTRIBUTE_PREFIX}${key}`;
    if (encodedKey.length > MAX_IDENTIFIER_LENGTH) {
      continue;
    }
    if (typeof value === "string") {
      encoded[encodedKey] = value.slice(0, MAX_ATTRIBUTE_STRING_LENGTH);
    } else if (typeof value === "number" && Number.isFinite(value)) {
      encoded[encodedKey] = value;
    } else if (typeof value === "boolean") {
      encoded[encodedKey] = value;
    } else {
      continue;
    }
    count += 1;
  }
  return encoded;
};

const decodeAttributes = (attributes: Attributes): SpanAttributes | undefined => {
  const decoded: Record<string, string | number | boolean> = {};
  let count = 0;
  for (const [key, value] of Object.entries(attributes)) {
    if (!key.startsWith(ATTRIBUTE_PREFIX) || count >= MAX_RECOVERED_START_ATTRIBUTES) {
      continue;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      decoded[key.slice(ATTRIBUTE_PREFIX.length)] = value;
      count += 1;
    }
  }
  return count === 0 ? undefined : decoded;
};

const encodeRecord = (record: SpanRecord): StateValue => ({
  kind: "attributes",
  attributes: {
    v: SPAN_RECORD_VERSION,
    providerId: record.providerId,
    ...(record.startEventId === undefined ? {} : { startEventId: record.startEventId }),
    ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
    ...(record.endEventId === undefined ? {} : { endEventId: record.endEventId }),
    ...(record.endedAt === undefined ? {} : { endedAt: record.endedAt }),
    ...(record.exported === true ? { exported: true } : {}),
    ...(record.parent === undefined
      ? {}
      : { parentFamily: record.parent.family, parentScopeKey: record.parent.scopeKey }),
    ...encodeAttributes(record.attributes),
  },
});

const decodeRecord = (attributes: Attributes): DecodedRecord => {
  if (attributes["v"] !== SPAN_RECORD_VERSION) {
    return { kind: "incompatible" };
  }
  const providerId = optionalString(attributes["providerId"]);
  if (providerId === undefined) {
    return { kind: "corrupt" };
  }
  // A half-written edge (a timestamp with no event id, or the reverse) is not
  // an edge we can reason about; the record is refused rather than completed
  // with an invented half.
  const startedAt = optionalNumber(attributes["startedAt"]);
  const startEventId = optionalString(attributes["startEventId"]);
  if ((startedAt === undefined) !== (startEventId === undefined)) {
    return { kind: "corrupt" };
  }
  const endedAt = optionalNumber(attributes["endedAt"]);
  const endEventId = optionalString(attributes["endEventId"]);
  if ((endedAt === undefined) !== (endEventId === undefined)) {
    return { kind: "corrupt" };
  }
  const exported = attributes["exported"] === true;
  const parentFamily = attributes["parentFamily"];
  const parentScopeKey = optionalString(attributes["parentScopeKey"]);
  const parent =
    isSpanFamily(parentFamily) && parentScopeKey !== undefined
      ? { family: parentFamily, scopeKey: parentScopeKey }
      : undefined;
  const decodedAttributes = decodeAttributes(attributes);
  return {
    kind: "present",
    record: {
      providerId,
      ...(startEventId === undefined ? {} : { startEventId }),
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(endEventId === undefined ? {} : { endEventId }),
      ...(endedAt === undefined ? {} : { endedAt }),
      ...(parent === undefined ? {} : { parent }),
      ...(exported ? { exported: true } : {}),
      ...(decodedAttributes === undefined ? {} : { attributes: decodedAttributes }),
    },
  };
};

const factsOf = (record: SpanRecord): SpanCorrelationFacts => ({
  ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
  ...(record.endedAt === undefined ? {} : { endedAt: record.endedAt }),
  ...(record.parent === undefined ? {} : { parent: record.parent }),
  ...(record.attributes === undefined ? {} : { attributes: record.attributes }),
});

/**
 * Persisted facts speak in event time (`startedAt`); a span speaks in the
 * milliseconds it is stamped with. Translated in one place so the two
 * vocabularies cannot silently drift apart.
 */
const correlationTimesOf = (
  facts: SpanCorrelationFacts,
  options: { readonly withStart: boolean } = { withStart: true },
): Pick<SpanCorrelation, "startMillis" | "endMillis" | "parent" | "attributes"> => ({
  ...(facts.startedAt === undefined || !options.withStart ? {} : { startMillis: facts.startedAt }),
  ...(facts.endedAt === undefined ? {} : { endMillis: facts.endedAt }),
  ...(facts.parent === undefined ? {} : { parent: facts.parent }),
  ...(facts.attributes === undefined ? {} : { attributes: facts.attributes }),
});

const orphanClassificationOf = (reason: SpanEndOrphanReason): SpanOrphanClassification => {
  switch (reason) {
    case "no-start-recorded":
      return "missing-start";
    case "start-expired":
      return "expired-start";
    case "already-closed":
      return "already-closed";
    case "provider-mismatch":
      return "provider-mismatch";
    case "state-incompatible":
      return "state-incompatible";
    case "state-corrupt":
      return "state-corrupt";
  }
};

type BatchGroup = {
  readonly providerId: string;
  readonly sessionId: string;
  readonly ref: SpanScopeRef;
  start?: CanonicalEvent;
  end?: CanonicalEvent;
};

export const createSpanCorrelator = (deps: SpanCorrelatorDependencies): SpanCorrelator => {
  const { stateStore, clock } = deps;
  const maxStartAgeMillis = deps.maxStartAgeMillis ?? DEFAULT_MAX_START_AGE_MILLIS;

  const keyFor = (input: {
    readonly sessionId: string;
    readonly providerId: string;
    readonly scope: LifecycleScope;
    readonly scopeKey: string;
  }): string => spanKey(input.sessionId, input.providerId, input.scope, input.scopeKey);

  /**
   * Reads and validates one record, deleting anything it refuses to interpret.
   * Self-healing on purpose: a single unreadable record must not make the same
   * scope unreadable forever.
   */
  const readRecord = async (key: string): Promise<DecodedRecord> => {
    const existing = await stateStore.read(key);
    if (existing === undefined) {
      return { kind: "absent" };
    }
    if (existing.value.kind !== "attributes") {
      await stateStore.delete(key);
      return { kind: "corrupt" };
    }
    const decoded = decodeRecord(existing.value.attributes);
    if (decoded.kind === "corrupt" || decoded.kind === "incompatible") {
      await stateStore.delete(key);
    }
    return decoded;
  };

  const recordStart = (input: SpanStartInput): Promise<SpanStartResult> =>
    withOptionalSessionLock(stateStore, input.sessionId, async (): Promise<SpanStartResult> => {
      const key = keyFor(input);
      const decoded = await readRecord(key);

      if (decoded.kind === "present") {
        const existing = decoded.record;
        if (existing.providerId !== input.providerId) {
          return { status: "conflict", reason: "provider-mismatch" };
        }
        if (existing.startEventId === input.eventId) {
          return { status: "duplicate", facts: factsOf(existing) };
        }
        if (existing.startEventId === undefined && existing.endEventId !== undefined) {
          // The end raced ahead of the start (two hook processes, no ordering
          // guarantee between them). Complete the record rather than treating
          // the late start as the beginning of a second span.
          //
          // If that end was already exported, the scope's canonical span id is
          // already on the wire and this start must stay silent: re-exporting a
          // now-complete span under the same id would be a duplicate, not a
          // correction, because OTLP has no update. The enrichment is lost and the
          // published record remains the orphan the end could honestly produce.
          const completed: SpanRecord = {
            ...existing,
            startEventId: input.eventId,
            startedAt: input.occurredAt,
            ...(input.parent === undefined ? {} : { parent: input.parent }),
            ...(input.attributes === undefined ? {} : { attributes: input.attributes }),
          };
          await stateStore.write(key, encodeRecord(completed));
          return existing.exported === true
            ? { status: "published", facts: factsOf(completed) }
            : { status: "recorded", facts: factsOf(completed) };
        }
      }

      // Either nothing was recorded, or a *different* start claims this scope
      // key: the previous span is superseded rather than merged into.
      const fresh: SpanRecord = {
        providerId: input.providerId,
        startEventId: input.eventId,
        startedAt: input.occurredAt,
        ...(input.parent === undefined ? {} : { parent: input.parent }),
        ...(input.attributes === undefined ? {} : { attributes: input.attributes }),
      };
      await stateStore.write(key, encodeRecord(fresh));
      return { status: "recorded", facts: factsOf(fresh) };
    });

  const recordEnd = (input: SpanEndInput): Promise<SpanEndResult> =>
    withOptionalSessionLock(stateStore, input.sessionId, async (): Promise<SpanEndResult> => {
      const key = keyFor(input);
      const decoded = await readRecord(key);

      if (decoded.kind === "incompatible" || decoded.kind === "corrupt") {
        const reason = decoded.kind === "incompatible" ? "state-incompatible" : "state-corrupt";
        return { status: "orphaned", reason, facts: { endedAt: input.occurredAt } };
      }
      if (decoded.kind === "absent") {
        // Remember the end anyway: a start that arrives late still deserves to
        // be paired rather than exported as a second orphan.
        const endOnly: SpanRecord = {
          providerId: input.providerId,
          endEventId: input.eventId,
          endedAt: input.occurredAt,
          // This end is about to be exported as an orphan under the scope's
          // canonical span id, so a start arriving later must not reuse it.
          exported: true,
        };
        await stateStore.write(key, encodeRecord(endOnly));
        return { status: "orphaned", reason: "no-start-recorded", facts: factsOf(endOnly) };
      }

      const existing = decoded.record;
      if (existing.providerId !== input.providerId) {
        return {
          status: "orphaned",
          reason: "provider-mismatch",
          facts: { endedAt: input.occurredAt },
        };
      }
      if (existing.endEventId === input.eventId) {
        // Idempotent replay: answer with the facts already on disk so the
        // re-exported span is byte-identical to the first one.
        return { status: "duplicate", facts: factsOf(existing) };
      }
      if (existing.endEventId !== undefined) {
        return {
          status: "orphaned",
          reason: "already-closed",
          facts: { endedAt: input.occurredAt },
        };
      }
      if (existing.startedAt === undefined) {
        const replaced: SpanRecord = {
          ...existing,
          endEventId: input.eventId,
          endedAt: input.occurredAt,
          exported: true,
        };
        await stateStore.write(key, encodeRecord(replaced));
        return { status: "orphaned", reason: "no-start-recorded", facts: factsOf(replaced) };
      }
      if (input.occurredAt - existing.startedAt > maxStartAgeMillis) {
        await stateStore.delete(key);
        return { status: "orphaned", reason: "start-expired", facts: { endedAt: input.occurredAt } };
      }

      const closed: SpanRecord = {
        ...existing,
        endEventId: input.eventId,
        endedAt: input.occurredAt,
        exported: true,
      };
      await stateStore.write(key, encodeRecord(closed));
      return {
        status: "matched",
        startedAt: existing.startedAt,
        durationMillis: Math.max(0, input.occurredAt - existing.startedAt),
        facts: factsOf(closed),
      };
    });

  const correlateGroup = async (group: BatchGroup): Promise<SpanCorrelation> => {
    const base = {
      providerId: group.providerId,
      sessionId: group.sessionId,
      ref: group.ref,
    } as const;
    const unpaired = (
      orphan: SpanOrphanClassification,
      facts: SpanCorrelationFacts,
    ): SpanCorrelation => ({
      ...base,
      pairing: "unpaired",
      orphan,
      // An unpaired span has no trustworthy start, so a start time is the one
      // fact it must not carry; everything else recovered is still true.
      ...correlationTimesOf(facts, { withStart: false }),
    });

    let startFacts: SpanCorrelationFacts | undefined;
    if (group.start !== undefined) {
      const parent = parentScopeRefOf(group.start);
      const result = await recordStart({
        sessionId: group.sessionId,
        providerId: group.providerId,
        scope: group.ref.family,
        scopeKey: group.ref.scopeKey,
        eventId: group.start.eventId,
        occurredAt: group.start.occurredAt,
        ...(parent === undefined ? {} : { parent }),
        attributes: startOnlySpanAttributes(group.start),
      });
      if (result.status === "conflict") {
        return unpaired("provider-mismatch", {});
      }
      if (result.status === "published" && group.end === undefined) {
        // The end already exported this scope's span. Completing the record was
        // still worth doing (a redelivered end replays identical facts), but
        // emitting here would duplicate a span id already on the wire.
        return { ...unpaired("already-closed", result.facts), disposition: "defer" };
      }
      startFacts = result.facts;
    }

    if (group.end === undefined) {
      const facts = startFacts ?? {};
      // A start whose end already landed (the racing-process case) closes a
      // complete span, even though only the start is in this batch.
      if (facts.endedAt !== undefined) {
        return {
          ...base,
          pairing: "cross-process",
          orphan: "none",
          disposition: "emit",
          ...correlationTimesOf(facts),
        };
      }
      // The end has not arrived. The start is durable now, so the end edge will
      // export one complete span under this scope's derived id; exporting a
      // zero-duration record here as well would put two records with that same id
      // on the wire, and OTLP cannot revise a span.
      return { ...unpaired("missing-end", facts), disposition: "defer" };
    }

    const result = await recordEnd({
      sessionId: group.sessionId,
      providerId: group.providerId,
      scope: group.ref.family,
      scopeKey: group.ref.scopeKey,
      eventId: group.end.eventId,
      occurredAt: group.end.occurredAt,
    });

    if (result.status === "orphaned") {
      const orphan = orphanClassificationOf(result.reason);
      // `already-closed` means a *second, distinct* end for a scope whose first
      // end has already been exported under this scope's derived span id. Both
      // ends are real observations, so neither is dropped — but the second must
      // not reuse that id. Keying the discriminator on the end event id keeps a
      // redelivery of this same second end idempotent, since it recomputes the
      // same id rather than inventing a third.
      return orphan === "already-closed"
        ? {
            ...unpaired(orphan, result.facts),
            disposition: "emit",
            spanIdDiscriminator: group.end.eventId,
          }
        : { ...unpaired(orphan, result.facts), disposition: "emit" };
    }
    if (result.status === "duplicate" && result.facts.startedAt === undefined) {
      // A replayed end that never had a start is still an orphan.
      return { ...unpaired("missing-start", result.facts), disposition: "emit" };
    }
    return {
      ...base,
      pairing: group.start === undefined ? "cross-process" : "in-batch",
      orphan: "none",
      disposition: "emit",
      ...correlationTimesOf(result.facts),
    };
  };

  const correlateBatch = async (
    events: readonly CanonicalEvent[],
  ): Promise<readonly SpanCorrelation[]> => {
    const groups = new Map<string, BatchGroup>();
    for (const event of events) {
      const ref = spanScopeRefOf(event);
      if (ref === undefined) {
        continue;
      }
      const providerId = event.provenance.providerId;
      const groupKey = [providerId, event.sessionId, ref.family, ref.scopeKey].join("\u0000");
      const group: BatchGroup = groups.get(groupKey) ?? {
        providerId,
        sessionId: event.sessionId,
        ref,
      };
      if (event.type.endsWith(".start")) {
        group.start = event;
      } else {
        group.end = event;
      }
      groups.set(groupKey, group);
    }

    const correlations: SpanCorrelation[] = [];
    for (const group of groups.values()) {
      try {
        correlations.push(await correlateGroup(group));
      } catch {
        // Fail open: an unreachable, locked, or unwritable state store costs a
        // span its pairing, never the whole export.
        //
        // A start whose record could not be written is the case that needs care.
        // It is *not* deferrable — deferring means "the state store is holding
        // this, the end edge will publish it", and here the state store is exactly
        // what failed. So it must be exported, and it must not use the scope's
        // canonical span id: nothing recorded this start, so a later end will
        // publish that id itself as an orphan, and reusing it would put two
        // records with one identity on the wire. Discriminating by the start's own
        // event id makes this record honest and collision-free.
        const unrecordedStart = group.start !== undefined && group.end === undefined;
        correlations.push({
          providerId: group.providerId,
          sessionId: group.sessionId,
          ref: group.ref,
          pairing: "unpaired",
          orphan: "state-unavailable",
          disposition: "emit",
          ...(unrecordedStart && group.start !== undefined
            ? { spanIdDiscriminator: group.start.eventId }
            : {}),
        });
      }
    }
    return correlations;
  };

  const cleanup = async (
    maxAgeMillis: number,
    options?: { readonly maxEntries?: number; readonly sessionId?: string },
  ): Promise<SpanCleanupResult> => {
    const keys = await stateStore.keys(spanScanPrefix(options?.sessionId));
    const cap = options?.maxEntries ?? 1_000;
    const now = clock.now();
    let removed = 0;
    let scanned = 0;
    let expiredOpen = 0;
    for (const key of keys) {
      if (scanned >= cap) {
        break;
      }
      scanned += 1;
      const record = await stateStore.read(key);
      if (record !== undefined && now - record.updatedAt > maxAgeMillis) {
        // Classified before deletion: a record with a start and no end is a span
        // that will never be exported, which is worth counting rather than
        // discarding silently.
        if (record.value.kind === "attributes") {
          const decoded = decodeRecord(record.value.attributes);
          if (
            decoded.kind === "present" &&
            decoded.record.startedAt !== undefined &&
            decoded.record.endedAt === undefined
          ) {
            expiredOpen += 1;
          }
        }
        await stateStore.delete(key);
        removed += 1;
      }
    }
    return { removed, scanned, expiredOpen };
  };

  return { recordStart, recordEnd, correlateBatch, cleanup };
};
