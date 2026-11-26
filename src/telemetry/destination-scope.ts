import {
  matchDestinationScope,
  type DestinationScope,
} from "../config/destinations.js";
import { ATTR_VCS_REPOSITORY_URL_FULL, normalizeRepositoryKey } from "../config/repository-key.js";
import type { ContentFact } from "../model/content.js";
import type { CanonicalEvent } from "../model/events.js";
import { CONTENT_MODE_DISCLOSURE, type ContentMode } from "../privacy/policy.js";
import type { MetricPoint } from "./metric-model.js";
import { spanEndEdgesOf } from "./semconv.js";

/**
 * Destination scopes applied to one batch (see `destinationScopeSchema`).
 *
 * A scoped destination receives a record only when the record's repository —
 * the `vcs.repository.url.full` it is exported with — falls in one of its
 * scopes, and then only the signals, content disclosure, and session id that
 * scope allows. Everything here is a pure function of the batch; the sinks then
 * map, send, and spool exactly what they are given, so a scoped destination's
 * spool only ever holds what passed its filter.
 *
 * The repository is read the way the record will carry it on the wire: the
 * session context stamped on the event wins over the exporter Resource (the
 * launcher's `OTEL_RESOURCE_ATTRIBUTES`), as it does in `profileAttributes`.
 * A context value that does not parse as a repository URL names no repository —
 * it is not silently replaced by the Resource's.
 */

const DISCLOSURE_RANK: Readonly<Record<ContentFact["disclosure"], number>> = Object.freeze({
  omitted: 0,
  masked: 1,
  redacted: 2,
  raw: 3,
});

/** Lowers a content fact's disclosure; the privacy service's `restrictContent`. */
export type ContentRestrictor = (fact: ContentFact, mode: ContentMode) => ContentFact;

/**
 * Fallback when no privacy service is supplied: anything above `omit` that
 * must be lowered is omitted outright, which is never more than was asked for.
 */
export const omitRestrictedContent: ContentRestrictor = (fact, mode) => {
  if (fact.text === undefined || DISCLOSURE_RANK[fact.disclosure] <= DISCLOSURE_RANK[CONTENT_MODE_DISCLOSURE[mode]]) {
    return fact;
  }
  const { text, ...rest } = fact;
  void text;
  return { ...rest, disclosure: "omitted", truncated: false };
};

/** The repository key a value names, or `undefined`. */
const keyOfValue = (value: unknown): string | undefined =>
  typeof value === "string" ? normalizeRepositoryKey(value) : undefined;

/**
 * The repository key of the Resource every record of this process is exported
 * under, or `undefined` when it names none.
 */
export const resourceRepositoryKey = (
  attributes: Readonly<Record<string, unknown>>,
): string | undefined => keyOfValue(attributes[ATTR_VCS_REPOSITORY_URL_FULL]);

/** The repository key one event's records carry. */
export const eventRepositoryKey = (
  event: CanonicalEvent,
  fallbackKey: string | undefined,
): string | undefined => {
  const stamped = event.contextAttributes?.[ATTR_VCS_REPOSITORY_URL_FULL];
  return stamped === undefined ? fallbackKey : keyOfValue(stamped);
};

/** The repository key one metric point carries. */
export const pointRepositoryKey = (
  point: MetricPoint,
  fallbackKey: string | undefined,
): string | undefined => {
  const stamped = point.attributes[ATTR_VCS_REPOSITORY_URL_FULL];
  return stamped === undefined ? fallbackKey : keyOfValue(stamped);
};

const restrictFacts = (
  facts: readonly ContentFact[] | undefined,
  mode: ContentMode,
  restrict: ContentRestrictor,
): ContentFact[] | undefined => facts?.map((fact) => restrict(fact, mode));

