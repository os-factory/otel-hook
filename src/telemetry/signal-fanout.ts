import type { DeliveryHealthSnapshot } from "../diagnostics/health.js";
import type { OtelHookErrorInfo } from "../errors/index.js";
import type { CanonicalEvent } from "../model/events.js";
import type { TelemetryEmitResult, TelemetrySink } from "../runtime/ports.js";
import type { OtlpLogTelemetrySink } from "./otlp-log-sink.js";
import type { OtlpTelemetrySink } from "./otlp-sink.js";
import type { SpanCorrelation, SpanCorrelationResolver } from "./semconv.js";

/**
 * One canonical batch, two OTLP signals.
 *
 * A hook has a single {@link TelemetrySink} seam, and both signals map the *same*
 * canonical events — so this fans one batch out rather than making the orchestrator
 * aware that there is more than one destination.
 *
 * ## Durability adds up across signals
 *
 * The counts are summed rather than taken from the primary signal, because the
 * caller's question is "may I commit this callback?" and the answer turns on whether
 * *anything* reached a collector or a spool. Summing gives `classifyDurability`
 * exactly the right inputs:
 *
 * - both signals delivered → `delivered`
 * - neither delivered → `lost`, and the callback is safe to retry precisely because
 *   there is nothing to duplicate
 * - one delivered and one did not → `partial`, which is terminal: retrying would
 *   re-export what the healthy signal already delivered, and a duplicate silently
 *   corrupts a total whereas a reported loss is a number somebody can act on
 *
 * A disabled sink accepts everything, so an installation with logs off behaves
 * exactly as it did before logs existed.
 *
 * ## Correlation must be resolved once per batch
 *
 * Both sinks want the same pairing facts, and `SpanCorrelator.correlateBatch` is not
 * a read — it records a start edge, marks a scope published, and takes the session
 * lock to do it. Wrap the correlator in {@link shareCorrelationPerBatch} and give
 * *the same wrapped function* to both sinks; `emit` here is sequential so the first
 * sink resolves it and the second is served the memoized answer.
 */

export type SignalFanoutOptions = {
  readonly traces: OtlpTelemetrySink;
  readonly logs: OtlpLogTelemetrySink;
};

export interface SignalFanoutSink extends TelemetrySink {
  /** One snapshot per wired signal, in a stable order: traces, then logs. */
  health(): readonly DeliveryHealthSnapshot[];
}

export const createSignalFanout = (options: SignalFanoutOptions): SignalFanoutSink => {
  const emit = async (events: readonly CanonicalEvent[]): Promise<TelemetryEmitResult> => {
    // Sequential, not concurrent: the first sink to ask resolves correlation, and
    // the second must be served that answer rather than race to start a second
    // resolution against the same state.
    const traces = await options.traces.emit(events);
    const logs = await options.logs.emit(events);
    const errors: readonly OtelHookErrorInfo[] = [...traces.errors, ...logs.errors];
    return {
      accepted: traces.accepted + logs.accepted,
      rejected: traces.rejected + logs.rejected,
      errors,
    };
  };

  const flush = async (): Promise<void> => {
    // Each signal's flush is already best-effort and non-throwing; awaiting both
    // unconditionally means a stuck logs endpoint cannot skip the trace flush.
    await options.traces.flush().catch(() => undefined);
    await options.logs.flush().catch(() => undefined);
  };

  const shutdown = async (): Promise<void> => {
    await options.traces.shutdown().catch(() => undefined);
    await options.logs.shutdown().catch(() => undefined);
  };

  return {
    emit,
    flush,
    shutdown,
    health: (): readonly DeliveryHealthSnapshot[] => [
      options.traces.health(),
      options.logs.health(),
    ],
  };
};

/**
 * Wrap a correlation resolver so one batch resolves at most once.
 *
 * Memoized on the identity of the `events` array, which is what makes it correct
 * without a reset: every batch is a distinct array, so a new batch cannot be served
 * a previous one's answer, and a retry of the *same* array deliberately is. A
 * scoped destination's share of the batch is served the batch's answer once it
 * is registered with `alias`. The promise is cached rather than its value, so two callers arriving before the first
 * resolution completes still share it.
 *
 * Exported because the one-call-per-batch property is a requirement of the
 * correlator, not a convenience of the fanout: a host wiring its own pair of sinks
 * needs to be able to express it too.
 */
export type SharedCorrelationResolver = SpanCorrelationResolver & {
  /**
   * Serve `subset` — a scoped destination's share of `batch`, possibly with
   * content-lowered copies of its events — the answer resolved for `batch`.
   * Correlations are looked up by scope, so the entries for events outside the
   * subset are inert; resolving the subset on its own would record its start
   * edges a second time. A no-op unless `batch` is the batch last resolved.
   */
  alias(subset: readonly CanonicalEvent[], batch: readonly CanonicalEvent[]): void;
};

export const shareCorrelationPerBatch = (
  correlate: SpanCorrelationResolver,
): SharedCorrelationResolver => {
  let pending:
    | {
        readonly events: readonly CanonicalEvent[];
        readonly aliases: Set<readonly CanonicalEvent[]>;
        readonly result: Promise<readonly SpanCorrelation[]>;
      }
    | undefined;
  const resolve = (events: readonly CanonicalEvent[]): Promise<readonly SpanCorrelation[]> => {
    if (pending !== undefined && (pending.events === events || pending.aliases.has(events))) {
      return pending.result;
    }
    const result = correlate(events);
    pending = { events, aliases: new Set(), result };
    return result;
  };
  const alias = (subset: readonly CanonicalEvent[], batch: readonly CanonicalEvent[]): void => {
    if (pending?.events === batch && subset !== batch) {
      pending.aliases.add(subset);
    }
  };
  return Object.assign(resolve, { alias });
};
