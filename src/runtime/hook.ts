import { z } from "zod";

import { DEFAULT_CONFIG, type OtelHookConfig } from "../config/schema.js";
import {
  createErrorInfo,
  errorInfoFromThrown,
  type AttributionOutcome,
  type AttributionReason,
  type OtelHookErrorInfo,
} from "../errors/index.js";
import {
  isContentFactConsistent,
  type ContentFact,
} from "../model/content.js";
import type { CanonicalEvent } from "../model/events.js";
import {
  resolveInvocationIdentity,
  sourceProvenanceSchema,
  unknownWorkspaceIdentity,
  type IdentityClaim,
  type InvocationIdentity,
  type WorkspaceIdentity,
} from "../model/identity.js";
import {
  type DetectionConfidence,
  type EventId,
  type ResolvedProviderId,
  type SourceTransport,
} from "../model/primitives.js";
import {
  cumulativeToDelta,
  normalizeUsage,
  toReport,
  type CanonicalUsage,
  type UsageTemporality,
} from "../model/usage.js";
import { CANONICAL_SCHEMA_VERSION } from "../model/version.js";
import { CONTENT_MODE_DISCLOSURE } from "../privacy/policy.js";
import { createPrivacyService, type PrivacyService } from "../privacy/service.js";
import {
  readDeliveryClaim,
  readDeliveryGap,
  SILENT_HOOK_RESPONSE,
  type ProviderAdapter,
  type ProviderContext,
  type ProviderDetection,
  type ProviderHookResponse,
} from "../providers/adapter.js";
import { createProviderRegistry, BUILT_IN_PROVIDERS, type ProviderRegistry } from "../providers/registry.js";
import { createSystemClock } from "./clock.js";
import { resolveDeliveryIdentity, type DeliveryResolution } from "./delivery.js";
import { createDeterministicIdGenerator } from "./ids.js";
import { createNullLogger } from "./logger.js";
import type { Clock, IdGenerator, Logger, StateStore, TelemetrySink } from "./ports.js";
import { isStateLockContention, withOptionalSessionLock } from "../state/store.js";

export const usageScopeSchema = z.enum(["session", "generation", "subagent"]);
export type UsageScope = z.infer<typeof usageScopeSchema>;

/**
 * Which series a provider's cumulative counters accumulate over. Mirrors
 * `ProviderCapabilities.cumulativeUsageSeries`, defaulting to `event-scope`
 * for the adapters that do not declare one.
 */
export type CumulativeUsageSeries = "event-scope" | "session-lifetime";

/**
 * Delta usage derived for one event.
 *
 * Events keep whatever the provider reported. Deltas are produced alongside them
 * rather than rewritten into them, so a cumulative report and its derived delta
 * are both auditable.
 */
export type UsageObservation = {
  readonly eventId: EventId;
  readonly sequence: number;
  readonly scope: UsageScope;
  readonly scopeKey: string;
  readonly reportedTemporality: UsageTemporality;
  readonly delta: CanonicalUsage;
  /** True when the cumulative series restarted; see `cumulativeToDelta`. */
  readonly resetDetected: boolean;
};

export type HookIngestInput = {
  /** Decoded provider payload. Only the selected adapter interprets it. */
  readonly payload: unknown;
  readonly transport: SourceTransport;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly providerHint?: string;
  /** Caller-supplied identity claims, arbitrated with the adapter's claims. */
  readonly identityClaims?: readonly IdentityClaim[];
  /** Opaque consumer metadata; sanitized, then carried through unchanged. */
  readonly consumerAttributes?: Readonly<Record<string, unknown>>;
  readonly workspace?: WorkspaceIdentity;
};

/**
 * The terminal fate of one callback's telemetry, and the only thing a caller
 * should base a commit-or-retry decision on.
 *
 * The distinction that matters is **any** versus **all**, not success versus
 * failure. A batch is chunked before export, so it can be part accepted and part
 * refused — and once a single span has reached a collector or the spool, retrying
 * the callback would re-export that span. So a partial result is *terminal*: the
 * callback is committed, the loss is reported, and nothing is retried. Only a
 * result where nothing at all survived is safe to retry, precisely because there
 * is nothing to duplicate.
 */
export type DeliveryDurability =
  /** Suppressed, or no events to export. There is nothing to lose or retry. */
  | "nothing-to-deliver"
  /** Every span reached the collector or the spool. */
  | "delivered"
  /**
   * Some spans survived and some did not. Terminal: committing loses the refused
   * spans, retrying duplicates the accepted ones, and duplicating an accepted
   * span silently corrupts a total while a reported loss can be acted on.
   */
  | "partial"
  /** Nothing survived, so a retry cannot duplicate anything. */
  | "lost";

export const classifyDurability = (input: {
  readonly attempted: boolean;
  readonly accepted: number;
  readonly rejected: number;
}): DeliveryDurability => {
  if (!input.attempted) {
    return "nothing-to-deliver";
  }
  if (input.rejected === 0) {
    return input.accepted === 0 ? "nothing-to-deliver" : "delivered";
  }
  return input.accepted === 0 ? "lost" : "partial";
};

