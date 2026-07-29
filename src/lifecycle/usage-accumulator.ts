import {
  UsageNormalizationError,
  normalizeUsageOrThrow,
  type CanonicalUsage,
} from "../model/usage.js";
import type { Attributes } from "../model/primitives.js";
import type { Clock, StateStore } from "../runtime/ports.js";
import { withOptionalSessionLock } from "../state/store.js";
import { rollupEpochKey, rollupEpochScanPrefix, rollupScanPrefix, rollupUsageKey } from "./keys.js";

export type UsageAccumulatorKey = {
  readonly sessionId: string;
  readonly scope: string;
  readonly scopeKey: string;
};

export type UsageAccumulatorSnapshot = {
  readonly total: CanonicalUsage;
  /** Increments every time {@link UsageAccumulator.recordReset} is called for this key. */
  readonly epoch: number;
};

export type RollupCleanupResult = { readonly removed: number; readonly scanned: number };

/**
 * Which delivery an accumulation belongs to, and which of its observations this is.
 *
 * Supplying it makes the accumulation idempotent for *that delivery*: a second
 * application of the same `(callbackId, ordinal)` is a no-op that returns the
 * current total. Omitting it keeps the old unconditional behaviour, which is right
 * for a caller that has no delivery identity to key on — there is nothing to
 * recognize a repeat by, and refusing to accumulate would lose a real observation.
 *
 * `callbackId` must be an opaque digest, not a raw host or provider id: it is
 * written into a state record.
 */
export type DeliveryStamp = {
  readonly callbackId: string;
  /** Zero-based index of this observation within the delivery, per rollup key. */
  readonly ordinal: number;
};

export type AccumulateOptions = { readonly delivery?: DeliveryStamp };

/**
 * Rolls a stream of `delta` usage observations up into a running `cumulative`
 * total per scope, independent of the orchestrator's own per-scope
 * cumulative-to-delta baseline (`docs/usage-semantics.md`) — that baseline
 * answers "what changed since last time"; this answers "what is the running
 * total", which a diagnostics view or a parent scope (tool -> generation ->
 * session) needs and the core does not compute.
 *
 * A provider counter can restart mid-session (a process restart, a replayed
 * transcript). Rather than let a smaller cumulative total silently deflate the
 * running rollup, {@link UsageAccumulator.recordReset} starts a new epoch: the
 * total resets to zero and the epoch number increments, so a downstream
 * consumer can tell "the counter restarted" from "usage actually decreased"
 * and never sums across the boundary as if it were one continuous series.
 */
export interface UsageAccumulator {
  /**
   * Fold `delta` into the running total for `key`.
   *
   * With `options.delivery`, folding is idempotent for that delivery: a redelivered
   * callback whose claim was reclaimed or superseded re-derives the same delta and
   * would otherwise count it twice. The marker lives in the same record as the total
   * it describes, so the check and the write are one atomic operation — which is the
   * only reason this is expressible without a multi-key transaction. What it does
   * *not* cover is a delivery whose marker a later, different delivery has since
   * overwritten: only the most recent delivery per rollup key is recognizable, which
   * is exactly the retry window and nothing beyond it.
   */
  accumulateDelta(
    key: UsageAccumulatorKey,
    delta: CanonicalUsage,
    options?: AccumulateOptions,
  ): Promise<UsageAccumulatorSnapshot>;
  /** Start a new epoch. Idempotent per delivery when `options.delivery` is given. */
  recordReset(key: UsageAccumulatorKey, options?: AccumulateOptions): Promise<{ readonly epoch: number }>;
  read(key: UsageAccumulatorKey): Promise<UsageAccumulatorSnapshot | undefined>;
  cleanup(
    maxAgeMillis: number,
    options?: { readonly maxEntries?: number; readonly sessionId?: string },
  ): Promise<RollupCleanupResult>;
}

export type UsageAccumulatorDependencies = {
  readonly stateStore: StateStore;
  readonly clock: Clock;
};

const EMPTY_CUMULATIVE_USAGE: CanonicalUsage = normalizeUsageOrThrow({ temporality: "cumulative" });

