/**
 * Curated public surface of the lifecycle layer.
 *
 * The state-key builders in `lifecycle/keys.ts` are omitted: they define the
 * on-disk key space, which must stay free to change.
 */
export {
  createCallbackDeduplicator,
  type CallbackDeduplicator,
  type CallbackDeduplicatorDependencies,
  type DedupCheckResult,
  type DedupCleanupResult,
  type DeliveryClaimOptions,
  type DeliveryClaimOutcome,
  type DeliveryClaimResult,
} from "../lifecycle/dedup.js";
export {
  createSpanCorrelator,
  SPAN_RECORD_VERSION,
  type LifecycleScope,
  type SpanCleanupResult,
  type SpanCorrelationFacts,
  type SpanCorrelator,
  type SpanCorrelatorDependencies,
  type SpanEndInput,
  type SpanEndOrphanReason,
  type SpanEndResult,
  type SpanStartInput,
  type SpanStartResult,
} from "../lifecycle/span-correlator.js";
export {
  createUsageAccumulator,
  type RollupCleanupResult,
  type UsageAccumulator,
  type UsageAccumulatorDependencies,
  type UsageAccumulatorKey,
  type UsageAccumulatorSnapshot,
} from "../lifecycle/usage-accumulator.js";
export {
  createLifecycleJanitor,
  type LifecycleCleanupReport,
  type LifecycleJanitor,
  type LifecycleJanitorOptions,
  type LifecycleSweepStats,
} from "../lifecycle/janitor.js";
