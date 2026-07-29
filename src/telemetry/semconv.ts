import { createHash } from "node:crypto";

import { SpanKind, SpanStatusCode, TraceFlags, type Attributes, type SpanContext, type SpanStatus } from "@opentelemetry/api";
import { millisToHrTime } from "@opentelemetry/core";
import type { InstrumentationScope } from "@opentelemetry/core";
import type { Resource } from "@opentelemetry/resources";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import {
  ATTR_ERROR_TYPE,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_SYSTEM,
  ATTR_GEN_AI_TOOL_CALL_ID,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS,
  ATTR_SESSION_ID,
} from "@opentelemetry/semantic-conventions/incubating";

import type { CanonicalEvent, CanonicalEventType } from "../model/events.js";
import type { CanonicalUsage } from "../model/usage.js";

const SCOPE_NAME = "@osfactory/otel-hook";

export const DEFAULT_INSTRUMENTATION_SCOPE: InstrumentationScope = Object.freeze({
  name: SCOPE_NAME,
  version: "0.1.0",
});

const ATTR_OTELHOOK_INVOCATION_ID = "otelhook.invocation.id";
const ATTR_OTELHOOK_PROVIDER_ID = "otelhook.provider.id";
const ATTR_OTELHOOK_PROVIDER_VERSION = "otelhook.provider.version";
const ATTR_OTELHOOK_WORKSPACE_ID = "otelhook.workspace.id";
const ATTR_OTELHOOK_SPAN_PAIRED = "otelhook.span.paired";
const ATTR_OTELHOOK_SPAN_PAIRING = "otelhook.span.pairing";
const ATTR_OTELHOOK_SPAN_ORPHAN = "otelhook.span.orphan";
const ATTR_OTELHOOK_OUTCOME = "otelhook.outcome";
const ATTR_OTELHOOK_RESET_DETECTED = "otelhook.usage.reset_detected";
const ATTR_OTELHOOK_TOOL_KIND = "otelhook.tool.kind";
const ATTR_OTELHOOK_DELEGATION_DEPTH = "otelhook.delegation_depth";
const ATTR_OTELHOOK_COMPACTION_TRIGGER = "otelhook.compaction.trigger";
const ATTR_OTELHOOK_AGENT_NAME = "otelhook.agent.name";
const ATTR_OTELHOOK_AGENT_VERSION = "otelhook.agent.version";

/**
 * Pure, stateless canonical-event-to-span mapping.
 *
 * Isolated in one module so every other piece of the telemetry pipeline
 * — batching, retry, spooling — can change without touching what an attribute
 * means. Two edges of the same lifecycle scope are merged into one span when
 * they appear in the same batch; when they arrive in *different* short-lived
 * hook processes they are merged through a {@link SpanCorrelation} the caller
 * resolved from persisted state. Either way the mapping itself stays a pure
 * function: state is read by the correlator, never by this module.
 *
 * ## Identity of a span
 *
 * Trace and span ids are derived, never random, so two processes that never
 * meet still agree on them:
 *
 * - `traceId = H(providerId, sessionId)` — one trace per session per provider.
 *   Deriving it from the session rather than the invocation is what lets a
 *   `tool.end` emitted minutes later land in the same trace as its `tool.start`;
 *   including the provider is what stops two providers that happen to reuse a
 *   session id from being stitched into one trace.
 * - `spanId = H(providerId, sessionId, family, scopeKey)` — stable across
 *   processes and idempotent under redelivery, so a collector that sees a
 *   start-only span and later the completed span treats them as one span
 *   rather than two.
 */
// NUL, so joined parts cannot collide across a different split: no identifier
// this library accepts can contain one, which a printable separator cannot
// promise. Never emitted — only hashed, or used as an in-memory map key.
const FIELD_SEPARATOR = "\u0000";

const digestHex = (parts: readonly string[], length: number): string =>
  createHash("sha256").update(parts.join(FIELD_SEPARATOR)).digest("hex").slice(0, length);

/** Lifecycle scopes that pair a `*.start` edge with a later `*.end` edge. */
export type SpanFamily = "session" | "generation" | "tool" | "subagent";

/** Identifies one lifecycle span within a session. */
export type SpanScopeRef = {
  readonly family: SpanFamily;
  readonly scopeKey: string;
};

