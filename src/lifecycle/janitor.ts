import type { CallbackDeduplicator } from "./dedup.js";
import type { SpanCorrelator } from "./span-correlator.js";
import type { UsageAccumulator } from "./usage-accumulator.js";

const DEFAULT_MAX_AGE_MILLIS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES_PER_COMPONENT = 1_000;

export type LifecycleJanitorOptions = {
  readonly spanCorrelator?: SpanCorrelator;
  readonly deduplicator?: CallbackDeduplicator;
  readonly usageAccumulator?: UsageAccumulator;
  readonly spanMaxAgeMillis?: number;
  readonly dedupMaxAgeMillis?: number;
  /**
   * Floor on how long an uncommitted delivery claim survives the sweep, whatever
   * `dedupMaxAgeMillis` says.
   *
   * Passed through rather than left to the deduplicator's default so it can be the
   * *effective* window the runtime computed, which is raised from the requested one
   * to cover a process's whole export budget. A sweep using a smaller number than
   * the claim path uses would delete claims the claim path still considers live.
   */
  readonly dedupStaleClaimMillis?: number;
  readonly usageMaxAgeMillis?: number;
  /** Caps how many keys any single component scans per sweep. */
  readonly maxEntriesPerComponent?: number;
};

export type LifecycleSweepStats = {
  readonly removed: number;
  readonly scanned: number;
  /**
   * Span records dropped with a start and no end — spans that were never
   * exported. Reported only by the span sweep; see `SpanCleanupResult`.
   */
  readonly expiredOpen?: number;
  /**
   * Aged-out records kept back because they are delivery claims a live process may
   * still hold. Reported only by the dedup sweep; see `DedupCleanupResult`.
   */
  readonly retainedInFlight?: number;
};

export type LifecycleCleanupReport = {
  readonly span?: LifecycleSweepStats;
  readonly dedup?: LifecycleSweepStats;
  readonly usage?: LifecycleSweepStats;
};

/**
 * Fans a single bounded cleanup pass out across whichever lifecycle
 * components are configured.
 *
 * Each component already bounds its own sweep (`maxEntries`); this exists so
 * a caller — a CLI subcommand, a periodic timer, an opportunistic call at the
 * end of `flush()` — can run "the" cleanup without wiring each component by
 * hand, and so the bound is enforced uniformly rather than per call site.
 */
export interface LifecycleJanitor {
  runOnce(sessionId?: string): Promise<LifecycleCleanupReport>;
}

export const createLifecycleJanitor = (options: LifecycleJanitorOptions): LifecycleJanitor => {
  const maxEntries = options.maxEntriesPerComponent ?? DEFAULT_MAX_ENTRIES_PER_COMPONENT;
  const spanMaxAge = options.spanMaxAgeMillis ?? DEFAULT_MAX_AGE_MILLIS;
  const dedupMaxAge = options.dedupMaxAgeMillis ?? DEFAULT_MAX_AGE_MILLIS;
  const usageMaxAge = options.usageMaxAgeMillis ?? DEFAULT_MAX_AGE_MILLIS;

  const runOnce = async (sessionId?: string): Promise<LifecycleCleanupReport> => {
    const scope = { maxEntries, ...(sessionId === undefined ? {} : { sessionId }) };
    const [span, dedup, usage] = await Promise.all([
      options.spanCorrelator?.cleanup(spanMaxAge, scope),
      // Deduplication is deliberately swept across every scope rather than the
      // ending session's: a delivery scope is a host-chosen namespace or a
      // digest of provider/installation/session, never a session id, so scoping
      // this sweep by `sessionId` would match nothing and let records accumulate
      // forever. The sweep is TTL-driven and still bounded by `maxEntries`.
      options.deduplicator?.cleanup(dedupMaxAge, {
        maxEntries,
        ...(options.dedupStaleClaimMillis === undefined
          ? {}
          : { staleClaimMillis: options.dedupStaleClaimMillis }),
      }),
      options.usageAccumulator?.cleanup(usageMaxAge, scope),
    ]);
    return {
      ...(span === undefined ? {} : { span }),
      ...(dedup === undefined ? {} : { dedup }),
      ...(usage === undefined ? {} : { usage }),
    };
  };

  return { runOnce };
};
