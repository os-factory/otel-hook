import type { Attributes } from "@opentelemetry/api";
import type { Resource } from "@opentelemetry/resources";

import type { CanonicalEvent, GenerationEndEvent } from "../model/events.js";
import type { CanonicalUsage } from "../model/usage.js";
import { resolveExportedSessionId } from "./export-identity.js";

/**
 * Metrics derived from hook events (issue #69).
 *
 * otel-hook already normalizes every provider's hook callbacks into canonical
 * events; this module turns one batch of those events into *observations* — a
 * value recorded against an instrument, with attributes. It is pure: it reads no
 * state and sends nothing. Aggregating observations into OTLP data points
 * (cumulative across processes, or delta per batch) and exporting them are the
 * jobs of `lifecycle/metric-series.ts` and `otlp-metric-sink.ts`.
 *
 * ## Why observations come from the runtime's accounting, not from the events alone
 *
 * Token usage is taken from the orchestrator's `UsageObservation` deltas rather than
 * from `generation.end.usage` directly. A provider that reports a session-wide
 * running total (Codex) stamps the *cumulative* figure on every turn; summing those
 * into a histogram would bill a three-turn session several times over. The
 * orchestrator already diffs them against a persisted baseline, exactly once per
 * delivery, so the metric reuses that answer.
 *
 * ## What is never on a metric
 *
 * No account identity (`user.*`, `enduser.*`, `organization.id`), no content, no
 * paths, and no per-event ids (`otelhook.event.id`, tool-call ids, generation ids):
 * an id per data point is a new series per data point. `session.id` is the one
 * high-cardinality attribute, and it can be switched off.
 */

/** Recommended bucket boundaries from the GenAI semantic conventions. */
export const TOKEN_USAGE_BUCKETS: readonly number[] = Object.freeze([
  1, 4, 16, 64, 256, 1_024, 4_096, 16_384, 65_536, 262_144, 1_048_576, 4_194_304, 16_777_216,
  67_108_864,
]);
export const OPERATION_DURATION_BUCKETS: readonly number[] = Object.freeze([
  0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92,
]);

export const METRIC_TOKEN_USAGE = "gen_ai.client.token.usage";
export const METRIC_OPERATION_DURATION = "gen_ai.client.operation.duration";
export const METRIC_SESSIONS = "otelhook.sessions";
export const METRIC_TOOL_CALLS = "otelhook.tool.calls";
export const METRIC_COST_USAGE = "otelhook.cost.usage";

export type MetricInstrumentName =
  | typeof METRIC_TOKEN_USAGE
  | typeof METRIC_OPERATION_DURATION
  | typeof METRIC_SESSIONS
  | typeof METRIC_TOOL_CALLS
  | typeof METRIC_COST_USAGE;

export type MetricInstrument = {
  readonly name: MetricInstrumentName;
  readonly kind: "histogram" | "counter";
  readonly unit: string;
  readonly description: string;
  /** Integer values (`asInt`) or doubles. Histograms always carry a double sum. */
  readonly valueType: "int" | "double";
  /** Histograms only. */
  readonly boundaries?: readonly number[];
};

export const METRIC_INSTRUMENTS: Readonly<Record<MetricInstrumentName, MetricInstrument>> = Object.freeze({
  [METRIC_TOKEN_USAGE]: {
    name: METRIC_TOKEN_USAGE,
    kind: "histogram",
    unit: "{token}",
    description: "Tokens used per generation, by token type (hook-derived)",
    valueType: "int",
    boundaries: TOKEN_USAGE_BUCKETS,
  },
  [METRIC_OPERATION_DURATION]: {
    name: METRIC_OPERATION_DURATION,
    kind: "histogram",
    unit: "s",
    description: "Generation duration, from its start hook to its end hook (hook-derived)",
    valueType: "double",
    boundaries: OPERATION_DURATION_BUCKETS,
  },
  [METRIC_SESSIONS]: {
    name: METRIC_SESSIONS,
    kind: "counter",
    unit: "{session}",
    description: "Agent sessions started",
    valueType: "int",
  },
  [METRIC_TOOL_CALLS]: {
    name: METRIC_TOOL_CALLS,
    kind: "counter",
    unit: "{call}",
    description: "Completed tool calls, by tool name and outcome",
    valueType: "int",
  },
  [METRIC_COST_USAGE]: {
    name: METRIC_COST_USAGE,
    kind: "counter",
    unit: "USD",
    description: "Cost reported by the provider; never estimated",
    valueType: "double",
  },
});

export const isMetricInstrumentName = (value: unknown): value is MetricInstrumentName =>
  typeof value === "string" && Object.hasOwn(METRIC_INSTRUMENTS, value);

