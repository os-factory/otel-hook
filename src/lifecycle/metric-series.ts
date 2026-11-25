import { createHash } from "node:crypto";

import type { Clock, StateStore } from "../runtime/ports.js";
import { withOptionalSessionLock } from "../state/store.js";
import {
  emptyHistogram,
  METRIC_INSTRUMENTS,
  recordIntoHistogram,
  seriesIdentity,
  type HistogramState,
  type MetricObservation,
  type MetricPoint,
} from "../telemetry/metric-model.js";
import { metricSeriesKey, metricSeriesScanPrefix } from "./keys.js";

/**
 * Cumulative metric series kept across hook processes (issue #69).
 *
 * A hook process lives for one callback, so an in-process `MeterProvider` would
 * only ever see one observation and restart every series at zero. Cumulative
 * temporality — what receivers that merge counters by keeping the largest value
 * need — therefore requires the running total to outlive the process. Each series
 * is one state record: read, fold the batch's observations in, write back, and
 * export the new total as a point whose interval starts at the series' first
 * observation.
 *
 * Folding is idempotent per delivery: the record names the last delivery folded
 * into it, so a callback replayed after a crash between "recorded" and "committed"
 * restates the total instead of adding to it.
 *
 * Concurrency: the read-fold-write runs under the session lock of the series'
 * scope (the provider session, or one shared lock for series that span sessions),
 * the same lock usage accounting uses, so two concurrent processes cannot both add
 * to the same stale total.
 */

export type MetricSeriesStoreDependencies = {
  readonly stateStore: StateStore;
  readonly clock: Clock;
};

export type RecordCumulativeOptions = {
  /** Opaque digest of the delivery these observations came from. */
  readonly deliveryToken?: string;
  /** Whether series are per session (`session.id` on the points). Default true. */
  readonly perSession?: boolean;
};

export type MetricSeriesCleanupResult = { readonly removed: number; readonly scanned: number };

export interface MetricSeriesStore {
  /** Fold observations into their series; returns one cumulative point per touched series. */
  recordCumulative(
    observations: readonly MetricObservation[],
    options?: RecordCumulativeOptions,
  ): Promise<readonly MetricPoint[]>;
  /** Remember when the session's current turn began (its last prompt). */
  recordTurnStart(sessionId: string, startMillis: number): Promise<void>;
  /** When the session's current turn began, if a prompt was recorded. */
  readTurnStart(sessionId: string): Promise<number | undefined>;
  cleanup(
    maxAgeMillis: number,
    options?: { readonly maxEntries?: number; readonly sessionId?: string },
  ): Promise<MetricSeriesCleanupResult>;
}

/** Not a base64url digest (43 chars), so it can never collide with a series key. */
const TURN_START_SEGMENT = "turn-start";

/** Lock and key scope for series that are not per session. */
const SHARED_SCOPE = "all";
const SHARED_LOCK = "otelhook.metrics.shared";

const sessionScope = (sessionId: string): string => `s=${sessionId}`;

const digest = (identity: string): string =>
  createHash("sha256").update(identity).digest("base64url").slice(0, 43);

type SeriesRecord = {
  readonly startTimeMillis: number;
  readonly value?: number | undefined;
  readonly histogram?: HistogramState | undefined;
  readonly appliedDelivery?: string | undefined;
};

const toStoredHistogram = (
  histogram: HistogramState,
): { count: number; sum: number; min: number; max: number; bucketCounts: number[] } => ({
  count: histogram.count,
  sum: histogram.sum,
  // An empty histogram has infinite min/max, which JSON cannot hold. A stored
  // histogram always has at least one value, so these are finite in practice.
  min: Number.isFinite(histogram.min) ? histogram.min : 0,
  max: Number.isFinite(histogram.max) ? histogram.max : 0,
  bucketCounts: [...histogram.bucketCounts],
});