const combineCumulativeWithDelta = (total: CanonicalUsage, delta: CanonicalUsage): CanonicalUsage => {
  if (total.temporality !== "cumulative") {
    throw new UsageNormalizationError([
      { code: "invalid-report", message: "usage rollup total must have cumulative temporality" },
    ]);
  }
  if (delta.temporality !== "delta") {
    throw new UsageNormalizationError([
      { code: "invalid-report", message: "usage accumulator only accepts delta observations" },
    ]);
  }

  const accounting =
    total.cacheCreationInputTokens === 0 && total.cacheCreationAccounting === "not-reported"
      ? delta.cacheCreationAccounting
      : delta.cacheCreationInputTokens === 0 && delta.cacheCreationAccounting === "not-reported"
        ? total.cacheCreationAccounting
        : total.cacheCreationAccounting;

  if (
    total.cacheCreationInputTokens !== 0 &&
    delta.cacheCreationInputTokens !== 0 &&
    total.cacheCreationAccounting !== delta.cacheCreationAccounting
  ) {
    throw new UsageNormalizationError([
      {
        code: "cache-creation-accounting-missing",
        message: "cannot roll up usage across differing cacheCreationAccounting modes",
      },
    ]);
  }

  const providerTotal =
    total.providerTotalTokens === undefined && delta.providerTotalTokens === undefined
      ? undefined
      : (total.providerTotalTokens ?? 0) + (delta.providerTotalTokens ?? 0);

  return normalizeUsageOrThrow({
    temporality: "cumulative",
    inputTokens: total.inputTokens + delta.inputTokens,
    cachedInputTokens: total.cachedInputTokens + delta.cachedInputTokens,
    cacheCreationInputTokens: total.cacheCreationInputTokens + delta.cacheCreationInputTokens,
    cacheCreationAccounting: accounting,
    outputTokens: total.outputTokens + delta.outputTokens,
    reasoningOutputTokens: total.reasoningOutputTokens + delta.reasoningOutputTokens,
    ...(providerTotal === undefined ? {} : { providerTotalTokens: providerTotal }),
  });
};