/**
 * Why a lifecycle span is, or is not, a complete pair.
 *
 * Deliberately explicit rather than a bare boolean: "we never saw the start",
 * "we saw it but it aged out of state", and "state could not be read at all"
 * are different operational facts, and a dashboard that cannot tell them apart
 * cannot tell a broken host from a broken exporter.
 */
export type SpanOrphanClassification =
  /** Both edges are known — from this batch, or from persisted state. */
  | "none"
  /** The start is known; its end has not arrived yet. */
  | "missing-end"
  /** An end arrived and no start was ever recorded for this scope. */
  | "missing-start"
  /** A start was recorded but aged past the retention window before the end arrived. */
  | "expired-start"
  /** A start exists but was recorded by a different provider; pairing it would be a guess. */
  | "provider-mismatch"
  /** A second, distinct end arrived for a scope that was already closed. */
  | "already-closed"
  /** The persisted record was written by an incompatible version and was discarded. */
  | "state-incompatible"
  /** The persisted record could not be understood. */
  | "state-corrupt"
  /** State could not be consulted at all; the mapping degraded rather than failing. */
  | "state-unavailable";

export type SpanPairing =
  /** Both edges were present in this batch. */
  | "in-batch"
  /** The other edge came from state written by an earlier process. */
  | "cross-process"
  | "unpaired";

/**
 * Whether this scope should produce an OTLP record now.
 *
 * OTLP has no notion of updating a span: a span is exported once, when it ends,
 * and a second record carrying the same trace and span id is not a revision of
 * the first — it is a duplicate that backends variously drop, keep the older of,
 * or display twice. Since every lifecycle span id here is *derived* from
 * `(provider, session, family, scopeKey)`, a `*.start` edge and its later `*.end`
 * edge compute the identical id, so exporting on both is precisely that
 * duplicate.
 *
 * `defer` is therefore the answer for a start whose end has not arrived: the
 * start is durable in the state store, and the end edge exports the one complete
 * span using the times recovered from it. Nothing is lost by waiting, and what is
 * gained is that the record a collector receives has a real duration.
 */
export type SpanDisposition =
  /** Export a record for this scope now. */
  | "emit"
  /** Hold: the start is recorded, and the end edge will export the complete span. */
  | "defer";

/**
 * One scope's correlation facts, resolved from persisted state by the caller.
 *
 * Plain data on purpose: the telemetry layer must not reach into the state
 * store itself (ADR 0006), so it declares what it needs and the lifecycle layer
 * supplies it.
 */
export type SpanCorrelation = {
  readonly providerId: string;
  readonly sessionId: string;
  readonly ref: SpanScopeRef;
  readonly pairing: SpanPairing;
  readonly orphan: SpanOrphanClassification;
  /**
   * Whether to export a record for this scope now. Defaults to `emit` when a
   * correlation is supplied without one.
   */
  readonly disposition?: SpanDisposition;
  /**
   * Extra component mixed into the derived span id.
   *
   * Set only when this record is a genuinely *additional* observation of a scope
   * that has already been exported once — a second, distinct end for a scope that
   * was already closed. Both records are real, so neither is dropped, and the
   * discriminator keeps them from claiming the same span id.
   */
  readonly spanIdDiscriminator?: string;
  /** Start recovered from state; authoritative over the batch's own start edge. */
  readonly startMillis?: number;
  /** End recovered from state; authoritative so a redelivered end re-exports an identical span. */
  readonly endMillis?: number;
  /** Parent recorded at start time, so an end-only process hangs the span in the same place. */
  readonly parent?: SpanScopeRef;
  /** Attributes only the start edge could supply, recovered for an end-only span. */
  readonly attributes?: Attributes;
};

/**
 * Resolves persisted correlation for one batch.
 *
 * Must never reject: a state failure is a degraded span, never a lost export.
 */
export type SpanCorrelationResolver = (
  events: readonly CanonicalEvent[],
) => Promise<readonly SpanCorrelation[]>;

/**
 * Upper bound on how many start-edge attributes the correlator may carry
 * forward, so persisted state cannot grow with provider-controlled input.
 */
export const MAX_RECOVERED_START_ATTRIBUTES = 16;