/** Whether this fate permits committing the callback and its accounting. */
export const isCommittable = (durability: DeliveryDurability): boolean =>
  durability !== "lost";

export type HookIngestOutcome = {
  /**
   * Always `true`. The hook cannot fail the host agent; look at `attribution`
   * and `diagnostics` to see what actually happened (ADR 0004).
   */
  readonly ok: true;
  readonly attribution: AttributionOutcome;
  readonly attributionReason?: AttributionReason;
  readonly providerId: ResolvedProviderId;
  readonly detectionConfidence: DetectionConfidence;
  readonly identity?: InvocationIdentity;
  readonly events: readonly CanonicalEvent[];
  readonly usageObservations: readonly UsageObservation[];
  readonly emitted: number;
  /**
   * Spans the sink could neither export nor durably spool.
   *
   * The distinction `emitted` cannot make: a successful spool enqueue counts as
   * emitted, because the batch is safe on disk and a later invocation will retry
   * it. A non-zero value here means those observations are **gone** unless the
   * callback is delivered again — which is what lets a caller decide whether a
   * delivery claim may be committed or has to be released for retry.
   */
  readonly exportRejected: number;
  /**
   * The terminal fate of this callback's telemetry.
   *
   * The field a caller should branch on. `emitted` and `exportRejected` are the
   * raw counts behind it; this is the decision they add up to, computed in one
   * place so a caller cannot get the any-versus-all boundary wrong.
   */
  readonly durability: DeliveryDurability;
  readonly dropped: number;
  readonly hookResponse: ProviderHookResponse;
  readonly diagnostics: readonly OtelHookErrorInfo[];
};

export type HookIngestOptions = {
  /**
   * Parse and answer the provider, but export nothing and mutate no canonical
   * state.
   *
   * For a callback that deduplication has already identified as a redelivery.
   * The adapter still runs, so the provider's protocol response comes from a real
   * parse of the real payload rather than a guess — but the session sequence
   * counter is not advanced and no cumulative usage baseline is rewritten,
   * because both are *canonical state* and a redelivery is by definition not a
   * new observation. Advancing the sequence would renumber every later event in
   * the session and change its derived event id, which is exactly the
   * replay-stability the dedup guard exists to protect.
   */
  readonly suppress?: boolean;
};

/** Public runtime surface. */
export interface OtelHook {
  /**
   * Report the replay-stable delivery identity of an input without ingesting it.
   *
   * Synchronous, side-effect free, and never throws. It exists as a separate
   * step because deduplication has to decide *before* anything is exported or
   * accounted, and `ingest` exports as part of its own work — a caller that
   * learned the identity afterwards could only ever suppress a duplicate it had
   * already sent. Only `detect` and `deliveryIdentity` run here; the payload is
   * never parsed.
   */
  resolveDelivery(input: HookIngestInput): DeliveryResolution;
  /** Process one provider observation. Never throws, never rejects. */
  ingest(input: HookIngestInput, options?: HookIngestOptions): Promise<HookIngestOutcome>;
  /** Best-effort delivery of buffered telemetry. Never throws. */
  flush(): Promise<void>;
  /** Flush, then release resources. Never throws; idempotent. */
  shutdown(): Promise<void>;
  /** Resolved configuration in force. Read-only. */
  readonly config: OtelHookConfig;
}

export type OtelHookDependencies = {
  readonly sink: TelemetrySink;
  readonly stateStore: StateStore;
  readonly config?: OtelHookConfig;
  readonly registry?: ProviderRegistry;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  /** Overrides `config.privacy` when supplied; must already be configured. */
  readonly privacy?: PrivacyService;
  readonly logger?: Logger;
  /**
   * Namespace separating one deployment's derived delivery identities from
   * another's. Not identity: it never reaches an event, and no session or
   * workspace is derived from it. Defaults to `"default"`.
   */
  readonly installationId?: string;
};

const MAX_ERROR_EVENTS = 8;

const collectContentFacts = (event: CanonicalEvent): readonly ContentFact[] => {
  const facts: ContentFact[] = [];
  const push = (fact: ContentFact | undefined): void => {
    if (fact !== undefined) {
      facts.push(fact);
    }
  };
  switch (event.type) {
    case "prompt.submitted":
      push(event.content);
      break;
    case "generation.start":
      facts.push(...(event.inputContent ?? []));
      break;
    case "generation.end":
      facts.push(...(event.outputContent ?? []));
      break;
    case "tool.start":
      push(event.input);
      break;
    case "tool.end":
      push(event.output);
      break;
    case "error.raised":
      push(event.message);
      break;
    default:
      break;
  }
  return facts;
};