export const createUsageAccumulator = (deps: UsageAccumulatorDependencies): UsageAccumulator => {
  const { stateStore, clock } = deps;

  /**
   * The epoch record's own delivery marker.
   *
   * Kept in the epoch record for the same reason the total's marker is kept in the
   * total: one write, so the counter and the statement about who moved it cannot
   * disagree. The epoch record is an `attributes` value, so the two fields are
   * flat rather than nested.
   */
  const readEpochMarker = (
    attributes: Attributes,
  ): { readonly callbackId: string; readonly applications: number } | undefined => {
    const callbackId = attributes.resetDelivery;
    const applications = attributes.resetApplications;
    if (
      typeof callbackId !== "string" ||
      callbackId.length === 0 ||
      typeof applications !== "number" ||
      !Number.isInteger(applications) ||
      applications < 1
    ) {
      return undefined;
    }
    return { callbackId, applications };
  };

  const readEpoch = async (key: UsageAccumulatorKey): Promise<number> => {
    const record = await stateStore.read(rollupEpochKey(key.sessionId, key.scope, key.scopeKey));
    if (record?.value.kind === "attributes" && typeof record.value.attributes.epoch === "number") {
      return record.value.attributes.epoch;
    }
    return 0;
  };

  /**
   * Whether this delivery's observation number `ordinal` is already folded in.
   *
   * The comparison is `<` rather than `===` because observations are applied in
   * order: `applications` is the count folded in so far, so any ordinal below it has
   * been seen. A marker naming a *different* delivery means this rollup has moved on
   * and nothing can be recognized.
   */
  const alreadyApplied = (
    marker: { readonly callbackId: string; readonly applications: number } | undefined,
    delivery: DeliveryStamp | undefined,
  ): boolean =>
    delivery !== undefined &&
    marker !== undefined &&
    marker.callbackId === delivery.callbackId &&
    delivery.ordinal < marker.applications;

  const markerFor = (
    delivery: DeliveryStamp | undefined,
  ): { readonly appliedDelivery?: { readonly callbackId: string; readonly applications: number } } =>
    delivery === undefined
      ? {}
      : {
          appliedDelivery: { callbackId: delivery.callbackId, applications: delivery.ordinal + 1 },
        };

  const accumulateDelta = (
    key: UsageAccumulatorKey,
    delta: CanonicalUsage,
    options?: AccumulateOptions,
  ): Promise<UsageAccumulatorSnapshot> =>
    withOptionalSessionLock(stateStore, key.sessionId, async (): Promise<UsageAccumulatorSnapshot> => {
      const usageKey = rollupUsageKey(key.sessionId, key.scope, key.scopeKey);
      const existing = await stateStore.read(usageKey);
      const previousTotal =
        existing?.value.kind === "usage-cumulative" ? existing.value.usage : EMPTY_CUMULATIVE_USAGE;

      if (
        existing?.value.kind === "usage-cumulative" &&
        alreadyApplied(existing.value.appliedDelivery, options?.delivery)
      ) {
        // This exact observation of this exact delivery is already in the total.
        // Reporting the total unchanged is the honest answer: the caller asked for
        // the running figure after its delta, and that is what this is.
        return { total: previousTotal, epoch: await readEpoch(key) };
      }

      const total = combineCumulativeWithDelta(previousTotal, delta);
      await stateStore.write(usageKey, {
        kind: "usage-cumulative",
        usage: total,
        ...markerFor(options?.delivery),
      });
      return { total, epoch: await readEpoch(key) };
    });

  const recordReset = (
    key: UsageAccumulatorKey,
    options?: AccumulateOptions,
  ): Promise<{ readonly epoch: number }> =>
    withOptionalSessionLock(stateStore, key.sessionId, async (): Promise<{ readonly epoch: number }> => {
      const epochKey = rollupEpochKey(key.sessionId, key.scope, key.scopeKey);
      const existingEpoch = await stateStore.read(epochKey);
      const marker =
        existingEpoch?.value.kind === "attributes"
          ? readEpochMarker(existingEpoch.value.attributes)
          : undefined;

      if (alreadyApplied(marker, options?.delivery)) {
        // A replayed reset must not open a second epoch: the epoch number is what a
        // consumer uses to refuse summing across a counter restart, and inflating it
        // twice for one restart makes a real series look like two.
        return { epoch: await readEpoch(key) };
      }

      const epoch = (await readEpoch(key)) + 1;
      const applied = markerFor(options?.delivery).appliedDelivery;
      await stateStore.write(epochKey, {
        kind: "attributes",
        attributes: {
          epoch,
          ...(applied === undefined
            ? {}
            : { resetDelivery: applied.callbackId, resetApplications: applied.applications }),
        },
      });
      await stateStore.delete(rollupUsageKey(key.sessionId, key.scope, key.scopeKey));
      return { epoch };
    });

  const read = async (key: UsageAccumulatorKey): Promise<UsageAccumulatorSnapshot | undefined> => {
    const record = await stateStore.read(rollupUsageKey(key.sessionId, key.scope, key.scopeKey));
    if (record?.value.kind !== "usage-cumulative") {
      return undefined;
    }
    return { total: record.value.usage, epoch: await readEpoch(key) };
  };

  const cleanup = async (
    maxAgeMillis: number,
    options?: { readonly maxEntries?: number; readonly sessionId?: string },
  ): Promise<RollupCleanupResult> => {
    const cap = options?.maxEntries ?? 1_000;
    const now = clock.now();
    let removed = 0;
    let scanned = 0;

    const sweep = async (keys: readonly string[]): Promise<void> => {
      for (const key of keys) {
        if (scanned >= cap) {
          return;
        }
        scanned += 1;
        const record = await stateStore.read(key);
        if (record !== undefined && now - record.updatedAt > maxAgeMillis) {
          await stateStore.delete(key);
          removed += 1;
        }
      }
    };

    await sweep(await stateStore.keys(rollupScanPrefix(options?.sessionId)));
    await sweep(await stateStore.keys(rollupEpochScanPrefix(options?.sessionId)));
    return { removed, scanned };
  };

  return { accumulateDelta, recordReset, read, cleanup };
};
