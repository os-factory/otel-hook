import type { OtelHookConfig } from "../config/schema.js";
import { summarizeHealth, type DeliveryHealthSnapshot, type OverallHealth } from "../diagnostics/health.js";
import { errorInfoFromThrown, type OtelHookErrorInfo } from "../errors/index.js";
import type { CanonicalEvent } from "../model/events.js";
import { createCallbackDeduplicator, type CallbackDeduplicator } from "../lifecycle/dedup.js";
import { createLifecycleJanitor, type LifecycleCleanupReport, type LifecycleJanitor } from "../lifecycle/janitor.js";
import { createSpanCorrelator, type SpanCorrelator } from "../lifecycle/span-correlator.js";
import {
  createUsageAccumulator,
  type UsageAccumulator,
  type UsageAccumulatorSnapshot,
} from "../lifecycle/usage-accumulator.js";
import { createPrivacyService, type PrivacyService } from "../privacy/service.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { createSystemClock } from "../runtime/clock.js";
import {
  createOtelHook,
  type HookIngestInput,
  type HookIngestOutcome,
  type OtelHook,
  type UsageObservation,
} from "../runtime/hook.js";
import { createDeterministicIdGenerator } from "../runtime/ids.js";
import { createNullLogger } from "../runtime/logger.js";
import type { Clock, IdGenerator, Logger, TelemetryEmitResult, TelemetrySink } from "../runtime/ports.js";
import { createFilesystemStateStore, type FilesystemStateStore } from "../state/filesystem-store.js";
import { createFileDurableSpool, type DurableSpool } from "../telemetry/durable-spool.js";
import { createOtlpTraceSink, type OtlpTelemetrySink } from "../telemetry/otlp-sink.js";

/**
 * A hook process lives for milliseconds and then exits, but the facts it needs
 * — the previous cumulative token baseline, the next sequence number, a running
 * per-scope rollup, which deliveries have already been handled — span a whole
 * session. This module is the wiring that makes those two facts coexist without
 * a daemon: filesystem-backed state, a filesystem spool for batches an
 * unreachable collector refused, and a *bounded* flush so a hanging collector
 * costs the host a known number of milliseconds rather than a stalled agent.
 *
 * ## Deliberate limitations
 *
 * 1. **Redelivery cannot be detected from the payload alone.** Some adapters
 *    derive `invocationId` from a clock reading (Claude Code documents this:
 *    each hook firing is a distinct invocation), so a redelivered payload
 *    produces a *different* invocation id in a later process. `eventId` is no
 *    better: it is seeded with the session sequence number, which has already
 *    advanced by the time a redelivery arrives. Deduplication is therefore
 *    offered only against an explicit, host-supplied delivery id
 *    ({@link HookProcessInput.delivery}) — the one identifier that is stable by
 *    construction. Without it, `process()` does not pretend to dedupe.
 * 2. **Cross-process span pairing is not applied to exported spans.** The
 *    {@link SpanCorrelator} is constructed and exposed, and can already tell a
 *    matched end from an orphaned one, but the OTLP mapping pairs a `*.start`
 *    with a `*.end` only within one batch. A lone edge is exported flagged
 *    `otelhook.span.paired=false` rather than being silently merged using a
 *    duration from state. Merging across processes is a telemetry-layer feature,
 *    not integration glue, so it is named here instead of half-done.
 */

export type HookRuntimeDelivery = {
  /**
   * Host-supplied identifier for *this* delivery of a hook callback. Stable
   * across a redelivery of the same callback, unique between distinct
   * callbacks. Nothing derives it: only the host knows it.
   */
  readonly callbackId: string;
  /** Namespace the id is unique within. Defaults to `"delivery"`. */
  readonly scope?: string;
};

export type HookProcessInput = HookIngestInput & {
  readonly delivery?: HookRuntimeDelivery;
};

export type HookProcessOutcome = {
  readonly ingest: HookIngestOutcome;
  /**
   * True when a matching delivery id had already been handled, so this
   * invocation's events were deliberately not exported. `ingest.emitted` is 0 in
   * that case; the provider's hook response is still produced normally, because
   * a redelivered callback still expects its protocol response.
   */
  readonly duplicateDelivery: boolean;
  /** Running per-scope totals after applying this invocation's deltas. */
  readonly usageRollups: readonly UsageRollup[];
  /** Cleanup performed opportunistically; absent when no sweep ran. */
  readonly cleanup?: LifecycleCleanupReport;
  /** Diagnostics raised by this module, in addition to `ingest.diagnostics`. */
  readonly diagnostics: readonly OtelHookErrorInfo[];
};

export type UsageRollup = {
  readonly scope: UsageObservation["scope"];
  readonly scopeKey: string;
  readonly snapshot: UsageAccumulatorSnapshot;
};

export type HookShutdownReport = {
  /** False when the bounded flush window elapsed before delivery finished. */
  readonly flushCompleted: boolean;
  readonly flushTimeoutMillis: number;
  readonly health: OverallHealth;
};

