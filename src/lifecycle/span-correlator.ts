import type { Clock, StateStore } from "../runtime/ports.js";
import { withOptionalSessionLock } from "../state/store.js";
import { spanKey, spanScanPrefix } from "./keys.js";

/** Correlation scopes that pair a `*.start` event with a later `*.end` event. */
export type LifecycleScope = "session" | "generation" | "tool" | "subagent";

export type SpanStartInput = {
  readonly sessionId: string;
  readonly scope: LifecycleScope;
  readonly scopeKey: string;
  /** The canonical event id of the start event; used to detect redelivery. */
  readonly eventId: string;
  readonly occurredAt: number;
};

export type SpanEndInput = {
  readonly sessionId: string;
  readonly scope: LifecycleScope;
  readonly scopeKey: string;
  readonly eventId: string;
  readonly occurredAt: number;
};

export type SpanStartResult =
  | { readonly status: "recorded" }
  /** The same start (by event id) was already recorded; nothing changed. */
  | { readonly status: "duplicate" };

export type SpanEndResult =
  | { readonly status: "matched"; readonly startedAt: number; readonly durationMillis: number }
  /** This end (by event id) was already applied to the open span. */
  | { readonly status: "duplicate" }
  /** No open start is recorded for this scope key; it expired, was never seen, or already closed. */
  | { readonly status: "orphaned"; readonly reason: "no-start-recorded" };

export type SpanCleanupResult = { readonly removed: number; readonly scanned: number };

/**
 * Cross-invocation start/end correlation for session, generation, tool, and
 * subagent scopes.
 *
 * A coding-agent hook fires once per lifecycle edge, often as a separate short
 * process for the start and the end. This tracks an open span in the shared
 * state store so the end side can compute a duration even though it has no
 * memory of the start, and so a redelivered start or end (an at-least-once
 * host retry) is recognized instead of silently double-counted.
 */
export interface SpanCorrelator {
  recordStart(input: SpanStartInput): Promise<SpanStartResult>;
  recordEnd(input: SpanEndInput): Promise<SpanEndResult>;
  /** Bounded sweep: drops spans untouched for longer than `maxAgeMillis`. */
  cleanup(
    maxAgeMillis: number,
    options?: { readonly maxEntries?: number; readonly sessionId?: string },
  ): Promise<SpanCleanupResult>;
}

export type SpanCorrelatorDependencies = {
  readonly stateStore: StateStore;
  readonly clock: Clock;
};

export const createSpanCorrelator = (deps: SpanCorrelatorDependencies): SpanCorrelator => {
  const { stateStore, clock } = deps;

  const recordStart = (input: SpanStartInput): Promise<SpanStartResult> =>
    withOptionalSessionLock(stateStore, input.sessionId, async (): Promise<SpanStartResult> => {
      const key = spanKey(input.sessionId, input.scope, input.scopeKey);
      const existing = await stateStore.read(key);
      if (existing?.value.kind === "attributes" && existing.value.attributes.startEventId === input.eventId) {
        return { status: "duplicate" };
      }
      await stateStore.write(key, {
        kind: "attributes",
        attributes: { startEventId: input.eventId, startedAt: input.occurredAt },
      });
      return { status: "recorded" };
    });

  const recordEnd = (input: SpanEndInput): Promise<SpanEndResult> =>
    withOptionalSessionLock(stateStore, input.sessionId, async (): Promise<SpanEndResult> => {
      const key = spanKey(input.sessionId, input.scope, input.scopeKey);
      const existing = await stateStore.read(key);
      if (existing === undefined || existing.value.kind !== "attributes") {
        return { status: "orphaned", reason: "no-start-recorded" };
      }
      const attributes = existing.value.attributes;
      if (attributes.endEventId !== undefined) {
        return { status: "duplicate" };
      }
      const startedAt = typeof attributes.startedAt === "number" ? attributes.startedAt : input.occurredAt;
      const durationMillis = Math.max(0, input.occurredAt - startedAt);
      await stateStore.write(key, {
        kind: "attributes",
        attributes: { ...attributes, endEventId: input.eventId, endedAt: input.occurredAt },
      });
      return { status: "matched", startedAt, durationMillis };
    });

  const cleanup = async (
    maxAgeMillis: number,
    options?: { readonly maxEntries?: number; readonly sessionId?: string },
  ): Promise<SpanCleanupResult> => {
    const keys = await stateStore.keys(spanScanPrefix(options?.sessionId));
    const cap = options?.maxEntries ?? 1_000;
    const now = clock.now();
    let removed = 0;
    let scanned = 0;
    for (const key of keys) {
      if (scanned >= cap) {
        break;
      }
      scanned += 1;
      const record = await stateStore.read(key);
      if (record !== undefined && now - record.updatedAt > maxAgeMillis) {
        await stateStore.delete(key);
        removed += 1;
      }
    }
    return { removed, scanned };
  };

  return { recordStart, recordEnd, cleanup };
};