const familyOf = (type: CanonicalEventType): SpanFamily | undefined => {
  switch (type) {
    case "session.start":
    case "session.end":
      return "session";
    case "generation.start":
    case "generation.end":
      return "generation";
    case "tool.start":
    case "tool.end":
      return "tool";
    case "subagent.start":
    case "subagent.end":
      return "subagent";
    default:
      return undefined;
  }
};

/** The lifecycle span an event is an edge of, or undefined for a point-in-time event. */
export const spanScopeRefOf = (event: CanonicalEvent): SpanScopeRef | undefined => {
  const family = familyOf(event.type);
  if (family === undefined) {
    return undefined;
  }
  switch (event.type) {
    case "session.start":
    case "session.end":
      return { family, scopeKey: event.sessionId };
    case "generation.start":
    case "generation.end":
      return { family, scopeKey: event.generationId };
    case "tool.start":
    case "tool.end":
      return { family, scopeKey: event.toolCallId };
    case "subagent.start":
    case "subagent.end":
      return { family, scopeKey: event.subagentInvocationId };
    default:
      return undefined;
  }
};

/**
 * Where a span hangs in the trace, judged from this event alone.
 *
 * Everything in a session descends from the session span. A tool call names its
 * generation only on `tool.start`, which is exactly why the correlator persists
 * the parent: the `tool.end` process would otherwise reparent the same span to
 * the session and produce a tree whose shape depends on which edge happened to
 * be exported last.
 */
export const parentScopeRefOf = (event: CanonicalEvent): SpanScopeRef | undefined => {
  if (event.type === "session.start" || event.type === "session.end") {
    return undefined;
  }
  if (event.type === "tool.start" && event.generationId !== undefined) {
    return { family: "generation", scopeKey: event.generationId };
  }
  return { family: "session", scopeKey: event.sessionId };
};

/**
 * Span attributes that only a `*.start` edge can supply.
 *
 * The correlator persists these verbatim so an end-only span in a later process
 * still carries the tool kind, requested model, delegation depth, or agent name
 * the start process saw. An allowlist, and bounded, so persisted state can
 * never become a second route for provider payload content to escape.
 */
export const startOnlySpanAttributes = (event: CanonicalEvent): Attributes => {
  switch (event.type) {
    case "session.start":
      return {
        ...(event.agentName === undefined ? {} : { [ATTR_OTELHOOK_AGENT_NAME]: event.agentName }),
        ...(event.agentVersion === undefined
          ? {}
          : { [ATTR_OTELHOOK_AGENT_VERSION]: event.agentVersion }),
      };
    case "generation.start":
      return {
        [ATTR_GEN_AI_REQUEST_MODEL]: event.model.modelId,
        ...(event.model.vendor === undefined ? {} : { [ATTR_GEN_AI_SYSTEM]: event.model.vendor }),
      };
    // `toolName` and `toolCallId` are on both tool edges, so they are not
    // start-only and persisting them would just pad every record.
    case "tool.start":
      return { [ATTR_OTELHOOK_TOOL_KIND]: event.toolKind };
    case "subagent.start":
      return { [ATTR_OTELHOOK_DELEGATION_DEPTH]: event.delegationDepth };
    default:
      return {};
  }
};

const deriveTraceId = (providerId: string, sessionId: string): string =>
  digestHex(["otelhook/trace", providerId, sessionId], 32);

const deriveSpanId = (providerId: string, sessionId: string, ref: SpanScopeRef): string =>
  digestHex(["otelhook/span", providerId, sessionId, ref.family, ref.scopeKey], 16);

const deriveStandaloneSpanId = (
  providerId: string,
  sessionId: string,
  eventType: string,
  eventId: string,
): string => digestHex(["otelhook/span", providerId, sessionId, "event", eventType, eventId], 16);

const correlationKey = (providerId: string, sessionId: string, ref: SpanScopeRef): string =>
  [providerId, sessionId, ref.family, ref.scopeKey].join(FIELD_SEPARATOR);

const outcomeStatus = (outcome: string | undefined): SpanStatus => {
  if (outcome === undefined || outcome === "ok" || outcome === "unknown") {
    return { code: SpanStatusCode.UNSET };
  }
  if (outcome === "cancelled") {
    return { code: SpanStatusCode.UNSET };
  }
  return { code: SpanStatusCode.ERROR, message: outcome };
};

