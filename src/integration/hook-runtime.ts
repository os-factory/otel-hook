import type { OtelHookConfig } from "../config/schema.js";
import { summarizeHealth, type DeliveryHealthSnapshot, type OverallHealth } from "../diagnostics/health.js";
import { createErrorInfo, errorInfoFromThrown, type OtelHookErrorInfo } from "../errors/index.js";
import type { CanonicalEvent } from "../model/events.js";
import {
  createCallbackDeduplicator,
  type CallbackDeduplicator,
  type DeliveryClaimOutcome,
} from "../lifecycle/dedup.js";
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
  isCommittable,
  type HookIngestInput,
  type HookIngestOutcome,
  type OtelHook,
  type UsageObservation,
} from "../runtime/hook.js";
import {
  hostDeliveryIdentity,
  type DeliveryOrigin,
  type DeliveryResolution,
  type DeliveryUnavailableReason,
  type ResolvedDeliveryIdentity,
} from "../runtime/delivery.js";
import { createDeterministicIdGenerator } from "../runtime/ids.js";
import { createNullLogger } from "../runtime/logger.js";
import type { Clock, IdGenerator, Logger } from "../runtime/ports.js";
import { createAsyncLock } from "../state/async-lock.js";
import { createFilesystemStateStore, type FilesystemStateStore } from "../state/filesystem-store.js";
import {
  createFileDurableLogSpool,
  type DurableLogSpool,
} from "../telemetry/durable-log-spool.js";
import { createFileDurableSpool, type DurableSpool } from "../telemetry/durable-spool.js";
import { createOtlpLogSink, type OtlpLogTelemetrySink } from "../telemetry/otlp-log-sink.js";
import { createOtlpTraceSink, type OtlpTelemetrySink } from "../telemetry/otlp-sink.js";
import {
  createSignalFanout,
  shareCorrelationPerBatch,
} from "../telemetry/signal-fanout.js";

/**
 * A hook process lives for milliseconds and then exits, but the facts it needs
 * — the previous cumulative token baseline, the next sequence number, a running
 * per-scope rollup, which deliveries have already been handled — span a whole
 * session. This module is the wiring that makes those two facts coexist without
 * a daemon: filesystem-backed state, a filesystem spool for batches an
 * unreachable collector refused, and a *bounded* flush so a hanging collector
 * costs the host a known number of milliseconds rather than a stalled agent.
 *
 * ## Delivery deduplication
 *
 * A redelivered callback must not be exported or accounted twice, and it must
 * stay suppressed across a process restart — which rules out anything held in
 * memory. Two identities can carry that:
 *
 * 1. An explicit, host-supplied delivery id ({@link HookProcessInput.delivery}),
 *    unique by construction because only the host knows it.
 * 2. One normalized from payload fields the selected adapter vouches for — a
 *    `tool_use_id`, an `agent_id`, a `prompt_id`. Adapters declare coverage as
 *    `deliveryIdentifier` and report components per callback, and the runtime
 *    digests them into an opaque, installation-and-session-scoped pair.
 *
 * Neither `invocationId` nor `eventId` can serve: some adapters seed the former
 * with a clock reading (Claude Code documents each hook firing as a distinct
 * invocation), and the latter is seeded with a session sequence number that has
 * already advanced by the time a redelivery arrives.
 *
 * Ownership is taken *before* `ingest` and committed only once the batch is
 * somewhere durable: a delivery arriving inside the window sees the claim and
 * stands down, and a batch that reached neither the collector nor the spool
 * releases its claim for retry instead of committing a loss.
 *
 * **This is at-least-once export, not exactly-once.** The collector is a separate
 * system and there is no transaction spanning an OTLP acceptance and a local state
 * write, so a process killed after the collector took a batch and before the claim
 * commits will re-export on redelivery. That ordering is deliberate: a duplicate
 * carries the same derived trace and span id and can be dropped at the collector,
 * whereas committing first would turn the same window into silent loss. Local
 * accounting *is* at-most-once, because it commits under the claim's own lock.
 *
 * ## Ordering and locks
 *
 * Two locks, always acquired in one order — delivery-scope lock, then state lock —
 * and never nested one state lock inside another:
 *
 * - An in-process lock on the delivery scope serializes same-scope deliveries in
 *   arrival order, so deduplication never reorders what it lets through.
 * - `ingest` holds the store's *cross-process* session lock across the session
 *   state critical section, which is what stops two hook processes from stamping
 *   two batches with one sequence range. Export happens after that lock is
 *   released: the span correlator takes the same session lock from inside the sink,
 *   and it is not reentrant.
 *
 * ## Deliberate limitations
 *
 * 1. **Deduplication coverage is per provider, and partial for every adapter.** An
 *    adapter that declares `deliveryIdentifier: "partial"` identifies only the
 *    callbacks carrying a field that separates a genuine second firing from a
 *    redelivery — for most that means per-tool-call and per-subagent edges, and for
 *    the Gemini CLI, whose protocol has no such field at all, only the
 *    once-per-session edges. The rest are exported without the at-most-once
 *    guarantee unless the host supplies a delivery id; with `requireCallbackId` the
 *    runtime says so per callback instead of leaving it to be inferred.
 * 2. **Cross-process span pairing needs a durable state root.** The
 *    {@link SpanCorrelator} is wired into the sink, so a `*.end` emitted by a
 *    later process carries its start time, duration, parent, and start-only
 *    attributes. That correlation lives entirely in the state store: point two
 *    invocations at different `stateRootDir`s and each exports a lone,
 *    explicitly classified orphan instead. A disabled exporter records nothing,
 *    since there is no span to pair.
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

/**
 * What deduplication did with this callback.
 *
 * Reported rather than inferred: "exported once because it was fresh" and
 * "exported once because nothing could tell it apart from a redelivery" produce
 * identical telemetry, and only the first is a guarantee.
 */