export const ATTR_GEN_AI_TOKEN_TYPE = "gen_ai.token.type";
export const ATTR_GEN_AI_PROVIDER_NAME = "gen_ai.provider.name";
const ATTR_GEN_AI_OPERATION_NAME = "gen_ai.operation.name";
const ATTR_GEN_AI_REQUEST_MODEL = "gen_ai.request.model";
const ATTR_GEN_AI_RESPONSE_MODEL = "gen_ai.response.model";
const ATTR_GEN_AI_TOOL_NAME = "gen_ai.tool.name";
const ATTR_ERROR_TYPE = "error.type";
const ATTR_SESSION_ID = "session.id";
const ATTR_OTELHOOK_PROVIDER_ID = "otelhook.provider.id";
const ATTR_OTELHOOK_OUTCOME = "otelhook.outcome";
const ATTR_OTELHOOK_SESSION_KIND = "otelhook.session.kind";

/**
 * Token types on `gen_ai.client.token.usage`.
 *
 * `input` is inclusive of cache reads, as the GenAI conventions define
 * `gen_ai.usage.input_tokens`. `cache_read` and `cache_creation` are extra series
 * describing parts of the input; summing every token type double-counts.
 */
export type TokenType = "input" | "output" | "cache_read" | "cache_creation";

export type MetricsTemporality = "cumulative" | "delta";

/** One recorded value. */
export type MetricObservation = {
  readonly instrument: MetricInstrumentName;
  readonly value: number;
  /** Data-point attributes. Primitives only. */
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
  /** When the observed thing happened, in epoch milliseconds. */
  readonly timeMillis: number;
  /** Provider session the observation belongs to; scopes cumulative state. */
  readonly sessionId: string;
};

/** A start time recovered for a generation, by generation id. */
export type GenerationStart = {
  readonly startMillis: number;
  readonly requestModel?: string;
};

/** The usage delta the orchestrator derived for one usage-bearing event. */
export type MetricUsageInput = {
  readonly eventId: string;
  readonly scope: string;
  readonly delta: CanonicalUsage;
};

export type DeriveMetricObservationsInput = {
  readonly events: readonly CanonicalEvent[];
  readonly usage: readonly MetricUsageInput[];
  /** The exported resource; supplies the launcher's `session.id` when it sets one. */
  readonly resource: Resource;
  /** Put `session.id` on every data point. Default true. */
  readonly includeSessionId?: boolean;
  /**
   * Start times for generations whose start edge is not in this batch (it was
   * recorded by an earlier hook process). Looked up by generation id.
   */
  readonly generationStarts?: (generationId: string) => GenerationStart | undefined;
  /**
   * When the session's current turn began: the last `prompt.submitted` recorded,
   * by an earlier callback or this one. The fallback duration source for
   * providers whose generation is a turn (Claude Code, Codex).
   */
  readonly turnStart?: (sessionId: string) => number | undefined;
};

const commonAttributes = (
  event: CanonicalEvent,
  resource: Resource,
  includeSessionId: boolean,
): Record<string, string | number | boolean> => ({
  [ATTR_OTELHOOK_PROVIDER_ID]: event.provenance.providerId,
  ...(includeSessionId
    ? { [ATTR_SESSION_ID]: resolveExportedSessionId(event.sessionId, resource).sessionId }
    : {}),
});

const generationAttributes = (
  end: GenerationEndEvent,
  requestModel: string | undefined,
): Record<string, string> => ({
  [ATTR_GEN_AI_OPERATION_NAME]: "chat",
  ...(end.model.vendor === undefined ? {} : { [ATTR_GEN_AI_PROVIDER_NAME]: end.model.vendor }),
  [ATTR_GEN_AI_REQUEST_MODEL]: requestModel ?? end.model.modelId,
  [ATTR_GEN_AI_RESPONSE_MODEL]: end.model.modelId,
});

const TOKEN_FIELDS: readonly (readonly [TokenType, (usage: CanonicalUsage) => number])[] = [
  ["input", (usage) => usage.inputTokens],
  ["output", (usage) => usage.outputTokens],
  ["cache_read", (usage) => usage.cachedInputTokens],
  ["cache_creation", (usage) => usage.cacheCreationInputTokens],
];

const isFailedOutcome = (outcome: string): boolean =>
  outcome !== "ok" && outcome !== "unknown" && outcome !== "cancelled";