const identityAttributes = (event: CanonicalEvent): Attributes => ({
  [ATTR_SESSION_ID]: event.sessionId,
  [ATTR_OTELHOOK_INVOCATION_ID]: event.invocationId,
  [ATTR_OTELHOOK_PROVIDER_ID]: event.provenance.providerId,
  ...(event.provenance.providerVersion === undefined
    ? {}
    : { [ATTR_OTELHOOK_PROVIDER_VERSION]: event.provenance.providerVersion }),
  [ATTR_OTELHOOK_WORKSPACE_ID]: event.workspace.workspaceId,
});

const usageAttributes = (usage: CanonicalUsage | undefined, resetDetected: boolean): Attributes => {
  if (usage === undefined) {
    return {};
  }
  return {
    [ATTR_GEN_AI_USAGE_INPUT_TOKENS]: usage.inputTokens,
    [ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]: usage.outputTokens,
    [ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS]: usage.cachedInputTokens,
    [ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS]: usage.cacheCreationInputTokens,
    [ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS]: usage.reasoningOutputTokens,
    ...(resetDetected ? { [ATTR_OTELHOOK_RESET_DETECTED]: true } : {}),
  };
};

type SpanGroup = {
  readonly ref: SpanScopeRef;
  start?: CanonicalEvent;
  end?: CanonicalEvent;
};

const buildSpanContext = (traceId: string, spanId: string): SpanContext => ({
  traceId,
  spanId,
  traceFlags: TraceFlags.SAMPLED,
  isRemote: false,
});

export type ReadableSpanInput = {
  readonly name: string;
  readonly kind: SpanKind;
  readonly startMillis: number;
  readonly endMillis: number;
  readonly attributes: Attributes;
  readonly status: SpanStatus;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly resource: Resource;
  readonly instrumentationScope: InstrumentationScope;
};

/** Reconstructs a {@link ReadableSpan} from plain, serializable fields. Used by the durable spool to replay a span it persisted earlier. */
export const assembleReadableSpan = (input: ReadableSpanInput): ReadableSpan => toReadableSpan(input);

const toReadableSpan = (input: ReadableSpanInput): ReadableSpan => {
  const startTime = millisToHrTime(input.startMillis);
  const endTime = millisToHrTime(Math.max(input.startMillis, input.endMillis));
  const duration = millisToHrTime(Math.max(0, input.endMillis - input.startMillis));
  return {
    name: input.name,
    kind: input.kind,
    spanContext: (): SpanContext => buildSpanContext(input.traceId, input.spanId),
    ...(input.parentSpanId === undefined
      ? {}
      : { parentSpanContext: buildSpanContext(input.traceId, input.parentSpanId) }),
    startTime,
    endTime,
    status: input.status,
    attributes: input.attributes,
    links: [],
    events: [],
    duration,
    ended: true,
    resource: input.resource,
    instrumentationScope: input.instrumentationScope,
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };
};

type ResolvedPairing = {
  readonly pairing: SpanPairing;
  readonly orphan: SpanOrphanClassification;
  readonly startMillis: number;
  readonly endMillis: number;
  readonly parent: SpanScopeRef | undefined;
  readonly recovered: Attributes;
};

const resolvePairing = (
  group: SpanGroup,
  anchor: CanonicalEvent,
  correlation: SpanCorrelation | undefined,
): ResolvedPairing => {
  const inBatch = group.start !== undefined && group.end !== undefined;
  const batchStart = group.start?.occurredAt ?? anchor.occurredAt;
  const batchEnd = group.end?.occurredAt ?? anchor.occurredAt;

  if (correlation === undefined) {
    return {
      pairing: inBatch ? "in-batch" : "unpaired",
      orphan: inBatch ? "none" : group.start === undefined ? "missing-start" : "missing-end",
      startMillis: batchStart,
      endMillis: inBatch ? batchEnd : batchStart,
      parent: parentScopeRefOf(anchor),
      recovered: {},
    };
  }

  // A correlation that reports no start (an orphaned end) must not fabricate
  // one: the span collapses onto the end instant rather than claiming a
  // duration measured from an event nobody ever saw.
  const startMillis = correlation.startMillis ?? (inBatch ? batchStart : batchEnd);
  const endMillis = correlation.endMillis ?? (group.end === undefined ? startMillis : batchEnd);
  return {
    pairing: correlation.pairing,
    orphan: correlation.orphan,
    startMillis,
    endMillis,
    parent: correlation.parent ?? parentScopeRefOf(anchor),
    recovered: correlation.attributes ?? {},
  };
};