/** The event with every content fact it carries disclosed at most at `mode`. */
export const restrictEventContent = (
  event: CanonicalEvent,
  mode: ContentMode,
  restrict: ContentRestrictor,
): CanonicalEvent => {
  switch (event.type) {
    case "prompt.submitted":
      return event.content === undefined ? event : { ...event, content: restrict(event.content, mode) };
    case "generation.start": {
      const inputContent = restrictFacts(event.inputContent, mode, restrict);
      return inputContent === undefined ? event : { ...event, inputContent };
    }
    case "generation.end": {
      const outputContent = restrictFacts(event.outputContent, mode, restrict);
      return outputContent === undefined ? event : { ...event, outputContent };
    }
    case "tool.start":
      return event.input === undefined ? event : { ...event, input: restrict(event.input, mode) };
    case "tool.end":
      return event.output === undefined ? event : { ...event, output: restrict(event.output, mode) };
    case "error.raised":
      return event.message === undefined ? event : { ...event, message: restrict(event.message, mode) };
    default:
      return event;
  }
};

/** What one scoped destination is given of a batch, per signal. */
export type ScopedBatch = {
  readonly traces: readonly CanonicalEvent[];
  readonly logs: readonly CanonicalEvent[];
};

export type RouteEventsOptions = {
  /** Repository key of the exporter Resource, for events with no stamp of their own. */
  readonly resourceRepositoryKey?: string;
  readonly restrict: ContentRestrictor;
};

/**
 * Split a batch for one scoped destination.
 *
 * Each event is judged by its span's end edge when that end is in the same
 * batch (a span belongs to what was in force when it ended), otherwise by its
 * own stamp. When every event passes for both signals unchanged, the batch is
 * returned as the same array for both, so the sinks see one batch.
 */
export const routeEventsToScopes = (
  events: readonly CanonicalEvent[],
  scopes: readonly DestinationScope[],
  options: RouteEventsOptions,
): ScopedBatch => {
  const ends = spanEndEdgesOf(events);
  const traces: CanonicalEvent[] = [];
  const logs: CanonicalEvent[] = [];
  let unchanged = true;
  for (const event of events) {
    const anchor = ends.get(event.eventId) ?? event;
    const scope = matchDestinationScope(scopes, eventRepositoryKey(anchor, options.resourceRepositoryKey));
    if (scope === undefined || !scope.signals.traces || !scope.signals.logs) {
      unchanged = false;
    }
    if (scope === undefined) {
      continue;
    }
    const restricted =
      scope.contentMode === undefined ? event : restrictEventContent(event, scope.contentMode, options.restrict);
    if (restricted !== event) {
      unchanged = false;
    }
    if (scope.signals.traces) {
      traces.push(restricted);
    }
    if (scope.signals.logs) {
      logs.push(restricted);
    }
  }
  return unchanged ? { traces: events, logs: events } : { traces, logs };
};

/**
 * Metric points for one scoped destination.
 *
 * `pointsFor(includeSessionId)` yields the callback's points computed with or
 * without `session.id`; each point is taken from the variant its scope asks
 * for, so a scope that drops the session id never receives a per-session
 * series. Points whose repository no scope takes, or whose scope does not take
 * metrics, are dropped — one callback's points can therefore split across
 * destinations.
 */
export const routePointsToScopes = (
  scopes: readonly DestinationScope[],
  pointsFor: (includeSessionId: boolean) => readonly MetricPoint[] | undefined,
  options: {
    /** Repository key for points with no stamp of their own (context, then Resource). */
    readonly fallbackKey: string | undefined;
    /** The installation's `exporter.metrics.includeSessionId`; a scope can only turn it off. */
    readonly includeSessionId: boolean;
  },
): readonly MetricPoint[] => {
  const effective = (scope: DestinationScope): boolean => options.includeSessionId && scope.includeSessionId;
  const kept: MetricPoint[] = [];
  for (const variant of [true, false]) {
    if (!scopes.some((scope) => scope.signals.metrics && effective(scope) === variant)) {
      continue;
    }
    for (const point of pointsFor(variant) ?? []) {
      const scope = matchDestinationScope(scopes, pointRepositoryKey(point, options.fallbackKey));
      if (scope?.signals.metrics === true && effective(scope) === variant) {
        kept.push(point);
      }
    }
  }
  return kept;
};

/** Which `session.id` variants of the metric points a set of scopes needs. */
export const sessionIdVariantsFor = (
  scopes: readonly DestinationScope[],
  includeSessionId: boolean,
): ReadonlySet<boolean> =>
  new Set(
    scopes
      .filter((scope) => scope.signals.metrics)
      .map((scope) => includeSessionId && scope.includeSessionId),
  );