/**
 * Observations for one batch.
 *
 * - `otelhook.sessions`: one per `session.start`.
 * - `otelhook.tool.calls`: one per `tool.end`.
 * - `gen_ai.client.operation.duration`: one per `generation.end` whose duration is
 *   known, from the first source that has it:
 *   1. the duration the provider stated (`durationMillis`);
 *   2. a `generation.start` recorded by an *earlier* callback;
 *   3. the turn's start: the last `prompt.submitted` of the session, no later than
 *      the end. For Claude Code and Codex a generation is a turn, so this is the
 *      turn's wall-clock time, tool calls included.
 *   A `generation.start` in the *same* batch as its end is not a start: an
 *   adapter that emits both from one callback (Claude Code's `Stop`) synthesized
 *   it, and measuring from it would record a zero.
 * - `gen_ai.client.token.usage`: per generation-scoped usage delta, one per token
 *   type. A zero `cache_read` / `cache_creation` is not recorded: a provider that
 *   never reports cache tokens would otherwise fill the low bucket with zeros.
 *   `input` and `output` are always recorded, zero included, so the count of a
 *   token histogram is the number of generations with usage.
 * - `otelhook.cost.usage`: per `generation.end` with a provider-reported USD cost.
 */
export const deriveMetricObservations = (
  input: DeriveMetricObservationsInput,
): readonly MetricObservation[] => {
  const includeSessionId = input.includeSessionId ?? true;
  const observations: MetricObservation[] = [];
  const byId = new Map<string, CanonicalEvent>();
  const startsInBatch = new Map<string, GenerationStart>();
  for (const event of input.events) {
    byId.set(event.eventId, event);
    if (event.type === "generation.start") {
      startsInBatch.set(event.generationId, {
        startMillis: event.occurredAt,
        requestModel: event.model.modelId,
      });
    }
  }
  // Request model only: a start in this batch says what was asked for, but not when.
  const requestModelOf = (generationId: string): string | undefined =>
    startsInBatch.get(generationId)?.requestModel ?? input.generationStarts?.(generationId)?.requestModel;
  let lastPromptInBatch: Map<string, number> | undefined;
  for (const event of input.events) {
    if (event.type === "prompt.submitted") {
      lastPromptInBatch ??= new Map();
      lastPromptInBatch.set(event.sessionId, Math.max(lastPromptInBatch.get(event.sessionId) ?? 0, event.occurredAt));
    }
  }
  const measuredDurationOf = (end: GenerationEndEvent): number | undefined => {
    if (end.durationMillis !== undefined) {
      return end.durationMillis;
    }
    const recovered = startsInBatch.has(end.generationId) ? undefined : input.generationStarts?.(end.generationId);
    if (recovered !== undefined) {
      return end.occurredAt - recovered.startMillis;
    }
    const turn = lastPromptInBatch?.get(end.sessionId) ?? input.turnStart?.(end.sessionId);
    return turn === undefined || turn > end.occurredAt ? undefined : end.occurredAt - turn;
  };

  const push = (
    event: CanonicalEvent,
    instrument: MetricInstrumentName,
    value: number,
    attributes: Record<string, string | number | boolean>,
  ): void => {
    if (!Number.isFinite(value) || value < 0) {
      return;
    }
    observations.push({
      instrument,
      value,
      attributes: { ...commonAttributes(event, input.resource, includeSessionId), ...attributes },
      timeMillis: event.occurredAt,
      sessionId: event.sessionId,
    });
  };

  for (const event of input.events) {
    switch (event.type) {
      case "session.start":
        push(event, METRIC_SESSIONS, 1, { [ATTR_OTELHOOK_SESSION_KIND]: event.sessionKind });
        break;
      case "tool.end":
        push(event, METRIC_TOOL_CALLS, 1, {
          [ATTR_GEN_AI_TOOL_NAME]: event.toolName,
          [ATTR_OTELHOOK_OUTCOME]: event.outcome,
        });
        break;
      case "generation.end": {
        const attributes = generationAttributes(event, requestModelOf(event.generationId));
        const durationMillis = measuredDurationOf(event);
        if (durationMillis !== undefined && durationMillis >= 0) {
          push(event, METRIC_OPERATION_DURATION, durationMillis / 1000, {
            ...attributes,
            ...(isFailedOutcome(event.outcome) ? { [ATTR_ERROR_TYPE]: event.outcome } : {}),
          });
        }
        if (
          event.cost !== undefined &&
          event.cost.source === "provider-reported" &&
          event.cost.currency === "USD"
        ) {
          push(event, METRIC_COST_USAGE, event.cost.amount, attributes);
        }
        break;
      }
      default:
        break;
    }
  }

  for (const observation of input.usage) {
    if (observation.scope !== "generation") {
      // Session totals and subagent rollups restate generation spend; counting them
      // too would double it.
      continue;
    }
    const event = byId.get(observation.eventId);
    if (event?.type !== "generation.end") {
      continue;
    }
    const attributes = generationAttributes(event, requestModelOf(event.generationId));
    for (const [tokenType, read] of TOKEN_FIELDS) {
      const value = read(observation.delta);
      if (value === 0 && (tokenType === "cache_read" || tokenType === "cache_creation")) {
        continue;
      }
      push(event, METRIC_TOKEN_USAGE, value, { ...attributes, [ATTR_GEN_AI_TOKEN_TYPE]: tokenType });
    }
  }
  return observations;
};