const buildLifecycleSpan = (
  plan: GroupPlan,
  resource: Resource,
  scope: InstrumentationScope,
): ReadableSpan => {
  const group = plan.group;
  const anchor = plan.anchor;
  const correlation = plan.correlation;
  const providerId = anchor.provenance.providerId;
  const sessionId = anchor.sessionId;
  const resolved = resolvePairing(group, anchor, correlation);
  const traceId = plan.traceId;
  const spanId = plan.spanId;
  const parentSpanId =
    resolved.parent === undefined ? undefined : deriveSpanId(providerId, sessionId, resolved.parent);

  let name: string = group.ref.family;
  let kind: SpanKind = SpanKind.INTERNAL;
  let status: SpanStatus = { code: SpanStatusCode.UNSET };
  // Attributes recovered from the start process sit *beneath* whatever this
  // batch observed: a live edge always wins over a remembered one.
  let attributes: Attributes = {
    ...identityAttributes(anchor),
    ...resolved.recovered,
    [ATTR_OTELHOOK_SPAN_PAIRED]: resolved.pairing !== "unpaired",
    [ATTR_OTELHOOK_SPAN_PAIRING]: resolved.pairing,
    [ATTR_OTELHOOK_SPAN_ORPHAN]: resolved.orphan,
  };

  switch (group.ref.family) {
    case "session": {
      const end = group.end?.type === "session.end" ? group.end : undefined;
      const start = group.start?.type === "session.start" ? group.start : undefined;
      name = "session";
      kind = SpanKind.INTERNAL;
      attributes = {
        ...attributes,
        ...(start?.agentName === undefined ? {} : { [ATTR_OTELHOOK_AGENT_NAME]: start.agentName }),
        ...(start?.agentVersion === undefined
          ? {}
          : { [ATTR_OTELHOOK_AGENT_VERSION]: start.agentVersion }),
        ...(end === undefined ? {} : { [ATTR_OTELHOOK_OUTCOME]: end.reason }),
        ...usageAttributes(end?.usage, false),
      };
      if (end?.reason === "error" || end?.reason === "timeout") {
        status = { code: SpanStatusCode.ERROR, message: end.reason };
      }
      break;
    }
    case "generation": {
      const start = group.start?.type === "generation.start" ? group.start : undefined;
      const end = group.end?.type === "generation.end" ? group.end : undefined;
      const model = end?.model ?? start?.model;
      name = model === undefined ? "generation" : `generation ${model.modelId}`;
      kind = SpanKind.CLIENT;
      attributes = {
        ...attributes,
        [ATTR_GEN_AI_OPERATION_NAME]: "chat",
        ...(model?.vendor === undefined ? {} : { [ATTR_GEN_AI_SYSTEM]: model.vendor }),
        ...(start?.model?.modelId === undefined ? {} : { [ATTR_GEN_AI_REQUEST_MODEL]: start.model.modelId }),
        ...(end?.model?.modelId === undefined ? {} : { [ATTR_GEN_AI_RESPONSE_MODEL]: end.model.modelId }),
        ...(end?.outcome === undefined ? {} : { [ATTR_OTELHOOK_OUTCOME]: end.outcome }),
        ...usageAttributes(end?.usage, false),
      };
      status = outcomeStatus(end?.outcome);
      break;
    }
    case "tool": {
      const start = group.start?.type === "tool.start" ? group.start : undefined;
      const end = group.end?.type === "tool.end" ? group.end : undefined;
      const toolName = start?.toolName ?? end?.toolName ?? "unknown";
      name = `tool ${toolName}`;
      kind = SpanKind.CLIENT;
      attributes = {
        ...attributes,
        [ATTR_GEN_AI_TOOL_NAME]: toolName,
        [ATTR_GEN_AI_TOOL_CALL_ID]: start?.toolCallId ?? end?.toolCallId ?? group.ref.scopeKey,
        ...(start?.toolKind === undefined ? {} : { [ATTR_OTELHOOK_TOOL_KIND]: start.toolKind }),
        ...(end?.outcome === undefined ? {} : { [ATTR_OTELHOOK_OUTCOME]: end.outcome }),
      };
      status = outcomeStatus(end?.outcome);
      break;
    }
    case "subagent": {
      const start = group.start?.type === "subagent.start" ? group.start : undefined;
      const end = group.end?.type === "subagent.end" ? group.end : undefined;
      name = "subagent";
      kind = SpanKind.INTERNAL;
      attributes = {
        ...attributes,
        ...(start?.delegationDepth === undefined
          ? {}
          : { [ATTR_OTELHOOK_DELEGATION_DEPTH]: start.delegationDepth }),
        ...(end?.outcome === undefined ? {} : { [ATTR_OTELHOOK_OUTCOME]: end.outcome }),
        ...usageAttributes(end?.usage, false),
      };
      status = outcomeStatus(end?.outcome);
      break;
    }
  }

  if (status.code === SpanStatusCode.ERROR) {
    attributes = { ...attributes, [ATTR_ERROR_TYPE]: status.message ?? "error" };
  }

  return toReadableSpan({
    name,
    kind,
    startMillis: resolved.startMillis,
    endMillis: resolved.endMillis,
    attributes,
    status,
    traceId,
    spanId,
    ...(parentSpanId === undefined ? {} : { parentSpanId }),
    resource,
    instrumentationScope: scope,
  });
};

