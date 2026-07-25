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
  SILENT_HOOK_RESPONSE,
  type ProviderAdapter,
  type ProviderContext,
  type ProviderDetection,
  type ProviderHookResponse,
} from "../providers/adapter.js";
import { createProviderRegistry, BUILT_IN_PROVIDERS, type ProviderRegistry } from "../providers/registry.js";
import { createSystemClock } from "./clock.js";
import { createDeterministicIdGenerator } from "./ids.js";
import { createNullLogger } from "./logger.js";
import type { Clock, IdGenerator, Logger, StateStore, TelemetrySink } from "./ports.js";

export const usageScopeSchema = z.enum(["session", "generation", "subagent"]);
export type UsageScope = z.infer<typeof usageScopeSchema>;

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
  readonly dropped: number;
  readonly hookResponse: ProviderHookResponse;
  readonly diagnostics: readonly OtelHookErrorInfo[];
};

/** Public runtime surface. */
export interface OtelHook {
  /** Process one provider observation. Never throws, never rejects. */
  ingest(input: HookIngestInput): Promise<HookIngestOutcome>;
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

  const deriveUsage = async (
    events: readonly CanonicalEvent[],
    diagnostics: OtelHookErrorInfo[],
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

      const key = usageKey(event.sessionId, scoped.scope, scoped.scopeKey);
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
        await deps.stateStore.write(key, { kind: "usage-cumulative", usage: scoped.usage });
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

  const ingest = async (input: HookIngestInput): Promise<HookIngestOutcome> => {
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
          dropped: 0,
          hookResponse: hookResponseFor(adapter, detection, "declined", reason, 0, diagnostics),
          diagnostics,
        };
      }

      const identity = resolution.identity;
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
          ok: true,
          attribution: "failed",
          attributionReason: "adapter-failure",
          providerId: detection.providerId,
          detectionConfidence: detection.confidence,
          identity,
          events: [],
          usageObservations: [],
          emitted: 0,
          dropped: 0,
          hookResponse: hookResponseFor(adapter, detection, "failed", "adapter-failure", 0, diagnostics),
          diagnostics,
        };
      }

      if (parsed.status === "ignored") {
        logger.debug("adapter ignored input", {
          "provider.id": detection.providerId,
          "adapter.reason": parsed.reason.slice(0, 160),
        });
        return {
          ok: true,
          attribution: "not-applicable",
          attributionReason: "adapter-ignored-input",
          providerId: detection.providerId,
          detectionConfidence: detection.confidence,
          identity,
          events: [],
          usageObservations: [],
          emitted: 0,
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
        };
      }

      if (parsed.status === "failed") {
        diagnostics.push(parsed.error);
        return {
          ok: true,
          attribution: "failed",
          attributionReason: "adapter-failure",
          providerId: detection.providerId,
          detectionConfidence: detection.confidence,
          identity,
          events: [],
          usageObservations: [],
          emitted: 0,
          dropped: 0,
          hookResponse: hookResponseFor(adapter, detection, "failed", "adapter-failure", 0, diagnostics),
          diagnostics,
        };
      }

      const screened = screenEvents(parsed.events, identity, sequenceBase, diagnostics);
      const usageObservations = await deriveUsage(screened.kept, diagnostics);

      let batch: readonly CanonicalEvent[] = screened.kept;
      if (config.diagnostics.emitErrorEvents && diagnostics.length > 0) {
        batch = [...batch, ...buildErrorEvents(diagnostics, identity, sequenceBase + batch.length, ids, privacy)];
      }

      let emitted = 0;
      if (batch.length > 0) {
        try {
          const result = await deps.sink.emit(batch);
          emitted = result.accepted;
          diagnostics.push(...result.errors);
        } catch (thrown) {
          diagnostics.push(
            errorInfoFromThrown(thrown, {
              code: "telemetry-export-failure",
              phase: "export",
              occurredAt: clock.now(),
            }),
          );
        }
      }

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

      return {
        ok: true,
        attribution: "attributed",
        providerId: detection.providerId,
        detectionConfidence: detection.confidence,
        identity,
        events: batch,
        usageObservations,
        emitted,
        dropped: screened.dropped,
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

  return { ingest, flush, shutdown, config };
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