export type DeliveryReport = {
  /**
   * True when a replay-stable identity was established and a claim enforced.
   *
   * Not a promise of exactly-once export: see this module's note on crash
   * semantics. It means a redelivery arriving *while local state is intact* is
   * suppressed.
   */
  readonly deduplicated: boolean;
  /** Where the identity came from. Absent when none was established. */
  readonly origin?: DeliveryOrigin;
  /** How the claim resolved. Absent when no identity was established. */
  readonly outcome?: DeliveryClaimOutcome;
  /** Why no identity was established. Absent when one was. */
  readonly reason?: DeliveryUnavailableReason;
  /** The adapter's declared coverage, when a provider was selected. */
  readonly capability?: string;
  /**
   * The provider's own name for the callback that could not be identified.
   *
   * Present only alongside `reason`. Coverage is per callback, so a host auditing
   * its own gaps needs the callback name to act on the report at all — the
   * provider id and the capability are the same for every one of them.
   */
  readonly sourceEventName?: string;
  /**
   * The adapter's own account of why this callback has no identity, and what field
   * would close the gap. Absent when the adapter documents none.
   */
  readonly detail?: string;
  /** Adapter-supplied justifications for a provider-derived identity. */
  readonly evidence?: readonly string[];
  /**
   * True when a claim was released because the batch reached neither the
   * collector nor the spool, so redelivering this callback is expected to
   * re-export it rather than be suppressed.
   */
  readonly retryable?: boolean;
  /**
   * Spans permanently lost on a callback that is nonetheless **committed**.
   *
   * Present only for a partial batch: some spans reached the collector or the
   * spool and some did not. The callback is not retried, because retrying would
   * re-export the accepted spans, so these observations are gone. Reported as a
   * number rather than folded into `retryable` because the two demand opposite
   * responses — a retryable callback needs redelivering, a partial loss needs
   * investigating.
   */
  readonly partialLoss?: number;
  /**
   * True when another process reclaimed this callback's claim before this one
   * committed.
   *
   * Deduplication did not hold for this callback: both deliveries may have
   * exported it. Reported rather than hidden, because the cause is a
   * configured stale window that is too short for this installation and only an
   * operator can fix that.
   */
  readonly superseded?: boolean;
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
  /** Why this callback was, or was not, deduplicated. */
  readonly delivery: DeliveryReport;
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
  /** The traces signal. Named `sink` because it is the one every installation has. */
  readonly sink: OtlpTelemetrySink;
  /** The logs signal. A no-op sink unless `exporter.logs.enabled` is set. */
  readonly logSink: OtlpLogTelemetrySink;
  readonly spool?: DurableSpool;
  /** Retry queue for the logs signal. Absent when spooling or logs are disabled. */
  readonly logSpool?: DurableLogSpool;
  readonly privacy: PrivacyService;
  readonly deduplicator: CallbackDeduplicator;
  readonly usageAccumulator: UsageAccumulator;
  /** Backs the cross-process pairing the sink applies to every exported span. */
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
  /**
   * Normalize a delivery identity from the adapter when the host supplies none.
   * Default true. Set false to keep deduplication strictly opt-in per callback.
   */
  readonly deriveDeliveryIdentity?: boolean;
  /**
   * Raise `delivery-identifier-unavailable` for every callback that could not be
   * deduplicated, naming the provider and the capability that is missing. Default
   * false: without it, an unidentifiable callback is a silent absence of a
   * guarantee, which is exactly what a host auditing its own coverage cannot see.
   */
  readonly requireCallbackId?: boolean;
  /**
   * How long an uncommitted claim is respected before a later delivery may
   * assume the process that took it died. Default 60,000ms.
   */
  readonly staleClaimMillis?: number;
  /** TTL for dedup records specifically. Defaults to `lifecycleMaxAgeMillis`. */
  readonly deliveryRetentionMillis?: number;
};