const usageScopeOf = (
  event: CanonicalEvent,
): { readonly scope: UsageScope; readonly scopeKey: string; readonly usage: CanonicalUsage } | undefined => {
  switch (event.type) {
    case "session.end":
      return event.usage === undefined
        ? undefined
        : { scope: "session", scopeKey: event.sessionId, usage: event.usage };
    case "compaction.performed":
      return event.usage === undefined
        ? undefined
        : { scope: "session", scopeKey: event.sessionId, usage: event.usage };
    case "generation.end":
      return event.usage === undefined
        ? undefined
        : { scope: "generation", scopeKey: event.generationId, usage: event.usage };
    case "subagent.end":
      return event.usage === undefined
        ? undefined
        : { scope: "subagent", scopeKey: event.subagentInvocationId, usage: event.usage };
    default:
      return undefined;
  }
};

const sequenceKey = (sessionId: string): string => `sequence:${sessionId}`;
const usageKey = (sessionId: string, scope: UsageScope, scopeKey: string): string =>
  `usage:${sessionId}:${scope}:${scopeKey}`;

/**
 * Where the cumulative baseline for an observation is stored.
 *
 * This is deliberately *not* the same thing as the observation's own scope. The
 * derived delta belongs to the event that reported it — a turn's token spend is
 * attributed to that turn — but the snapshot it must be diffed against belongs
 * to whichever series the provider is actually accumulating.
 *
 * For a `session-lifetime` provider (Codex: every hook carries the session-wide
 * `total_token_usage`), keying the baseline by `generationId` would mean every
 * turn's snapshot found no predecessor and was emitted whole, billing the entire
 * session again on each turn. Redirecting `generation` to the session series
 * makes successive turns diff against each other.
 */
const baselineScopeOf = (
  scope: UsageScope,
  scopeKey: string,
  sessionId: string,
  series: CumulativeUsageSeries,
): { readonly scope: UsageScope; readonly scopeKey: string } =>
  series === "session-lifetime" && scope === "generation"
    ? { scope: "session", scopeKey: sessionId }
    : { scope, scopeKey };

/**
 * Minimal orchestrator wiring detection, identity, parsing, privacy checks,
 * usage derivation, and export.
 *
 * Every step is contained: a throwing adapter, an unavailable state store, or a
 * rejecting sink degrades the telemetry, never the host agent.
 */
