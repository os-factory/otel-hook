import type { OtelHookErrorCode } from "../errors/index.js";
import type { EpochMillis } from "../model/primitives.js";

/**
 * One tracked delivery path.
 *
 * The two telemetry signals are separate subsystems because they fail
 * independently — a collector with no logs receiver leaves traces perfectly
 * healthy — and a single combined verdict would make an operator bisect which one
 * is broken. `telemetry-sink` remains the traces signal, unrenamed, so an existing
 * `doctor --json` consumer keeps reading the same field.
 */
export type DeliverySubsystem =
  | "state-store"
  | "telemetry-sink"
  | "telemetry-log-sink"
  | "lifecycle";

/**
 * Sanitized delivery health.
 *
 * Every field is a count, a timestamp, a boolean, or a closed-vocabulary error
 * code — the same restriction the privacy service applies to everything else
 * that might reach a sink, so a health snapshot is itself safe to export or log
 * without a second review.
 */
export type DeliveryHealthSnapshot = {
  readonly subsystem: DeliverySubsystem;
  readonly healthy: boolean;
  readonly totalAccepted: number;
  readonly totalRejected: number;
  readonly consecutiveFailures: number;
  readonly lastSuccessAt?: EpochMillis;
  readonly lastFailureAt?: EpochMillis;
  readonly lastErrorCode?: OtelHookErrorCode;
};

export type HealthTrackerOptions = {
  /** Consecutive failures at or beyond this count flip `healthy` to false. Default 3. */
  readonly unhealthyAfterConsecutiveFailures?: number;
};

/**
 * Accumulates success/failure counts for one subsystem instance.
 *
 * Deliberately per-instance rather than a module-level registry: a store or
 * sink constructs its own tracker and exposes a `health()` accessor, so two
 * instances in one process never share counters (see ADR 0001 on module-level
 * identity).
 */
export interface HealthTracker {
  recordSuccess(count?: number, at?: number): void;
  recordFailure(code: OtelHookErrorCode, count?: number, at?: number): void;
  snapshot(): DeliveryHealthSnapshot;
}

export const createHealthTracker = (
  subsystem: DeliverySubsystem,
  options: HealthTrackerOptions = {},
): HealthTracker => {
  const unhealthyThreshold = options.unhealthyAfterConsecutiveFailures ?? 3;
  let totalAccepted = 0;
  let totalRejected = 0;
  let consecutiveFailures = 0;
  let lastSuccessAt: number | undefined;
  let lastFailureAt: number | undefined;
  let lastErrorCode: OtelHookErrorCode | undefined;

  return {
    recordSuccess: (count = 1, at?: number): void => {
      totalAccepted += count;
      consecutiveFailures = 0;
      if (at !== undefined) {
        lastSuccessAt = at;
      }
    },
    recordFailure: (code: OtelHookErrorCode, count = 1, at?: number): void => {
      totalRejected += count;
      consecutiveFailures += 1;
      lastErrorCode = code;
      if (at !== undefined) {
        lastFailureAt = at;
      }
    },
    snapshot: (): DeliveryHealthSnapshot => ({
      subsystem,
      healthy: consecutiveFailures < unhealthyThreshold,
      totalAccepted,
      totalRejected,
      consecutiveFailures,
      ...(lastSuccessAt === undefined ? {} : { lastSuccessAt }),
      ...(lastFailureAt === undefined ? {} : { lastFailureAt }),
      ...(lastErrorCode === undefined ? {} : { lastErrorCode }),
    }),
  };
};

export type OverallHealth = {
  readonly healthy: boolean;
  readonly subsystems: readonly DeliveryHealthSnapshot[];
};

/** Combines snapshots from every configured subsystem into one overall verdict. */
export const summarizeHealth = (snapshots: readonly DeliveryHealthSnapshot[]): OverallHealth => ({
  healthy: snapshots.every((snapshot) => snapshot.healthy),
  subsystems: [...snapshots],
});