const DEFAULT_FLUSH_TIMEOUT_MILLIS = 2_000;
const DEFAULT_STATE_LOCK_TIMEOUT_MILLIS = 1_000;
const DEFAULT_LIFECYCLE_MAX_AGE_MILLIS = 24 * 60 * 60 * 1000;
const DEFAULT_STALE_CLAIM_MILLIS = 60_000;

const delay = (millis: number): Promise<"timeout"> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), millis);
    timer.unref?.();
  });

const containsSessionEnd = (events: readonly CanonicalEvent[]): boolean =>
  events.some((event) => event.type === "session.end");

/** Delivery is this module's own concern; `ingest` never sees it. */
const withoutDelivery = (input: HookProcessInput): HookIngestInput => {
  const { delivery, ...ingestInput } = input;
  void delivery;
  return ingestInput;
};

/**
 * Smallest stale-claim window that cannot expire while a live process is still
 * working on the callback it claimed.
 *
 * A claim is taken before `ingest` and committed after export, so the window has
 * to cover the whole of that: waiting for the session state lock, the adapter's
 * work, then every export attempt the exporter policy permits, then the bounded
 * flush. If `staleClaimMillis` is shorter than that, a second delivery arriving
 * mid-flight declares the first one abandoned and *reclaims* it — and then both
 * processes export the same callback. That is not a smaller guarantee, it is the
 * opposite of the one being advertised, produced by a configuration value that
 * looks like a harmless tuning knob.
 *
 * So the floor is derived from the same policy the work is bounded by, rather
 * than being a constant that a later timeout change could silently outgrow. The
 * multiplier on the export timeout counts the first attempt plus each retry.
 */
/**
 * Bounded lock acquisitions between `claim` and `commit`, counted rather than
 * guessed.
 *
 * Each one can cost a full `stateLockTimeoutMillis` under contention, so the floor
 * has to include all of them. Enumerated so that adding a locked step without
 * revisiting this number is visibly an omission:
 *
 * 1. `ingest` phase 1 — the session-state critical section (read sequence, parse,
 *    reserve).
 * 2. `ingest` phase 3 — the usage-accounting critical section.
 * 3. the span correlator, called from inside the sink during export.
 * 4. `deduplicator.commit` itself.
 */
const POST_CLAIM_LOCK_ACQUISITIONS = 4;

/**
 * Locked operations the *accounting* phase performs, per usage observation.
 *
 * `recordReset` then `accumulateDelta`, each taking the session lock on its own.
 * Multiplied by the observation cap below rather than by the raw event limit: usage
 * lands on end-edge events only, so the cap is generous rather than exact.
 */
const ACCOUNTING_LOCKS_PER_OBSERVATION = 2;

/**
 * How many usage observations the floor budgets for.
 *
 * Deliberately not `limits.maxEventsPerInvocation` (512 by default): summing 1,024
 * lock timeouts would put the floor in the tens of minutes, and a floor that large
 * is its own problem — it delays recovery of genuinely crashed claims by that long.
 * A real hook callback carries a handful of usage-bearing events, so this is the
 * conservative-but-useful bound, and the ownership check below is what covers the
 * case where reality exceeds it: a claim reclaimed under a live holder is *detected*
 * at commit rather than silently double-counted.
 */