/** Accumulated histogram state for one series. */
export type HistogramState = {
  readonly count: number;
  readonly sum: number;
  readonly min: number;
  readonly max: number;
  /** One more entry than the instrument's boundaries. */
  readonly bucketCounts: readonly number[];
};

/**
 * One OTLP data point, as plain JSON so it can be spooled.
 *
 * A point is self-describing: the instrument, its temporality, and its interval.
 * A cumulative point is a snapshot of a running total, so resending one (from a
 * spool) restates a value rather than adding to it.
 */
export type MetricPoint = {
  readonly instrument: MetricInstrumentName;
  readonly temporality: MetricsTemporality;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
  readonly startTimeMillis: number;
  readonly timeMillis: number;
  /** Counters. */
  readonly value?: number;
  /** Histograms. */
  readonly histogram?: HistogramState;
};

export const emptyHistogram = (boundaries: readonly number[]): HistogramState => ({
  count: 0,
  sum: 0,
  min: Number.POSITIVE_INFINITY,
  max: Number.NEGATIVE_INFINITY,
  bucketCounts: new Array<number>(boundaries.length + 1).fill(0),
});

/** OTLP explicit buckets: bucket `i` holds values in `(boundaries[i-1], boundaries[i]]`. */
export const bucketIndex = (boundaries: readonly number[], value: number): number => {
  for (let index = 0; index < boundaries.length; index += 1) {
    const bound = boundaries[index];
    if (bound !== undefined && value <= bound) {
      return index;
    }
  }
  return boundaries.length;
};

export const recordIntoHistogram = (
  state: HistogramState,
  boundaries: readonly number[],
  value: number,
): HistogramState => {
  const bucketCounts = [...state.bucketCounts];
  const index = bucketIndex(boundaries, value);
  bucketCounts[index] = (bucketCounts[index] ?? 0) + 1;
  return {
    count: state.count + 1,
    sum: state.sum + value,
    min: Math.min(state.min, value),
    max: Math.max(state.max, value),
    bucketCounts,
  };
};

/**
 * Stable identity of a series: instrument plus sorted attributes.
 *
 * Used as a map key and, digested, as a state key. JSON of sorted entries is
 * unambiguous where a joined string would not be.
 */
export const seriesIdentity = (
  instrument: MetricInstrumentName,
  attributes: Readonly<Record<string, string | number | boolean>>,
): string =>
  JSON.stringify([
    instrument,
    Object.entries(attributes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  ]);

/**
 * Delta points for one batch: observations of the same series folded together,
 * over the interval from the earliest observation to `nowMillis`.
 */
export const aggregateDeltaPoints = (
  observations: readonly MetricObservation[],
  nowMillis: number,
): readonly MetricPoint[] => {
  const series = new Map<
    string,
    { observation: MetricObservation; start: number; value: number; histogram?: HistogramState }
  >();
  for (const observation of observations) {
    const instrument = METRIC_INSTRUMENTS[observation.instrument];
    const key = seriesIdentity(observation.instrument, observation.attributes);
    const existing =
      series.get(key) ??
      ({
        observation,
        start: observation.timeMillis,
        value: 0,
        ...(instrument.boundaries === undefined ? {} : { histogram: emptyHistogram(instrument.boundaries) }),
      });
    existing.start = Math.min(existing.start, observation.timeMillis);
    if (existing.histogram !== undefined && instrument.boundaries !== undefined) {
      existing.histogram = recordIntoHistogram(existing.histogram, instrument.boundaries, observation.value);
    } else {
      existing.value += observation.value;
    }
    series.set(key, existing);
  }
  return [...series.values()].map((entry) => ({
    instrument: entry.observation.instrument,
    temporality: "delta",
    attributes: entry.observation.attributes,
    startTimeMillis: Math.min(entry.start, nowMillis),
    timeMillis: Math.max(nowMillis, entry.start),
    ...(entry.histogram === undefined ? { value: entry.value } : { histogram: entry.histogram }),
  }));
};

/** Data-point attribute keys that must never appear on a metric. */
export const FORBIDDEN_METRIC_ATTRIBUTE_PREFIXES: readonly string[] = Object.freeze([
  "user.",
  "enduser.",
  "organization.",
]);

/** Strip anything account-shaped from attributes, as a last line of defence. */
export const withoutAccountIdentity = (attributes: Attributes): Attributes =>
  Object.fromEntries(
    Object.entries(attributes).filter(
      ([key]) => !FORBIDDEN_METRIC_ATTRIBUTE_PREFIXES.some((prefix) => key.startsWith(prefix)),
    ),
  );