export interface HookRuntime {
  readonly hook: OtelHook;
  readonly config: OtelHookConfig;
  readonly stateStore: FilesystemStateStore;
  readonly sink: OtlpTelemetrySink;
  readonly spool?: DurableSpool;
  readonly privacy: PrivacyService;
  readonly deduplicator: CallbackDeduplicator;
  readonly usageAccumulator: UsageAccumulator;
  /** Exposed, not yet applied to exported spans — see this module's note 2. */
  readonly spanCorrelator: SpanCorrelator;
  readonly janitor: LifecycleJanitor;
  /** Ingest one observation, then apply lifecycle accumulation. Never throws. */
  process(input: HookProcessInput): Promise<HookProcessOutcome>;
  /** Bounded flush + shutdown. Never throws; idempotent. */
  shutdown(): Promise<HookShutdownReport>;
  health(): OverallHealth;
}

export type HookRuntimeOptions = {
  readonly config: OtelHookConfig;
  readonly registry: ProviderRegistry;
  /** Root of the state and spool trees. One directory per provider/installation below it. */
  readonly stateRootDir: string;
  /**
   * Namespace separating one deployment's state from another's. Not identity: it
   * never reaches an event, and no session or workspace is derived from it.
   */
  readonly installationId: string;
  /** State/spool namespace segment; the selected provider id, or a placeholder. */
  readonly providerNamespace: string;
  /** Exporter header *values*, deliberately absent from the config snapshot. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly logger?: Logger;
  readonly privacy?: PrivacyService;
  /** Upper bound on flush + shutdown. Default 2,000ms. */
  readonly flushTimeoutMillis?: number;
  /** Persist batches an unreachable collector refused. Default true. */
  readonly enableSpool?: boolean;
  /** Bounded lock waits keep a stuck peer from stalling the host. Default 1,000ms. */
  readonly stateLockTimeoutMillis?: number;
  /** Sweep expired lifecycle state when a session ends. Default true. */
  readonly sweepOnSessionEnd?: boolean;
  readonly lifecycleMaxAgeMillis?: number;
};

const DEFAULT_FLUSH_TIMEOUT_MILLIS = 2_000;
const DEFAULT_STATE_LOCK_TIMEOUT_MILLIS = 1_000;
const DEFAULT_LIFECYCLE_MAX_AGE_MILLIS = 24 * 60 * 60 * 1000;

const delay = (millis: number): Promise<"timeout"> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), millis);
    timer.unref?.();
  });

const containsSessionEnd = (events: readonly CanonicalEvent[]): boolean =>
  events.some((event) => event.type === "session.end");

/**
 * Sink wrapper that can be told, once per process, to stop exporting.
 *
 * Suppression happens here rather than before `ingest` on purpose: the adapter
 * still parses, so the provider's protocol response is still correct for a
 * redelivered callback, while the *telemetry* for it is dropped instead of
 * double-counted.
 */
const createSuppressibleSink = (
  inner: TelemetrySink,
  isSuppressed: () => boolean,
): TelemetrySink => ({
  emit: (events: readonly CanonicalEvent[]): Promise<TelemetryEmitResult> =>
    isSuppressed()
      ? Promise.resolve({ accepted: 0, rejected: 0, errors: [] })
      : inner.emit(events),
  flush: (): Promise<void> => inner.flush(),
  shutdown: (): Promise<void> => inner.shutdown(),
});