const buildStandaloneSpan = (
  event: CanonicalEvent,
  resource: Resource,
  scope: InstrumentationScope,
): ReadableSpan => {
  const providerId = event.provenance.providerId;
  const traceId = deriveTraceId(providerId, event.sessionId);
  const spanId = deriveStandaloneSpanId(providerId, event.sessionId, event.type, event.eventId);
  const parent = parentScopeRefOf(event);
  let attributes: Attributes = { ...identityAttributes(event), [ATTR_OTELHOOK_SPAN_PAIRED]: true };
  let status: SpanStatus = { code: SpanStatusCode.UNSET };
  let name: string = event.type;

  switch (event.type) {
    case "prompt.submitted":
      name = "prompt";
      attributes = { ...attributes, "otelhook.prompt.source": event.promptSource };
      break;
    case "compaction.performed":
      name = "compaction";
      attributes = {
        ...attributes,
        [ATTR_OTELHOOK_COMPACTION_TRIGGER]: event.trigger,
        ...usageAttributes(event.usage, false),
      };
      break;
    case "error.raised":
      name = "error";
      status = { code: SpanStatusCode.ERROR, message: event.errorCode };
      attributes = {
        ...attributes,
        [ATTR_ERROR_TYPE]: event.errorCode,
        "otelhook.error.phase": event.phase,
        "otelhook.error.retryable": event.retryable,
      };
      break;
    default:
      break;
  }

  return toReadableSpan({
    name,
    kind: SpanKind.INTERNAL,
    startMillis: event.occurredAt,
    endMillis: event.occurredAt,
    attributes,
    status,
    traceId,
    spanId,
    ...(parent === undefined
      ? {}
      : { parentSpanId: deriveSpanId(providerId, event.sessionId, parent) }),
    resource,
    instrumentationScope: scope,
  });
};

export type SemanticMappingOptions = {
  readonly resource: Resource;
  readonly instrumentationScope?: InstrumentationScope;
  /**
   * Cross-process pairing facts, at most one entry per lifecycle scope in
   * `events`. Omitted entirely, the mapping degrades to in-batch pairing only —
   * the behavior of a host that wired no state store.
   */
  readonly correlations?: readonly SpanCorrelation[];
  /**
   * Whether a correlator was consulted at all, and whether it answered.
   *
   * This is what separates "the state store is holding this start, so the end edge
   * will publish it" from "nothing recorded this start". Both look like an empty
   * `correlations` list, and only the first is safe to drop — dropping the second
   * would discard an observation that was neither persisted nor exported, while a
   * caller that saw zero rejections went on to mark the callback handled.
   *
   * - `true` — the correlator ran; an absent or non-`defer` entry means emit.
   * - `false` — the correlator failed; every unpaired start is emitted as an
   *   explicitly labelled, uniquely identified fallback.
   * - omitted — no correlator is wired, so cross-process pairing was never on
   *   offer and an unpaired start is deferred (the documented no-state-root
   *   degradation).
   */
  readonly correlationAvailable?: boolean;
};