export const createOtelHook = (deps: OtelHookDependencies): OtelHook => {
  const config = deps.config ?? DEFAULT_CONFIG;
  const registry = deps.registry ?? createProviderRegistry(BUILT_IN_PROVIDERS);
  const clock = deps.clock ?? createSystemClock();
  const ids = deps.ids ?? createDeterministicIdGenerator();
  const privacy = deps.privacy ?? createPrivacyService(config.privacy);
  const logger = deps.logger ?? createNullLogger();
  const installationId = deps.installationId ?? "default";
  const limits = privacy.policy.limits;
  const expectedDisclosure = CONTENT_MODE_DISCLOSURE[privacy.policy.contentMode];

  const providerContext: ProviderContext = { privacy, clock, ids, logger, limits };
  let shutdownCompleted = false;

  const hookResponseFor = (
    adapter: ProviderAdapter | undefined,
    detection: ProviderDetection | undefined,
    attribution: AttributionOutcome,
    attributionReason: AttributionReason | undefined,
    emittedEvents: number,
    errors: readonly OtelHookErrorInfo[],
  ): ProviderHookResponse => {
    if (adapter === undefined) {
      return SILENT_HOOK_RESPONSE;
    }
    try {
      return adapter.hookResponse(
        {
          attribution,
          ...(attributionReason === undefined ? {} : { attributionReason }),
          ...(detection === undefined ? {} : { detection }),
          emittedEvents,
          errors,
        },
        providerContext,
      );
    } catch {
      // A provider that cannot describe its own response gets the silent one.
      return SILENT_HOOK_RESPONSE;
    }
  };

  const readSequenceBase = async (
    sessionId: string,
    diagnostics: OtelHookErrorInfo[],
  ): Promise<number> => {
    try {
      const record = await deps.stateStore.read(sequenceKey(sessionId));
      if (record?.value.kind === "sequence") {
        return record.value.next;
      }
      return 0;
    } catch (thrown) {
      diagnostics.push(
        errorInfoFromThrown(thrown, { code: "state-store-failure", phase: "state", occurredAt: clock.now() }),
      );
      return 0;
    }
  };

  /**
   * Derive per-event deltas, advancing the stored cumulative baseline.
   *
   * `suppress` makes this read-only: a redelivered callback must still be able to
   * report what it *would* have counted, but rewriting the baseline would make
   * the next genuine observation diff against the wrong snapshot and report a
   * zero — or negative — delta. Callers run this inside the session lock.
   */
  const deriveUsage = async (
    events: readonly CanonicalEvent[],
    diagnostics: OtelHookErrorInfo[],
    suppress: boolean,
    series: CumulativeUsageSeries,
  ): Promise<readonly UsageObservation[]> => {
    const observations: UsageObservation[] = [];
    for (const event of events) {
      const scoped = usageScopeOf(event);
      if (scoped === undefined) {
        continue;
      }
      if (scoped.usage.temporality === "delta") {
        observations.push({
          eventId: event.eventId,
          sequence: event.sequence,
          scope: scoped.scope,
          scopeKey: scoped.scopeKey,
          reportedTemporality: "delta",
          delta: scoped.usage,
          resetDetected: false,
        });
        continue;
      }

      const baselineScope = baselineScopeOf(scoped.scope, scoped.scopeKey, event.sessionId, series);
      const key = usageKey(event.sessionId, baselineScope.scope, baselineScope.scopeKey);
      let baseline: CanonicalUsage | undefined;
      try {
        const record = await deps.stateStore.read(key);
        if (record?.value.kind === "usage-cumulative") {
          baseline = record.value.usage;
        }
      } catch (thrown) {
        // Without a baseline the difference is unknowable. Emitting the raw
        // snapshot as a delta would double-count, so the observation is dropped.
        diagnostics.push(
          errorInfoFromThrown(thrown, {
            code: "state-store-failure",
            phase: "state",
            occurredAt: clock.now(),
          }),
        );
        continue;
      }

      let delta: CanonicalUsage;
      let resetDetected = false;
      if (baseline === undefined) {
        const normalized = normalizeUsage({ ...toReport(scoped.usage), temporality: "delta" });
        if (normalized.status === "invalid") {
          diagnostics.push(
            createErrorInfo({
              code: "usage-invalid",
              phase: "normalization",
              detail: normalized.issues.map((issue) => issue.message).join("; ").slice(0, 400),
              details: { "event.id": event.eventId, "usage.scope": scoped.scope },
              occurredAt: clock.now(),
            }),
          );
          continue;
        }
        delta = normalized.usage;
      } else {
        try {
          const diffed = cumulativeToDelta(baseline, scoped.usage);
          delta = diffed.usage;
          resetDetected = diffed.resetDetected;
        } catch (thrown) {
          diagnostics.push(
            errorInfoFromThrown(thrown, {
              code: "usage-invalid",
              phase: "normalization",
              occurredAt: clock.now(),
            }),
          );
          continue;
        }
      }

      try {
        if (!suppress) {
          await deps.stateStore.write(key, { kind: "usage-cumulative", usage: scoped.usage });
        }
      } catch (thrown) {
        diagnostics.push(
          errorInfoFromThrown(thrown, {
            code: "state-store-failure",
            phase: "state",
            occurredAt: clock.now(),
          }),
        );
      }

      observations.push({
        eventId: event.eventId,
        sequence: event.sequence,
        scope: scoped.scope,
        scopeKey: scoped.scopeKey,
        reportedTemporality: "cumulative",
        delta,
        resetDetected,
      });
    }
    return observations;
  };

  const screenEvents = (
    events: readonly CanonicalEvent[],
    identity: InvocationIdentity,
    sequenceBase: number,
    diagnostics: OtelHookErrorInfo[],
  ): { readonly kept: readonly CanonicalEvent[]; readonly dropped: number } => {
    const kept: CanonicalEvent[] = [];
    let dropped = 0;
    let expectedSequence = sequenceBase;

    for (const event of events) {
      const reject = (code: "schema-validation-failed" | "privacy-policy-violation" | "limit-exceeded", detail: string): void => {
        dropped += 1;
        diagnostics.push(
          createErrorInfo({
            code,
            phase: code === "privacy-policy-violation" ? "privacy" : "parsing",
            detail,
            details: { "event.type": event.type, "event.sequence": event.sequence },
            occurredAt: clock.now(),
          }),
        );
      };

      if (kept.length >= limits.maxEventsPerInvocation) {
        reject("limit-exceeded", `event dropped: maxEventsPerInvocation=${limits.maxEventsPerInvocation}`);
        continue;
      }
      if (event.schemaVersion !== CANONICAL_SCHEMA_VERSION) {
        reject("schema-validation-failed", "event carries an unexpected schema version");
        continue;
      }
      if (event.invocationId !== identity.invocationId || event.sessionId !== identity.sessionId) {
        // Fail closed: an adapter may only describe the invocation it was given.
        reject("schema-validation-failed", "event identity does not match the resolved invocation");
        continue;
      }
      if (event.provenance.providerId !== identity.provenance.providerId) {
        reject("schema-validation-failed", "event provenance does not match the detected provider");
        continue;
      }
      if (event.sequence !== expectedSequence) {
        reject(
          "schema-validation-failed",
          `event sequence ${event.sequence} is not consecutive from ${expectedSequence}`,
        );
        continue;
      }

      const facts = collectContentFacts(event);
      const offending = facts.find(
        (fact) => fact.disclosure !== expectedDisclosure || !isContentFactConsistent(fact),
      );
      if (offending !== undefined) {
        reject(
          "privacy-policy-violation",
          `content fact disclosure ${offending.disclosure} violates policy ${expectedDisclosure}`,
        );
        continue;
      }

      expectedSequence += 1;
      kept.push(event);
    }
    return { kept, dropped };
  };

  const detectionInputFor = (input: HookIngestInput): {
    readonly payload: unknown;
    readonly transport: SourceTransport;
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly providerHint?: string;
  } => ({
    payload: input.payload,
    transport: input.transport,
    environment: input.environment ?? {},
    ...(input.providerHint === undefined ? {} : { providerHint: input.providerHint }),
  });

  const resolveDelivery = (input: HookIngestInput): DeliveryResolution => {
    let detected;
    try {
      detected = registry.detect(detectionInputFor(input), providerContext, config.detection);
    } catch {
      return { status: "unavailable", reason: "provider-unattributed" };
    }
    if (detected.status !== "selected") {
      return { status: "unavailable", reason: "provider-unattributed" };
    }

    const { adapter, detection } = detected;
    const capability = adapter.capabilities.deliveryIdentifier;
    // Named once, then reused: an unavailable resolution says *which* callback it
    // is talking about, because "not identifiable" without a callback name leaves
    // an operator auditing coverage nowhere to go.
    const named = {
      providerId: detection.providerId,
      capability,
      ...(detection.sourceEventName === undefined
        ? {}
        : { sourceEventName: detection.sourceEventName }),
    };
    const gap = readDeliveryGap(adapter, detection.sourceEventName);

    if (capability === "none") {
      return {
        status: "unavailable",
        reason: "provider-declares-none",
        ...named,
        ...(gap === undefined ? {} : { detail: gap }),
      };
    }

    const read = readDeliveryClaim(adapter, { ...detectionInputFor(input), detection }, providerContext);
    if (read.rejection !== undefined) {
      return {
        status: "unavailable",
        reason: "claim-rejected",
        ...named,
        detail: read.rejection,
      };
    }
    if (read.claim === undefined) {
      return {
        status: "unavailable",
        reason: "callback-not-identifiable",
        ...named,
        ...(gap === undefined ? {} : { detail: gap }),
      };
    }
    return {
      status: "resolved",
      identity: resolveDeliveryIdentity({
        ids,
        providerId: detection.providerId,
        installationId,
        claim: read.claim,
      }),
    };
  };

  const ingest = async (
    input: HookIngestInput,
    ingestOptions?: HookIngestOptions,
  ): Promise<HookIngestOutcome> => {
    const suppress = ingestOptions?.suppress === true;
    const diagnostics: OtelHookErrorInfo[] = [];
    const environment = input.environment ?? {};
    const detectionInput = {
      payload: input.payload,
      transport: input.transport,
      environment,
      ...(input.providerHint === undefined ? {} : { providerHint: input.providerHint }),
    };

    try {
      const detected = registry.detect(detectionInput, providerContext, config.detection);
      diagnostics.push(...detected.errors);

      if (detected.status !== "selected") {
        const reason: AttributionReason =
          detected.status === "ambiguous" ? "provider-detection-ambiguous" : "provider-unknown";
        diagnostics.push(
          createErrorInfo({
            code: detected.status === "ambiguous" ? "provider-detection-ambiguous" : "provider-unknown",
            phase: "detection",
            detail: detected.detection.reasons.join("; ").slice(0, 400),
            details: { "detection.candidates": detected.candidates.length },
            occurredAt: clock.now(),
          }),
        );
        logger.warn("provider not attributed", {
          "detection.status": detected.status,
          "detection.candidates": detected.candidates.length,
        });
        return {
          ok: true,
          attribution: "declined",
          attributionReason: reason,
          providerId: "unknown",
          detectionConfidence: detected.detection.confidence,
          events: [],
          usageObservations: [],
          emitted: 0,
          exportRejected: 0,
          durability: "nothing-to-deliver" as const,
          dropped: 0,
          hookResponse: SILENT_HOOK_RESPONSE,
          diagnostics,
        };
      }

      const { adapter, detection } = detected;
      const provenance = sourceProvenanceSchema.parse({
        providerId: detection.providerId,
        ...(detection.providerVersion === undefined
          ? {}
          : { providerVersion: detection.providerVersion }),
        adapterId: adapter.id,
        adapterVersion: adapter.version,
        detectionConfidence: detection.confidence,
        ...(detection.sourceEventName === undefined
          ? {}
          : { sourceEventName: detection.sourceEventName }),
        transport: input.transport,
      });

      let adapterClaims: readonly IdentityClaim[] = [];
      try {
        adapterClaims = adapter.identify({ ...detectionInput, detection }, providerContext);
      } catch (thrown) {
        diagnostics.push(
          errorInfoFromThrown(thrown, {
            code: "provider-adapter-failure",
            phase: "identity",
            occurredAt: clock.now(),
          }),
        );
      }

      const resolution = resolveInvocationIdentity({
        claims: [...adapterClaims, ...(input.identityClaims ?? [])],
        provenance,
        fallback: {
          startedAt: clock.now(),
          workspace: input.workspace ?? unknownWorkspaceIdentity(),
        },
        consumerAttributes: privacy.sanitizeAttributes(input.consumerAttributes ?? {}),
      });

      if (resolution.status !== "resolved") {
        const reason: AttributionReason =
          resolution.status === "conflict" ? "identity-conflict" : "identity-incomplete";
        const detail =
          resolution.status === "conflict"
            ? `conflicting fields: ${resolution.conflicts.map((conflict) => conflict.field).join(", ")}`
            : resolution.status === "incomplete"
              ? `missing fields: ${resolution.missing.join(", ")}`
              : `invalid claims: ${resolution.issues.join("; ")}`;
        diagnostics.push(
          createErrorInfo({
            code: resolution.status === "conflict" ? "identity-conflict" : "identity-incomplete",
            phase: "identity",
            detail: detail.slice(0, 400),
            details: { "provider.id": detection.providerId },
            occurredAt: clock.now(),
          }),
        );
        logger.warn("attribution declined", {
          "identity.status": resolution.status,
          "provider.id": detection.providerId,
        });
        return {
          ok: true,
          attribution: "declined",
          attributionReason: reason,
          providerId: detection.providerId,
          detectionConfidence: detection.confidence,
          events: [],
          usageObservations: [],
          emitted: 0,
          exportRejected: 0,
          durability: "nothing-to-deliver" as const,
          dropped: 0,
          hookResponse: hookResponseFor(adapter, detection, "declined", reason, 0, diagnostics),
          diagnostics,
        };
      }

      const identity = resolution.identity;

      /**
       * Result of the session-state critical section: either a finished outcome
       * (the adapter declined to produce events) or a batch ready to export.
       */
      type Prepared =
        | { readonly kind: "early"; readonly outcome: HookIngestOutcome }
        | {
            readonly kind: "ready";
            readonly batch: readonly CanonicalEvent[];
            readonly dropped: number;
          };

      /**
       * Read this session's sequence, stamp a batch from it, derive usage against
       * the stored baselines, and commit the new sequence — as one unit.
       *
       * These are read-modify-write cycles on state shared by every process
       * handling the same session, and hook processes genuinely run concurrently
       * (a tool callback and a generation callback firing together). Unserialized,
       * two processes both read sequence *n*, both stamp events from *n*, and both
       * write *n + k*: the second batch reuses the first's sequence numbers, so
       * both derive the *same* event ids and a collector sees one event twice
       * while another is never numbered at all. The cumulative usage baseline
       * races the same way, and there the lost update is a wrong token delta
       * rather than a duplicate id.
       *
       * Export deliberately happens *after* this returns, outside the lock. Two
       * reasons, one correctness and one liveness: the span correlator takes this
       * same session lock from inside the sink, so exporting in here would be a
       * non-reentrant self-deadlock; and an unreachable collector must not hold a
       * session's state lock for the length of its timeout. Committing the
       * sequence before exporting means a failed export leaves a gap in the
       * numbering rather than a reused number — a gap is invisible to a
       * collector, a reused id is a corrupted trace.
       */
      const prepare = async (): Promise<Prepared> => {
      const sequenceBase = await readSequenceBase(identity.sessionId, diagnostics);

      let parsed;
      try {
        parsed = adapter.parse(
          { ...detectionInput, detection, identity, sequenceBase },
          providerContext,
        );
      } catch (thrown) {
        const info = errorInfoFromThrown(thrown, {
          code: "provider-adapter-failure",
          phase: "parsing",
          occurredAt: clock.now(),
        });
        diagnostics.push(info);
        return {
          kind: "early",
          outcome: {
            ok: true,
            attribution: "failed",
            attributionReason: "adapter-failure",
            providerId: detection.providerId,
            detectionConfidence: detection.confidence,
            identity,
            events: [],
            usageObservations: [],
            emitted: 0,
            exportRejected: 0,
            durability: "nothing-to-deliver" as const,
            dropped: 0,
            hookResponse: hookResponseFor(adapter, detection, "failed", "adapter-failure", 0, diagnostics),
            diagnostics,
          },
        };
      }

      if (parsed.status === "ignored") {
        logger.debug("adapter ignored input", {
          "provider.id": detection.providerId,
          "adapter.reason": parsed.reason.slice(0, 160),
        });
        return {
          kind: "early",
          outcome: {
            ok: true,
            attribution: "not-applicable",
            attributionReason: "adapter-ignored-input",
            providerId: detection.providerId,
            detectionConfidence: detection.confidence,
            identity,
            events: [],
            usageObservations: [],
            emitted: 0,
            exportRejected: 0,
            durability: "nothing-to-deliver" as const,
            dropped: 0,
            hookResponse: hookResponseFor(
              adapter,
              detection,
              "not-applicable",
              "adapter-ignored-input",
              0,
              diagnostics,
            ),
            diagnostics,
          },
        };
      }

      if (parsed.status === "failed") {
        diagnostics.push(parsed.error);
        return {
          kind: "early",
          outcome: {
            ok: true,
            attribution: "failed",
            attributionReason: "adapter-failure",
            providerId: detection.providerId,
            detectionConfidence: detection.confidence,
            identity,
            events: [],
            usageObservations: [],
            emitted: 0,
            exportRejected: 0,
            durability: "nothing-to-deliver" as const,
            dropped: 0,
            hookResponse: hookResponseFor(adapter, detection, "failed", "adapter-failure", 0, diagnostics),
            diagnostics,
          },
        };
      }

      if (parsed.warnings !== undefined && parsed.warnings.length > 0) {
        // An adapter reports a warning when it understood the payload but had to
        // decline part of it — a counter outside its declared capabilities, a
        // breakdown that disagrees with the total it itemizes. Not a diagnostic:
        // the observation is intact and nothing failed, so raising an error-severity
        // code would misreport a healthy invocation. But not nothing either, which
        // is what these were before: a harness whose attached field is being ignored
        // has no other way to find out.
        logger.warn("adapter declined part of the payload it understood", {
          "provider.id": detection.providerId,
          "adapter.warnings": parsed.warnings.slice(0, 8).map((warning) => warning.slice(0, 200)),
        });
      }

      const screened = screenEvents(parsed.events, identity, sequenceBase, diagnostics);

      let batch: readonly CanonicalEvent[] = screened.kept;
      if (config.diagnostics.emitErrorEvents && diagnostics.length > 0) {
        batch = [...batch, ...buildErrorEvents(diagnostics, identity, sequenceBase + batch.length, ids, privacy)];
      }

      if (!suppress) {
        try {
          await deps.stateStore.write(sequenceKey(identity.sessionId), {
            kind: "sequence",
            next: sequenceBase + batch.length,
          });
        } catch (thrown) {
          diagnostics.push(
            errorInfoFromThrown(thrown, {
              code: "state-store-failure",
              phase: "state",
              occurredAt: clock.now(),
            }),
          );
        }
      }

        return { kind: "ready", batch, dropped: screened.dropped };
      };

      let prepared: Prepared;
      try {
        prepared = await withOptionalSessionLock(deps.stateStore, identity.sessionId, prepare);
      } catch (thrown) {
        diagnostics.push(
          errorInfoFromThrown(thrown, {
            code: "state-store-failure",
            phase: "state",
            occurredAt: clock.now(),
          }),
        );

        if (!isStateLockContention(thrown)) {
          // The store cannot lock because it cannot be used at all — an unwritable
          // directory, a full disk. There is no peer inside the critical section
          // and no state to lose an update to, so the lock protects nothing here
          // and fail-open wins: process unlocked and export. Each individual read
          // and write inside still degrades to its own diagnostic.
          logger.warn("state store unusable; processing without session serialization", {
            "provider.id": detection.providerId,
          });
          prepared = await prepare();
        } else {
          // Genuine contention. Proceeding unlocked would reintroduce exactly the
          // interleaving the lock exists to prevent, so the observation is declined
          // and said out loud — the provider still gets its protocol response, and a
          // caller holding a delivery claim releases it, turning a lock collision
          // into a retry rather than a corrupted sequence.
          //
          // A contended acquisition *cancels* its queued critical section
          // (`AsyncLock.run`), so this is now a provable statement rather than a
          // hopeful one: nothing was read, reserved, or written, which is what makes
          // the retry safe rather than a second half-application.
          logger.warn("session state lock contended; observation declined for retry", {
            "provider.id": detection.providerId,
          });
          return {
            ok: true,
            attribution: "failed",
            attributionReason: "internal-error",
            providerId: detection.providerId,
            detectionConfidence: detection.confidence,
            identity,
            events: [],
            usageObservations: [],
            emitted: 0,
            // Nothing was exported, nothing was reserved, and nothing is on disk,
            // so the caller must see this as a total loss and retry it.
            exportRejected: 1,
            durability: "lost",
            dropped: 0,
            hookResponse: hookResponseFor(adapter, detection, "failed", "internal-error", 0, diagnostics),
            diagnostics,
          };
        }
      }

      if (prepared.kind === "early") {
        return prepared.outcome;
      }
      const { batch, dropped } = prepared;

      let emitted = 0;
      let exportRejected = 0;
      if (!suppress && batch.length > 0) {
        try {
          const result = await deps.sink.emit(batch);
          emitted = result.accepted;
          exportRejected = result.rejected;
          diagnostics.push(...result.errors);
        } catch (thrown) {
          // A throwing sink delivered nothing and spooled nothing.
          exportRejected = batch.length;
          diagnostics.push(
            errorInfoFromThrown(thrown, {
              code: "telemetry-export-failure",
              phase: "export",
              occurredAt: clock.now(),
            }),
          );
        }
      }

      const durability = classifyDurability({
        attempted: !suppress && batch.length > 0,
        accepted: emitted,
        rejected: exportRejected,
      });

      /**
       * Usage accounting is the *commit* half of the transaction, so it runs here
       * and not in `prepare`.
       *
       * Deriving a delta advances the stored cumulative baseline, which is a
       * one-way move: once it points at this snapshot, the difference this callback
       * represented is no longer recoverable from state. Doing that before knowing
       * whether the telemetry survived means a fully rejected callback releases its
       * claim having *already* consumed its own usage — so the retry diffs against
       * the advanced baseline, reports roughly zero, and the tokens are gone. Delta
       * usage has the mirror-image failure: it needs no baseline, so a retry
       * accumulates the same delta a second time.
       *
       * Nothing exported depends on these numbers — a span carries the usage the
       * provider *reported*, never the derived delta — so deferring costs nothing
       * and buys exactly-once accounting. The read of the baseline, the diff, and
       * the write back all stay inside one critical section, so two concurrent
       * processes cannot both diff against the same snapshot.
       *
       * A suppressed redelivery and a fully rejected attempt both skip this
       * entirely, which is what leaves the baseline where the next real attempt
       * needs it.
       */
      let usageObservations: readonly UsageObservation[] = [];
      if (durability !== "lost" && !suppress && batch.length > 0) {
        try {
          usageObservations = await withOptionalSessionLock(
            deps.stateStore,
            identity.sessionId,
            () =>
              deriveUsage(
                batch,
                diagnostics,
                false,
                adapter.capabilities.cumulativeUsageSeries ?? "event-scope",
              ),
          );
        } catch (thrown) {
          // The accounting could not be committed. The telemetry is already out, so
          // this is a reporting gap rather than a lost observation: it is said out
          // loud and the callback stays committed, because retrying it would
          // re-export spans a collector has already accepted.
          diagnostics.push(
            errorInfoFromThrown(thrown, {
              code: "state-store-failure",
              phase: "state",
              occurredAt: clock.now(),
            }),
          );
          logger.warn("usage accounting could not be committed for a delivered callback", {
            "provider.id": detection.providerId,
          });
        }
      }

      return {
        ok: true,
        attribution: "attributed",
        providerId: detection.providerId,
        detectionConfidence: detection.confidence,
        identity,
        events: batch,
        usageObservations,
        emitted,
        exportRejected,
        durability,
        dropped,
        hookResponse: hookResponseFor(adapter, detection, "attributed", undefined, emitted, diagnostics),
        diagnostics,
      };
    } catch (thrown) {
      // Last line of defence: anything unanticipated becomes a diagnostic.
      const info = errorInfoFromThrown(thrown, { code: "internal-error", phase: "parsing" });
      diagnostics.push(info);
      logger.error("ingest contained an unexpected failure", {
        "error.code": info.code,
        ...(info.details ?? {}),
      });
      return {
        ok: true,
        attribution: "failed",
        attributionReason: "internal-error",
        providerId: "unknown",
        detectionConfidence: "none",
        events: [],
        usageObservations: [],
        emitted: 0,
        exportRejected: 0,
        durability: "nothing-to-deliver" as const,
        dropped: 0,
        hookResponse: SILENT_HOOK_RESPONSE,
        diagnostics,
      };
    }
  };

  const flush = async (): Promise<void> => {
    try {
      await deps.sink.flush();
    } catch (thrown) {
      const info = errorInfoFromThrown(thrown, { code: "telemetry-export-failure", phase: "export" });
      logger.warn("flush failed", { "error.code": info.code });
    }
  };

  const shutdown = async (): Promise<void> => {
    if (shutdownCompleted) {
      return;
    }
    shutdownCompleted = true;
    await flush();
    try {
      await deps.sink.shutdown();
    } catch (thrown) {
      const info = errorInfoFromThrown(thrown, {
        code: "telemetry-export-failure",
        phase: "shutdown",
      });
      logger.warn("shutdown failed", { "error.code": info.code });
    }
  };

  return { resolveDelivery, ingest, flush, shutdown, config };
};