const BUDGETED_USAGE_OBSERVATIONS = 8;

/**
 * Smallest stale-claim window that cannot expire while a live process is still
 * working on the callback it claimed.
 *
 * A claim is taken before `ingest` and committed after accounting, so the window has
 * to cover the whole of that: every bounded lock acquisition on the way, every
 * export attempt the exporter policy permits, the spool write that follows a refused
 * export, and the bounded flush. If `staleClaimMillis` is shorter, a second delivery
 * arriving mid-flight declares the first one abandoned and *reclaims* it — and then
 * both processes export the same callback. That is not a smaller guarantee, it is
 * the opposite of the one being advertised, produced by a value that looks like a
 * harmless tuning knob.
 *
 * Derived from the same policy the work is bounded by, rather than a constant a
 * later timeout change could silently outgrow. It is a *floor*, not a prediction:
 * being generous costs only recovery latency after a crash, while being short costs
 * correctness.
 */
export const minimumStaleClaimMillis = (input: {
  readonly exportTimeoutMillis: number;
  readonly maxRetryAttempts: number;
  readonly flushTimeoutMillis: number;
  readonly stateLockTimeoutMillis: number;
}): number => {
  const exportBudget = input.exportTimeoutMillis * (input.maxRetryAttempts + 1);
  const lockBudget =
    input.stateLockTimeoutMillis *
    (POST_CLAIM_LOCK_ACQUISITIONS +
      ACCOUNTING_LOCKS_PER_OBSERVATION * BUDGETED_USAGE_OBSERVATIONS);
  // A refused export writes the batch to the spool before returning, and the
  // janitor may sweep on a session-end callback. Both are bounded but neither has
  // its own configured timeout, so they share one allowance.
  const spoolAndSweepAllowance = 2 * input.stateLockTimeoutMillis;
  // A margin so a value derived from the same numbers is not exactly on the
  // boundary; process scheduling alone can cost tens of milliseconds.
  const margin = 1_000;
  return lockBudget + exportBudget + input.flushTimeoutMillis + spoolAndSweepAllowance + margin;
};

const DELIVERY_UNAVAILABLE_DETAIL: Readonly<Record<DeliveryUnavailableReason, string>> =
  Object.freeze({
    "provider-unattributed":
      "no provider was attributed, so no adapter could vouch for a replay-stable identifier",
    "provider-declares-none":
      "the selected adapter declares deliveryIdentifier=none: no callback of this provider carries a replay-stable identifier, so only --callback-id can deduplicate it",
    "callback-not-identifiable":
      "the selected adapter identifies some callbacks but not this one; it carries no field that separates a redelivery from a genuine second firing",
    "claim-rejected":
      "the selected adapter offered a delivery identity that failed the contract's own guards",
    "state-unavailable":
      "a delivery identity was established but the state store could not record a claim against it",
  });