export const createHookRuntime = (options: HookRuntimeOptions): HookRuntime => {
  const clock = options.clock ?? createSystemClock();
  const ids = options.ids ?? createDeterministicIdGenerator();
  const logger = options.logger ?? createNullLogger();
  const privacy = options.privacy ?? createPrivacyService(options.config.privacy);
  const flushTimeoutMillis = options.flushTimeoutMillis ?? DEFAULT_FLUSH_TIMEOUT_MILLIS;
  const lifecycleMaxAge = options.lifecycleMaxAgeMillis ?? DEFAULT_LIFECYCLE_MAX_AGE_MILLIS;

  const stateStore = createFilesystemStateStore({
    rootDir: options.stateRootDir,
    providerId: options.providerNamespace,
    installationId: options.installationId,
    clock,
    logger,
    lockTimeoutMillis: options.stateLockTimeoutMillis ?? DEFAULT_STATE_LOCK_TIMEOUT_MILLIS,
  });

  const spool =
    options.enableSpool === false
      ? undefined
      : createFileDurableSpool({
          rootDir: options.stateRootDir,
          providerId: options.providerNamespace,
          installationId: options.installationId,
          clock,
          logger,
        });

  const sink = createOtlpTraceSink({
    exporter: options.config.exporter,
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    providerId: options.providerNamespace,
    installationId: options.installationId,
    clock,
    logger,
    ...(spool === undefined ? {} : { spool }),
  });

  let suppressExport = false;
  const hook = createOtelHook({
    sink: createSuppressibleSink(sink, () => suppressExport),
    stateStore,
    config: options.config,
    registry: options.registry,
    clock,
    ids,
    privacy,
    logger,
  });

  const deduplicator = createCallbackDeduplicator({ stateStore, clock });
  const usageAccumulator = createUsageAccumulator({ stateStore, clock });
  const spanCorrelator = createSpanCorrelator({ stateStore, clock });
  const janitor = createLifecycleJanitor({
    spanCorrelator,
    deduplicator,
    usageAccumulator,
    spanMaxAgeMillis: lifecycleMaxAge,
    dedupMaxAgeMillis: lifecycleMaxAge,
    usageMaxAgeMillis: lifecycleMaxAge,
  });

  const stateDiagnostic = (thrown: unknown): OtelHookErrorInfo =>
    errorInfoFromThrown(thrown, { code: "state-store-failure", phase: "state", occurredAt: clock.now() });

  const applyRollups = async (
    sessionId: string,
    observations: readonly UsageObservation[],
    diagnostics: OtelHookErrorInfo[],
  ): Promise<readonly UsageRollup[]> => {
    const rollups: UsageRollup[] = [];
    for (const observation of observations) {
      const key = { sessionId, scope: observation.scope, scopeKey: observation.scopeKey };
      try {
        if (observation.resetDetected) {
          // A restarted provider counter starts a new epoch rather than
          // deflating the running total (see createUsageAccumulator).
          await usageAccumulator.recordReset(key);
        }
        const snapshot = await usageAccumulator.accumulateDelta(key, observation.delta);
        rollups.push({ scope: observation.scope, scopeKey: observation.scopeKey, snapshot });
      } catch (thrown) {
        diagnostics.push(
          errorInfoFromThrown(thrown, {
            code: "usage-invalid",
            phase: "normalization",
            occurredAt: clock.now(),
          }),
        );
      }
    }
    return rollups;
  };

  const process_ = async (input: HookProcessInput): Promise<HookProcessOutcome> => {
    const diagnostics: OtelHookErrorInfo[] = [];
    let duplicateDelivery = false;

    if (input.delivery !== undefined) {
      try {
        const result = await deduplicator.checkAndMark(
          input.delivery.scope ?? "delivery",
          input.delivery.callbackId,
        );
        duplicateDelivery = result.duplicate;
      } catch (thrown) {
        // An unreadable dedup record must not drop telemetry: exporting a
        // possible duplicate is recoverable at the collector, losing a real
        // observation is not.
        diagnostics.push(stateDiagnostic(thrown));
      }
    }
    if (duplicateDelivery) {
      suppressExport = true;
      logger.info("delivery already handled; telemetry suppressed", {
        "delivery.callback_id_present": true,
      });
    }

    const { delivery, ...ingestInput } = input;
    void delivery;
    const ingest = await hook.ingest(ingestInput);

    let usageRollups: readonly UsageRollup[] = [];
    if (!duplicateDelivery && ingest.identity !== undefined && ingest.usageObservations.length > 0) {
      usageRollups = await applyRollups(
        ingest.identity.sessionId,
        ingest.usageObservations,
        diagnostics,
      );
    }

    let cleanup: LifecycleCleanupReport | undefined;
    if (
      (options.sweepOnSessionEnd ?? true) &&
      ingest.identity !== undefined &&
      containsSessionEnd(ingest.events)
    ) {
      try {
        cleanup = await janitor.runOnce(ingest.identity.sessionId);
      } catch (thrown) {
        diagnostics.push(stateDiagnostic(thrown));
      }
    }

    return {
      ingest,
      duplicateDelivery,
      usageRollups,
      ...(cleanup === undefined ? {} : { cleanup }),
      diagnostics,
    };
  };

  const snapshots = (): readonly DeliveryHealthSnapshot[] => [sink.health()];

  let shutdownReport: Promise<HookShutdownReport> | undefined;
  const shutdown = (): Promise<HookShutdownReport> => {
    shutdownReport ??= (async (): Promise<HookShutdownReport> => {
      const raced = await Promise.race([
        hook.shutdown().then(() => "completed" as const),
        delay(flushTimeoutMillis),
      ]);
      if (raced === "timeout") {
        // Not an error the host should ever feel: the batch is either spooled
        // for a later invocation or reported unhealthy, and either way the hook
        // returns within a bounded time.
        logger.warn("bounded flush window elapsed before delivery completed", {
          "shutdown.flush_timeout_millis": flushTimeoutMillis,
        });
      }
      return {
        flushCompleted: raced === "completed",
        flushTimeoutMillis,
        health: summarizeHealth(snapshots()),
      };
    })();
    return shutdownReport;
  };

  return {
    hook,
    config: options.config,
    stateStore,
    sink,
    ...(spool === undefined ? {} : { spool }),
    privacy,
    deduplicator,
    usageAccumulator,
    spanCorrelator,
    janitor,
    process: process_,
    shutdown,
    health: (): OverallHealth => summarizeHealth(snapshots()),
  };
};