/**
 * Fill in a correlation for an unpaired start that nothing recorded.
 *
 * Reached when a correlator was consulted and either failed outright or reported
 * nothing for this scope. The synthesized entry says what is true — the state was
 * not consulted successfully, so this span is unpaired and no end can complete it
 * — and carries a discriminator so the record cannot claim the span id a later end
 * will publish for the same scope.
 */
const effectiveCorrelation = (
  group: SpanGroup,
  correlation: SpanCorrelation | undefined,
): SpanCorrelation | undefined => {
  if (correlation !== undefined || group.end !== undefined || group.start === undefined) {
    return correlation;
  }
  return {
    providerId: group.start.provenance.providerId,
    sessionId: group.start.sessionId,
    ref: group.ref,
    pairing: "unpaired",
    orphan: "state-unavailable",
    disposition: "emit",
    spanIdDiscriminator: group.start.eventId,
  };
};

/** How one batch's events distribute over the lifecycle scopes they are edges of. */
type BatchLayout = {
  readonly groups: ReadonlyMap<string, SpanGroup>;
  readonly standalone: readonly CanonicalEvent[];
  /** Event id of each lifecycle edge, mapped to the group key it belongs to. */
  readonly groupOf: ReadonlyMap<string, string>;
};

const layoutBatch = (events: readonly CanonicalEvent[]): BatchLayout => {
  const groups = new Map<string, SpanGroup>();
  const standalone: CanonicalEvent[] = [];
  const groupOf = new Map<string, string>();

  for (const event of events) {
    const ref = spanScopeRefOf(event);
    if (ref === undefined) {
      standalone.push(event);
      continue;
    }
    const groupKey = correlationKey(event.provenance.providerId, event.sessionId, ref);
    const group: SpanGroup = groups.get(groupKey) ?? { ref };
    if (event.type.endsWith(".start")) {
      group.start = event;
    } else {
      group.end = event;
    }
    groups.set(groupKey, group);
    groupOf.set(event.eventId, groupKey);
  }
  return { groups, standalone, groupOf };
};

const indexCorrelations = (
  correlations: readonly SpanCorrelation[] | undefined,
): ReadonlyMap<string, SpanCorrelation> => {
  const indexed = new Map<string, SpanCorrelation>();
  for (const correlation of correlations ?? []) {
    indexed.set(
      correlationKey(correlation.providerId, correlation.sessionId, correlation.ref),
      correlation,
    );
  }
  return indexed;
};

/**
 * What this batch does with one lifecycle scope, decided once.
 *
 * Both the span mapping and the log mapping need the *same* answer to "which
 * span id identifies this scope, and is a record for it going out now?" — a log
 * record whose `spanContext` names a span id the exporter never published would
 * dangle at the collector. Computing it in one place is what keeps the two
 * signals pointing at the same span rather than at two plausible derivations of
 * it.
 */
type GroupPlan = {
  readonly group: SpanGroup;
  /** The event the span's identity and provenance are read from. */
  readonly anchor: CanonicalEvent;
  /**
   * False when the start is deferred: the state store is holding it and the end
   * edge will publish the one complete span, so nothing is exported for it now.
   */
  readonly emits: boolean;
  readonly correlation: SpanCorrelation | undefined;
  readonly traceId: string;
  readonly spanId: string;
};