const buildErrorEvents = (
  diagnostics: readonly OtelHookErrorInfo[],
  identity: InvocationIdentity,
  sequenceBase: number,
  ids: IdGenerator,
  privacy: PrivacyService,
): readonly CanonicalEvent[] => {
  const events: CanonicalEvent[] = [];
  for (const [index, info] of diagnostics.slice(0, MAX_ERROR_EVENTS).entries()) {
    const sequence = sequenceBase + index;
    events.push({
      schemaVersion: CANONICAL_SCHEMA_VERSION,
      eventId: ids.newEventId({
        invocationId: identity.invocationId,
        sequence,
        eventType: "error.raised",
        discriminator: info.code,
      }),
      invocationId: identity.invocationId,
      sessionId: identity.sessionId,
      sequence,
      occurredAt: info.occurredAt ?? identity.startedAt,
      provenance: identity.provenance,
      workspace: identity.workspace,
      extensions: {},
      type: "error.raised",
      errorCode: info.code,
      severity: info.severity,
      phase: info.phase,
      retryable: info.retryable,
      // The message is already a fixed-vocabulary summary, but it still passes
      // through the privacy service so one policy governs every disclosure.
      message: privacy.describeContent({ kind: "error-message", text: info.message }),
      detail: info.code,
    });
  }
  return events;
};
