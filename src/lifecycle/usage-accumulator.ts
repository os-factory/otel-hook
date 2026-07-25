import {
  UsageNormalizationError,
  normalizeUsageOrThrow,
  type CanonicalUsage,
} from "../model/usage.js";
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
  accumulateDelta(key: UsageAccumulatorKey, delta: CanonicalUsage): Promise<UsageAccumulatorSnapshot>;
  recordReset(key: UsageAccumulatorKey): Promise<{ readonly epoch: number }>;
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

  const readEpoch = async (key: UsageAccumulatorKey): Promise<number> => {
    const record = await stateStore.read(rollupEpochKey(key.sessionId, key.scope, key.scopeKey));
    if (record?.value.kind === "attributes" && typeof record.value.attributes.epoch === "number") {
      return record.value.attributes.epoch;
    }
    return 0;
  };

  const accumulateDelta = (
    key: UsageAccumulatorKey,
    delta: CanonicalUsage,
  ): Promise<UsageAccumulatorSnapshot> =>
    withOptionalSessionLock(stateStore, key.sessionId, async (): Promise<UsageAccumulatorSnapshot> => {
      const usageKey = rollupUsageKey(key.sessionId, key.scope, key.scopeKey);
      const existing = await stateStore.read(usageKey);
      const previousTotal =
        existing?.value.kind === "usage-cumulative" ? existing.value.usage : EMPTY_CUMULATIVE_USAGE;
      const total = combineCumulativeWithDelta(previousTotal, delta);
      await stateStore.write(usageKey, { kind: "usage-cumulative", usage: total });
      return { total, epoch: await readEpoch(key) };
    });

  const recordReset = (key: UsageAccumulatorKey): Promise<{ readonly epoch: number }> =>
    withOptionalSessionLock(stateStore, key.sessionId, async (): Promise<{ readonly epoch: number }> => {
      const epoch = (await readEpoch(key)) + 1;
      await stateStore.write(rollupEpochKey(key.sessionId, key.scope, key.scopeKey), {
        kind: "attributes",
        attributes: { epoch },
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