const planGroup = (
  group: SpanGroup,
  correlation: SpanCorrelation | undefined,
  correlationAvailable: boolean | undefined,
): GroupPlan | undefined => {
  const anchor = group.start ?? group.end;
  if (anchor === undefined) {
    // Unreachable: a group exists only because an event was filed into it.
    return undefined;
  }
  const providerId = anchor.provenance.providerId;
  const sessionId = anchor.sessionId;

  // A start with no end in this batch is dropped **only** when something states
  // that it is durably recorded, because its span id is a pure function of the
  // scope: emitting here and again at the end edge would put two records with one
  // id on the wire, and OTLP has no update operation.
  //
  // `defer` is that statement, and it is the correlator's to make — it just wrote
  // the record. Anything else means nothing is holding this start, so dropping it
  // would lose an observation that was neither persisted nor exported, while the
  // caller saw zero rejections and marked the callback handled. Those are exported
  // under a discriminated span id instead.
  const durablyRecorded =
    group.end === undefined &&
    (correlation?.disposition === "defer" ||
      // No correlator wired at all: cross-process pairing was never on offer, so
      // this is the documented no-state-root degradation rather than a failure to
      // persist something that should have been persisted.
      (correlation === undefined && correlationAvailable === undefined));

  // A deferred start keeps the scope's *plain* span id, because that is the id the
  // end edge will publish. Only a record actually going out now may claim a
  // discriminated one.
  const effective = durablyRecorded ? correlation : effectiveCorrelation(group, correlation);
  const discriminator = durablyRecorded ? undefined : effective?.spanIdDiscriminator;

  return {
    group,
    anchor,
    emits: !durablyRecorded,
    correlation: effective,
    traceId: deriveTraceId(providerId, sessionId),
    spanId:
      discriminator === undefined
        ? deriveSpanId(providerId, sessionId, group.ref)
        : digestHex(
            [
              "otelhook/span",
              providerId,
              sessionId,
              group.ref.family,
              group.ref.scopeKey,
              discriminator,
            ],
            16,
          ),
  };
};

/** Trace and span a record derived from one canonical event belongs to. */
export type EventTraceIdentity = {
  readonly traceId: string;
  readonly spanId: string;
};

/**
 * Resolve the trace and span identity of every event in one batch.
 *
 * Exposed for signals other than traces — a log record correlates by carrying
 * the *same* derived ids the span mapping would compute, including the deferred
 * and discriminated cases. Whole batch at once because a start's identity
 * depends on whether its end is in the same batch.
 *
 * Both ids come from the event's own `(providerId, sessionId)`, never from a
 * batch-level or module-level value, which is what makes cross-session
 * contamination structurally impossible: two sessions in one batch derive two
 * different trace ids.
 */
export const canonicalEventTraceIdentities = (
  events: readonly CanonicalEvent[],
  options: {
    readonly correlations?: readonly SpanCorrelation[];
    readonly correlationAvailable?: boolean;
  } = {},
): ReadonlyMap<string, EventTraceIdentity> => {
  const layout = layoutBatch(events);
  const correlations = indexCorrelations(options.correlations);
  const plans = new Map<string, GroupPlan>();
  for (const [groupKey, group] of layout.groups) {
    const plan = planGroup(group, correlations.get(groupKey), options.correlationAvailable);
    if (plan !== undefined) {
      plans.set(groupKey, plan);
    }
  }

  const identities = new Map<string, EventTraceIdentity>();
  for (const event of events) {
    const providerId = event.provenance.providerId;
    const groupKey = layout.groupOf.get(event.eventId);
    const plan = groupKey === undefined ? undefined : plans.get(groupKey);
    if (plan === undefined) {
      identities.set(event.eventId, {
        traceId: deriveTraceId(providerId, event.sessionId),
        spanId: deriveStandaloneSpanId(providerId, event.sessionId, event.type, event.eventId),
      });
      continue;
    }
    identities.set(event.eventId, { traceId: plan.traceId, spanId: plan.spanId });
  }
  return identities;
};

/** Maps one invocation's canonical event batch into OTLP-ready spans. */
export const canonicalEventsToReadableSpans = (
  events: readonly CanonicalEvent[],
  options: SemanticMappingOptions,
): readonly ReadableSpan[] => {
  const scope = options.instrumentationScope ?? DEFAULT_INSTRUMENTATION_SCOPE;
  const layout = layoutBatch(events);
  const correlations = indexCorrelations(options.correlations);

  const spans: ReadableSpan[] = [];
  for (const [groupKey, group] of layout.groups) {
    const plan = planGroup(group, correlations.get(groupKey), options.correlationAvailable);
    if (plan === undefined || !plan.emits) {
      continue;
    }
    spans.push(buildLifecycleSpan(plan, options.resource, scope));
  }
  for (const event of layout.standalone) {
    spans.push(buildStandaloneSpan(event, options.resource, scope));
  }
  return spans;
};