export const createHookRuntime = (options: HookRuntimeOptions): HookRuntime => {
  const clock = options.clock ?? createSystemClock();
  const ids = options.ids ?? createDeterministicIdGenerator();
  const logger = options.logger ?? createNullLogger();
  const privacy = options.privacy ?? createPrivacyService(options.config.privacy);
  const flushTimeoutMillis = options.flushTimeoutMillis ?? DEFAULT_FLUSH_TIMEOUT_MILLIS;
  const lifecycleMaxAge = options.lifecycleMaxAgeMillis ?? DEFAULT_LIFECYCLE_MAX_AGE_MILLIS;
  const stateLockTimeoutMillis = options.stateLockTimeoutMillis ?? DEFAULT_STATE_LOCK_TIMEOUT_MILLIS;

  // Raised, never lowered, and reported when raised: silently honouring a window
  // shorter than one process's own work would turn suppression into a double
  // export. See `minimumStaleClaimMillis`.
  const staleClaimFloor = minimumStaleClaimMillis({
    exportTimeoutMillis: options.config.exporter.timeoutMillis,
    maxRetryAttempts: options.config.exporter.maxRetryAttempts,
    flushTimeoutMillis,
    stateLockTimeoutMillis,
  });
  const requestedStaleClaim = options.staleClaimMillis ?? DEFAULT_STALE_CLAIM_MILLIS;
  const staleClaimMillis = Math.max(requestedStaleClaim, staleClaimFloor);
  if (staleClaimMillis > requestedStaleClaim) {
    logger.warn("staleClaimMillis raised to cover this installation's own export budget", {
      "delivery.stale_claim_requested_millis": requestedStaleClaim,
      "delivery.stale_claim_effective_millis": staleClaimMillis,
    });
  }

  const stateStore = createFilesystemStateStore({
    rootDir: options.stateRootDir,
    providerId: options.providerNamespace,
    installationId: options.installationId,
    clock,
    logger,
    lockTimeoutMillis: stateLockTimeoutMillis,
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

  // A separate queue from the trace spool, so a logs outage cannot consume the
  // capacity the primary signal's retries need. Only built when logs are on: a
  // default installation must not create a directory for a signal it never emits.
  const logSpool =
    options.enableSpool === false || !options.config.exporter.logs.enabled
      ? undefined
      : createFileDurableLogSpool({
          rootDir: options.stateRootDir,
          providerId: options.providerNamespace,
          installationId: options.installationId,
          clock,
          logger,
        });

  const spanCorrelator = createSpanCorrelator({
    stateStore,
    clock,
    maxStartAgeMillis: lifecycleMaxAge,
  });

  /**
   * One correlation resolution per batch, shared by both signals.
   *
   * `correlateBatch` records the start edge and marks a scope published, so two
   * calls for one batch would have the second see the first's writes and report a
   * start it just recorded as a duplicate — leaving the two signals pointing at
   * different span ids for the same scope.
   */
  const correlate = shareCorrelationPerBatch((events) => spanCorrelator.correlateBatch(events));

  const traceSink = createOtlpTraceSink({
    exporter: options.config.exporter,
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    providerId: options.providerNamespace,
    installationId: options.installationId,
    clock,
    logger,
    ...(spool === undefined ? {} : { spool }),
    correlate,
  });

  const logSink = createOtlpLogSink({
    exporter: options.config.exporter,
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    providerId: options.providerNamespace,
    installationId: options.installationId,
    clock,
    logger,
    ...(logSpool === undefined ? {} : { spool: logSpool }),
    content: {
      includeContent: options.config.exporter.logs.includeContent,
      // The pre-existing verbatim-content opt-in, passed through rather than
      // re-derived: `raw` disclosure in a log body is governed by the same flag it
      // has always been governed by.
      allowRawContent: privacy.policy.allowRawContent,
    },
    correlate,
  });

  const sink = createSignalFanout({ traces: traceSink, logs: logSink });

  const hookDeps = {
    stateStore,
    config: options.config,
    registry: options.registry,
    clock,
    ids,
    privacy,
    logger,
    installationId: options.installationId,
  };
  const hook = createOtelHook({ ...hookDeps, sink });

  const deduplicator = createCallbackDeduplicator({ stateStore, clock });
  const usageAccumulator = createUsageAccumulator({ stateStore, clock });
  const deliveryRetentionMillis = options.deliveryRetentionMillis ?? lifecycleMaxAge;
  if (deliveryRetentionMillis < staleClaimMillis) {
    // Not raised, only reported: an operator who wants dedup records gone in a
    // minute is entitled to that, and the sweep already refuses to drop a claim
    // inside the stale window. What they are not entitled to is a *silent* gap —
    // a completed record that expires before a redelivery could plausibly arrive
    // stops suppressing it, and this is the number that explains why.
    logger.warn("delivery retention is shorter than the stale-claim window", {
      "delivery.retention_millis": deliveryRetentionMillis,
      "delivery.stale_claim_effective_millis": staleClaimMillis,
    });
  }
  const janitor = createLifecycleJanitor({
    spanCorrelator,
    deduplicator,
    usageAccumulator,
    spanMaxAgeMillis: lifecycleMaxAge,
    dedupMaxAgeMillis: deliveryRetentionMillis,
    // The *effective* window, not the requested one: a sweep that considered a
    // claim dead earlier than the claim path does would hand a live callback to a
    // peer as fresh.
    dedupStaleClaimMillis: staleClaimMillis,
    usageMaxAgeMillis: lifecycleMaxAge,
  });

  const deliveryLock = createAsyncLock();

  const stateDiagnostic = (thrown: unknown): OtelHookErrorInfo =>
    errorInfoFromThrown(thrown, { code: "state-store-failure", phase: "state", occurredAt: clock.now() });

  /**
   * Opaque, replay-stable token for a delivery, safe to write into a state record.
   *
   * Digested rather than used directly, because a *host-supplied* callback id is a
   * raw external identifier and a rollup record's contents are not a place one may
   * appear as a side effect of deduplicating on it. The digest is content-addressed,
   * so a later process recomputes the same token — which is the whole point: the
   * retry has to recognize its own earlier application.
   */
  const rollupDeliveryToken = (identity: ResolvedDeliveryIdentity): string | undefined => {
    // Clamped to the shape the state schema admits, because `ids` is injected: the
    // default generator returns a hex digest, but a host's own could return anything.
    // An unusable token must cost the *idempotency check* and nothing else — writing
    // it would fail validation and take the whole rollup down with it, which trades a
    // possible double count for a certain lost one.
    const token = ids
      .newOpaqueId(["usage-delivery", identity.scope, identity.callbackId])
      .replace(/[^A-Za-z0-9_-]/g, "")
      .slice(0, 128);
    return token.length === 0 ? undefined : token;
  };

  const applyRollups = async (
    sessionId: string,
    observations: readonly UsageObservation[],
    diagnostics: OtelHookErrorInfo[],
    deliveryToken?: string,
  ): Promise<readonly UsageRollup[]> => {
    const rollups: UsageRollup[] = [];
    // Per rollup key, because idempotency is per record: two observations landing on
    // one key are the first and second application *to that key*, whatever their
    // position in the batch.
    const ordinals = new Map<string, number>();
    for (const observation of observations) {
      const key = { sessionId, scope: observation.scope, scopeKey: observation.scopeKey };
      const rollupId = `${observation.scope} ${observation.scopeKey}`;
      const ordinal = ordinals.get(rollupId) ?? 0;
      ordinals.set(rollupId, ordinal + 1);
      // Absent when no delivery identity was established: there is then nothing to
      // recognize a repeat by, and declining to accumulate would lose a real
      // observation rather than avoid a duplicate one.
      const options =
        deliveryToken === undefined
          ? undefined
          : { delivery: { callbackId: deliveryToken, ordinal } };
      try {
        if (observation.resetDetected) {
          // A restarted provider counter starts a new epoch rather than
          // deflating the running total (see createUsageAccumulator).
          await usageAccumulator.recordReset(key, options);
        }
        const snapshot = await usageAccumulator.accumulateDelta(key, observation.delta, options);
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

  /**
   * Establish this callback's delivery identity.
   *
   * A host-supplied id always wins: the host knows things about its own
   * redelivery that no payload states. Only when there is none does the adapter
   * get asked, and only if derivation is enabled.
   */
  const identifyDelivery = (
    input: HookProcessInput,
  ): { readonly identity?: ResolvedDeliveryIdentity; readonly unavailable?: DeliveryResolution } => {
    if (input.delivery !== undefined) {
      return {
        identity: hostDeliveryIdentity(input.delivery.callbackId, input.delivery.scope),
      };
    }
    if (options.deriveDeliveryIdentity === false) {
      return {};
    }
    const resolution = hook.resolveDelivery(withoutDelivery(input));
    return resolution.status === "resolved"
      ? { identity: resolution.identity }
      : { unavailable: resolution };
  };

  const reportUnavailable = (
    resolution: DeliveryResolution | undefined,
    diagnostics: OtelHookErrorInfo[],
  ): DeliveryReport => {
    if (resolution === undefined || resolution.status === "resolved") {
      // Either an identity was established, or none was even attempted because the
      // host supplied its own id or switched derivation off. Neither is a provider
      // gap, so `requireCallbackId` has nothing to report.
      return { deduplicated: false };
    }
    if (options.requireCallbackId === true) {
      // The generic sentence explains the *reason code*; the adapter's own gap
      // explains the *callback*. Both are useful and they answer different
      // questions, so the detail carries the general statement and then the
      // specific one rather than replacing either.
      const generic = DELIVERY_UNAVAILABLE_DETAIL[resolution.reason];
      const detail =
        resolution.detail === undefined ? generic : `${generic}; ${resolution.detail}`;
      diagnostics.push(
        createErrorInfo({
          code: "delivery-identifier-unavailable",
          phase: "identity",
          detail: detail.slice(0, 400),
          details: {
            "delivery.reason": resolution.reason,
            ...(resolution.providerId === undefined ? {} : { "provider.id": resolution.providerId }),
            ...(resolution.capability === undefined
              ? {}
              : { "provider.delivery_identifier": resolution.capability }),
            ...(resolution.sourceEventName === undefined
              ? {}
              : { "delivery.source_event_name": resolution.sourceEventName }),
            "delivery.remedy": "pass an explicit host delivery id (--callback-id)",
          },
          occurredAt: clock.now(),
        }),
      );
    }
    return {
      deduplicated: false,
      reason: resolution.reason,
      ...(resolution.capability === undefined ? {} : { capability: resolution.capability }),
      ...(resolution.sourceEventName === undefined
        ? {}
        : { sourceEventName: resolution.sourceEventName }),
      ...(resolution.detail === undefined ? {} : { detail: resolution.detail }),
    };
  };

  const runProcess = async (
    input: HookProcessInput,
    identity: ResolvedDeliveryIdentity | undefined,
    report: DeliveryReport,
    diagnostics: OtelHookErrorInfo[],
  ): Promise<HookProcessOutcome> => {
    let delivery = report;
    let owned = false;
    let claimOwner: string | undefined;

    if (identity !== undefined) {
      try {
        const claimed = await deduplicator.claim(identity.scope, identity.callbackId, {
          staleClaimMillis,
        });
        owned = claimed.owned;
        claimOwner = claimed.owner;
        delivery = {
          deduplicated: true,
          origin: identity.origin,
          outcome: claimed.outcome,
          ...(identity.evidence.length === 0 ? {} : { evidence: identity.evidence }),
        };
        if (claimed.outcome === "reclaimed") {
          logger.warn("took over a delivery claim no process ever completed", {
            "delivery.origin": identity.origin,
            "delivery.attempt": claimed.attempt,
            "delivery.abandoned_for_millis": claimed.abandonedForMillis ?? 0,
          });
        }
        if (claimed.duplicate) {
          logger.info("delivery already handled; telemetry suppressed", {
            "delivery.origin": identity.origin,
            "delivery.outcome": claimed.outcome,
          });
        }
      } catch (thrown) {
        // An unreadable dedup record must not drop telemetry: exporting a
        // possible duplicate is recoverable at the collector, losing a real
        // observation is not. Deduplication is what lapses here, so
        // the report says so rather than claiming a guarantee that did not hold.
        diagnostics.push(stateDiagnostic(thrown));
        delivery = { deduplicated: false, origin: identity.origin, reason: "state-unavailable" };
      }
    }

    const duplicateDelivery = delivery.outcome === "duplicate" || delivery.outcome === "in-flight";
    // A redelivery is parsed but changes nothing: no export, no sequence advance,
    // no cumulative-usage rewrite. Suppressing inside `ingest` rather than at the
    // sink is what makes that true — a discarding sink still let the orchestrator
    // renumber the session and move the usage baseline, so a redelivered callback
    // silently shifted every later event's derived id.
    const ingest = await hook.ingest(withoutDelivery(input), { suppress: duplicateDelivery });

    let usageRollups: readonly UsageRollup[] = [];
    if (!duplicateDelivery && ingest.identity !== undefined && ingest.usageObservations.length > 0) {
      // The rollup is the one piece of accounting that sits *outside* `ingest`'s
      // own transaction, in a second critical section — the accumulator takes the
      // same non-reentrant session lock. That leaves this the only place a retried
      // or reclaimed delivery could apply its numbers twice, so it is the one place
      // that gets stamped with the delivery it belongs to.
      usageRollups = await applyRollups(
        ingest.identity.sessionId,
        ingest.usageObservations,
        diagnostics,
        identity === undefined ? undefined : rollupDeliveryToken(identity),
      );
    }

    if (owned && identity !== undefined) {
      // Committing means "this callback is accounted for; never process it again",
      // so the decision turns on whether *anything* survived rather than whether
      // everything did — see `DeliveryDurability`.
      //
      // A partially delivered batch is terminal, and that is the uncomfortable but
      // correct answer. Releasing it would retry the whole callback and re-export
      // every span a collector already accepted, turning a reported loss into a
      // silent double-count; a duplicated span corrupts a total that nobody can
      // reconstruct, whereas a reported loss is a number somebody can act on. So
      // the callback commits and the loss is stated.
      try {
        if (isCommittable(ingest.durability)) {
          const committed = await deduplicator.commit(
            identity.scope,
            identity.callbackId,
            claimOwner,
          );
          if (committed.status === "superseded") {
            // The stale window was shorter than this installation's real worst
            // case, so a peer took the claim over mid-flight and both of us may have
            // exported. No floor computation can rule this out, so it is reported
            // rather than assumed away.
            delivery = { ...delivery, deduplicated: false, superseded: true };
            diagnostics.push(
              createErrorInfo({
                code: "delivery-claim-superseded",
                phase: "state",
                detail:
                  "another process reclaimed this delivery claim before it was committed; raise staleClaimMillis",
                details: {
                  "delivery.origin": identity.origin,
                  "delivery.attempt": committed.attempt,
                },
                occurredAt: clock.now(),
              }),
            );
            logger.warn("delivery claim superseded before commit; deduplication did not hold", {
              "delivery.origin": identity.origin,
              "delivery.attempt": committed.attempt,
            });
          }
          if (ingest.durability === "partial") {
            delivery = { ...delivery, partialLoss: ingest.exportRejected };
            logger.warn("delivery partially lost; committed to avoid re-exporting accepted spans", {
              "delivery.origin": identity.origin,
              "export.accepted": ingest.emitted,
              "export.rejected": ingest.exportRejected,
            });
          }
        } else {
          // Nothing survived, so a retry cannot duplicate anything. Released rather
          // than left to age out, so the next delivery is treated as fresh
          // immediately instead of standing down for the whole stale window against
          // a process that is no longer running.
          await deduplicator.release(identity.scope, identity.callbackId);
          delivery = { ...delivery, deduplicated: false, retryable: true };
          logger.warn("delivery not durably recorded; claim released for retry", {
            "delivery.origin": identity.origin,
            "export.rejected": ingest.exportRejected,
          });
        }
      } catch (thrown) {
        diagnostics.push(stateDiagnostic(thrown));
      }
    }

    let cleanup: LifecycleCleanupReport | undefined;
    if (
      (options.sweepOnSessionEnd ?? true) &&
      ingest.identity !== undefined &&
      containsSessionEnd(ingest.events)
    ) {
      try {
        cleanup = await janitor.runOnce(ingest.identity.sessionId);
        const neverExported = cleanup.span?.expiredOpen ?? 0;
        if (neverExported > 0) {
          // A start that aged out without its end never produced a span at all.
          // Said out loud, because the alternative reading of the same silence is
          // "nothing happened".
          logger.warn("expired lifecycle spans were never completed, so never exported", {
            "lifecycle.expired_open_spans": neverExported,
          });
        }
      } catch (thrown) {
        diagnostics.push(stateDiagnostic(thrown));
      }
    }

    return {
      ingest,
      duplicateDelivery,
      delivery,
      usageRollups,
      ...(cleanup === undefined ? {} : { cleanup }),
      diagnostics,
    };
  };

  const process_ = async (input: HookProcessInput): Promise<HookProcessOutcome> => {
    const diagnostics: OtelHookErrorInfo[] = [];
    const identified = identifyDelivery(input);
    const report = reportUnavailable(identified.unavailable, diagnostics);

    if (identified.identity === undefined) {
      return runProcess(input, undefined, report, diagnostics);
    }

    // Deliveries sharing a scope run one at a time, in arrival order: a claim
    // that is only decided after a peer has already exported is not a claim.
    // Unrelated scopes stay concurrent, and this is an in-process lock layered
    // over the store's cross-process one, so it never contends with itself.
    return deliveryLock.run(identified.identity.scope, () =>
      runProcess(input, identified.identity, report, diagnostics),
    );
  };

  const snapshots = (): readonly DeliveryHealthSnapshot[] => sink.health();

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
    sink: traceSink,
    logSink,
    ...(spool === undefined ? {} : { spool }),
    ...(logSpool === undefined ? {} : { logSpool }),
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