export const createMetricSeriesStore = (deps: MetricSeriesStoreDependencies): MetricSeriesStore => {
  const { stateStore, clock } = deps;

  const readSeries = async (key: string): Promise<SeriesRecord | undefined> => {
    const record = await stateStore.read(key);
    if (record?.value.kind !== "metric-series") {
      return undefined;
    }
    return record.value;
  };

  const recordGroup = async (
    scope: string,
    observations: readonly MetricObservation[],
    deliveryToken: string | undefined,
  ): Promise<MetricPoint[]> => {
    const bySeries = new Map<string, MetricObservation[]>();
    for (const observation of observations) {
      const identity = seriesIdentity(observation.instrument, observation.attributes);
      const group = bySeries.get(identity) ?? [];
      group.push(observation);
      bySeries.set(identity, group);
    }

    const now = clock.now();
    const points: MetricPoint[] = [];
    for (const [identity, group] of bySeries) {
      const first = group[0];
      if (first === undefined) {
        continue;
      }
      const instrument = METRIC_INSTRUMENTS[first.instrument];
      const key = metricSeriesKey(scope, digest(identity));
      const existing = await readSeries(key);
      const boundaries = instrument.boundaries;
      // A stored histogram whose bucket layout no longer matches the instrument
      // cannot be continued; it restarts, with a new start time, which a receiver
      // reads as a reset rather than as a decrease.
      const compatible =
        existing !== undefined &&
        (boundaries === undefined
          ? existing.value !== undefined
          : existing.histogram?.bucketCounts.length === boundaries.length + 1);
      const base = compatible ? existing : undefined;
      const replay = deliveryToken !== undefined && base?.appliedDelivery === deliveryToken;

      const earliest = Math.min(...group.map((observation) => observation.timeMillis));
      const startTimeMillis = base?.startTimeMillis ?? Math.min(earliest, now);
      let value = base?.value ?? 0;
      let histogram: HistogramState | undefined =
        boundaries === undefined
          ? undefined
          : base?.histogram === undefined
            ? emptyHistogram(boundaries)
            : base.histogram;

      if (!replay) {
        for (const observation of group) {
          if (histogram !== undefined && boundaries !== undefined) {
            histogram = recordIntoHistogram(histogram, boundaries, observation.value);
          } else {
            value += observation.value;
          }
        }
        await stateStore.write(key, {
          kind: "metric-series",
          startTimeMillis,
          ...(histogram === undefined ? { value } : { histogram: toStoredHistogram(histogram) }),
          ...(deliveryToken === undefined ? {} : { appliedDelivery: deliveryToken }),
        });
      }

      points.push({
        instrument: first.instrument,
        temporality: "cumulative",
        attributes: first.attributes,
        startTimeMillis,
        timeMillis: Math.max(now, startTimeMillis),
        ...(histogram === undefined ? { value } : { histogram }),
      });
    }
    return points;
  };

  const recordCumulative = async (
    observations: readonly MetricObservation[],
    options?: RecordCumulativeOptions,
  ): Promise<readonly MetricPoint[]> => {
    if (observations.length === 0) {
      return [];
    }
    if (options?.perSession === false) {
      return withOptionalSessionLock(stateStore, SHARED_LOCK, () =>
        recordGroup(SHARED_SCOPE, observations, options.deliveryToken),
      );
    }
    const bySession = new Map<string, MetricObservation[]>();
    for (const observation of observations) {
      const group = bySession.get(observation.sessionId) ?? [];
      group.push(observation);
      bySession.set(observation.sessionId, group);
    }
    const points: MetricPoint[] = [];
    for (const [sessionId, group] of bySession) {
      points.push(
        ...(await withOptionalSessionLock(stateStore, sessionId, () =>
          recordGroup(sessionScope(sessionId), group, options?.deliveryToken),
        )),
      );
    }
    return points;
  };

  const cleanup = async (
    maxAgeMillis: number,
    options?: { readonly maxEntries?: number; readonly sessionId?: string },
  ): Promise<MetricSeriesCleanupResult> => {
    const cap = options?.maxEntries ?? 1_000;
    const now = clock.now();
    let removed = 0;
    let scanned = 0;
    const prefix = metricSeriesScanPrefix(
      options?.sessionId === undefined ? undefined : sessionScope(options.sessionId),
    );
    for (const key of await stateStore.keys(prefix)) {
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

  const turnKey = (sessionId: string): string => metricSeriesKey(sessionScope(sessionId), TURN_START_SEGMENT);

  const recordTurnStart = (sessionId: string, startMillis: number): Promise<void> =>
    withOptionalSessionLock(stateStore, sessionId, async () => {
      const existing = await stateStore.read(turnKey(sessionId));
      const previous =
        existing?.value.kind === "attributes" && typeof existing.value.attributes.startMillis === "number"
          ? existing.value.attributes.startMillis
          : undefined;
      // Never move backwards: a late, redelivered prompt must not reopen an older turn.
      if (previous !== undefined && previous >= startMillis) {
        return;
      }
      await stateStore.write(turnKey(sessionId), { kind: "attributes", attributes: { startMillis } });
    });

  const readTurnStart = async (sessionId: string): Promise<number | undefined> => {
    const record = await stateStore.read(turnKey(sessionId));
    const value = record?.value.kind === "attributes" ? record.value.attributes.startMillis : undefined;
    return typeof value === "number" ? value : undefined;
  };

  return { recordCumulative, recordTurnStart, readTurnStart, cleanup };
};
