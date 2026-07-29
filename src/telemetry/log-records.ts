import { TraceFlags, type SpanContext } from "@opentelemetry/api";
import { SeverityNumber, type LogAttributes } from "@opentelemetry/api-logs";
import { millisToHrTime, type InstrumentationScope } from "@opentelemetry/core";
import type { Resource } from "@opentelemetry/resources";
import type { ReadableLogRecord } from "@opentelemetry/sdk-logs";
import {
  ATTR_ERROR_TYPE,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_SYSTEM,
  ATTR_GEN_AI_TOOL_CALL_ID,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_SESSION_ID,
} from "@opentelemetry/semantic-conventions/incubating";

import type { ContentFact } from "../model/content.js";
import type { CanonicalEvent, CanonicalEventType } from "../model/events.js";
import {
  canonicalEventTraceIdentities,
  DEFAULT_INSTRUMENTATION_SCOPE,
  type SpanCorrelation,
} from "./semconv.js";

/**
 * Pure, stateless canonical-event-to-OTLP-log-record mapping.
 *
 * The counterpart of `semconv.ts` for the logs signal, and deliberately the same
 * shape: no state is read here, no clock is consulted, and the only inputs are
 * the batch plus the correlations the caller already resolved. Batching, retry,
 * spooling, and delivery live in `otlp-log-sink.ts`.
 *
 * ## Why logs at all, when traces already exist
 *
 * A span reports that a tool call happened, how long it took, and whether it
 * failed. It does not report *what was in it*, and it cannot: span attributes are
 * a flat bounded map, one record per span, exported once. A conversation turn is a
 * sequence of distinct pieces of content — a prompt, a response, reasoning, a tool
 * input, a tool output — each with its own role, its own length, and its own
 * disclosure decision. That is a log stream, and OTLP has one.
 *
 * So this mapping emits **one record per content fact**, plus one record per event
 * that carries no content, and correlates every record to the span the same batch
 * produced (or will produce). Nothing here decides *whether* content is
 * disclosed — the privacy service already did that, upstream, once — but the
 * gate is re-checked here because this is the last boundary before the wire.
 *
 * ## Identity and correlation
 *
 * Every record carries the same identity attributes a span does, and a
 * `spanContext` built from {@link canonicalEventTraceIdentities}: the trace id and
 * span id are derived from the event's own `(providerId, sessionId)` and its
 * lifecycle scope, so a record lands in the same trace as its span without either
 * signal knowing about the other. Two sessions in one batch derive two trace ids;
 * there is no batch-level or module-level trace state to contaminate.
 */

/**
 * Version of this mapping.
 *
 * Consumers pin it. Bumped on any change to what an existing attribute or signal
 * *means*; adding a new attribute or a new signal value does not bump it, on the
 * same additive-compatibility rule the canonical model follows
 * (`CANONICAL_SCHEMA_VERSION`). Every record carries it as
 * `otelhook.log.mapping_version`, so a consumer never has to infer which
 * vocabulary it is reading.
 */
export const LOG_MAPPING_VERSION = 1 as const;

/**
 * Coarse routing key for one log record.
 *
 * The fact's own `otelhook.content.kind` states precisely what the content is;
 * this states which *pipeline* it belongs to, so an operator can route or drop a
 * whole class ("no tool output off this host") with one collector rule rather
 * than an enumeration of event types.
 */
export const LOG_SIGNALS = [
  "session",
  "prompt",
  "response",
  "reasoning",
  "tool",
  "shell",
  "file-operation",
  "mcp",
  "delegation",
  "compaction",
  "error",
] as const;
export type LogSignal = (typeof LOG_SIGNALS)[number];

/**
 * Naming convention that marks a tool call as MCP-mediated.
 *
 * The canonical model has no "this went through MCP" field, because no provider
 * contract this package has verified carries one: what they carry is a *tool
 * name*, and three of the four non-synthetic contracts (Claude Code, Codex,
 * Gemini CLI) name MCP tools `mcp__<server>__<tool>`. So the convention is the
 * evidence, matched on the canonical tool name rather than on any provider's
 * payload.
 *
 * This deliberately **under-reports**: a provider whose MCP tool names do not
 * follow the convention classifies as `tool`, which is true but less specific.
 * The alternative — per-provider branching in the canonical layer, or a canonical
 * field no adapter can populate from a verified contract — would either leak
 * provider knowledge across the boundary or invent a contract. See
 * `docs/canonical-log-mapping.md`.
 */
export const MCP_TOOL_NAME_PATTERN = /^mcp__/i;

/**
 * Most records one event may produce.
 *
 * Matches `contentFactsSchema`'s own cap, so in practice the mapping never drops
 * a fact an adapter produced; it is the backstop for a hand-built event, not a
 * routine truncation.
 */
export const MAX_LOG_RECORDS_PER_EVENT = 64;

/** Most records one batch may produce, whatever the batch contains. */
export const MAX_LOG_RECORDS_PER_BATCH = 2_048;

/**
 * Longest disclosed body this mapping will put on the wire.
 *
 * Separate from, and stricter than, the privacy policy's `maxStringLength` (which
 * may be configured up to 64Ki characters): a policy bound is about *disclosure*,
 * this is about the size of one OTLP record. A body cut here is reported as
 * `otelhook.content.body_truncated` rather than as the fact's own `truncated`
 * flag, so "the privacy policy shortened this" and "the log record shortened
 * this" stay distinguishable.
 */
export const MAX_LOG_BODY_CHARACTERS = 8_192;

const ATTR_OTELHOOK_INVOCATION_ID = "otelhook.invocation.id";
const ATTR_OTELHOOK_PROVIDER_ID = "otelhook.provider.id";
const ATTR_OTELHOOK_PROVIDER_VERSION = "otelhook.provider.version";
const ATTR_OTELHOOK_WORKSPACE_ID = "otelhook.workspace.id";
const ATTR_OTELHOOK_EVENT_TYPE = "otelhook.event.type";
const ATTR_OTELHOOK_EVENT_ID = "otelhook.event.id";
const ATTR_OTELHOOK_EVENT_SEQUENCE = "otelhook.event.sequence";
const ATTR_OTELHOOK_LOG_SIGNAL = "otelhook.log.signal";
const ATTR_OTELHOOK_LOG_MAPPING_VERSION = "otelhook.log.mapping_version";
const ATTR_OTELHOOK_OUTCOME = "otelhook.outcome";
const ATTR_OTELHOOK_TOOL_KIND = "otelhook.tool.kind";
const ATTR_OTELHOOK_TOOL_PERMISSION = "otelhook.tool.permission_decision";
const ATTR_OTELHOOK_DELEGATION_DEPTH = "otelhook.delegation_depth";
const ATTR_OTELHOOK_SUBAGENT_TYPE = "otelhook.subagent.type";
const ATTR_OTELHOOK_AGENT_NAME = "otelhook.agent.name";
const ATTR_OTELHOOK_AGENT_VERSION = "otelhook.agent.version";
const ATTR_OTELHOOK_SESSION_KIND = "otelhook.session.kind";
const ATTR_OTELHOOK_PROMPT_SOURCE = "otelhook.prompt.source";
const ATTR_OTELHOOK_PROMPT_TURN_INDEX = "otelhook.prompt.turn_index";
const ATTR_OTELHOOK_GENERATION_ID = "otelhook.generation.id";
const ATTR_OTELHOOK_STOP_REASON = "otelhook.generation.stop_reason";
const ATTR_OTELHOOK_COMPACTION_TRIGGER = "otelhook.compaction.trigger";
const ATTR_OTELHOOK_CONTEXT_TOKENS_BEFORE = "otelhook.compaction.context_tokens_before";
const ATTR_OTELHOOK_CONTEXT_TOKENS_AFTER = "otelhook.compaction.context_tokens_after";
const ATTR_OTELHOOK_DROPPED_MESSAGES = "otelhook.compaction.dropped_message_count";
const ATTR_OTELHOOK_ERROR_PHASE = "otelhook.error.phase";
const ATTR_OTELHOOK_ERROR_RETRYABLE = "otelhook.error.retryable";
const ATTR_OTELHOOK_ERROR_SEVERITY = "otelhook.error.severity";

const ATTR_CONTENT_KIND = "otelhook.content.kind";
const ATTR_CONTENT_ROLE = "otelhook.content.role";
const ATTR_CONTENT_DISCLOSURE = "otelhook.content.disclosure";
const ATTR_CONTENT_CHARACTER_LENGTH = "otelhook.content.character_length";
const ATTR_CONTENT_BYTE_LENGTH = "otelhook.content.byte_length";
const ATTR_CONTENT_HASH = "otelhook.content.hash";
const ATTR_CONTENT_TRUNCATED = "otelhook.content.truncated";
const ATTR_CONTENT_SECRETS_REDACTED = "otelhook.content.secrets_redacted";
const ATTR_CONTENT_LABEL = "otelhook.content.label";
const ATTR_CONTENT_WITHHELD = "otelhook.content.withheld";
const ATTR_CONTENT_BODY_TRUNCATED = "otelhook.content.body_truncated";

/**
 * Why a content fact reached the wire without its text.
 *
 * Stated rather than left as an absence, because "this prompt was empty", "this
 * deployment omits content", and "this deployment discloses content but not to
 * the logs pipeline" are three different operational facts that all look like a
 * missing body.
 */
export type ContentWithholdingReason =
  /** The privacy policy produced no text at all — the default `omit` posture. */
  | "privacy-policy"
  /** Content is disclosed elsewhere, but the logs pipeline is not permitted it. */
  | "logs-content-disabled"
  /** The fact carries verbatim text and `allowRawContent` is not set. */
  | "raw-not-permitted";

/**
 * Whether disclosed content text may reach a log body.
 *
 * Two gates rather than one, and both must open. `includeContent` is the logs
 * pipeline's own switch, and it exists because spans carry no content in *any*
 * content mode: without it, turning on `privacy.contentMode` to get a hash and a
 * length — which is all it ever bought before — would start putting prompts on
 * the wire. `allowRawContent` is the pre-existing verbatim-content opt-in,
 * re-checked here because the sink is the last boundary before the wire and a
 * hand-built fact could otherwise carry `disclosure: "raw"` past a policy that
 * never permitted it.
 */
export type LogContentPolicy = {
  readonly includeContent: boolean;
  readonly allowRawContent: boolean;
};

/** Content disabled, which is what an unconfigured installation gets. */
export const NO_LOG_CONTENT: LogContentPolicy = Object.freeze({
  includeContent: false,
  allowRawContent: false,
});

const codePointLength = (value: string): number => [...value].length;

const sliceCodePoints = (value: string, max: number): string => {
  let result = "";
  let count = 0;
  for (const char of value) {
    if (count >= max) {
      break;
    }
    result += char;
    count += 1;
  }
  return result;
};

/**
 * Which pipeline an event's records belong to.
 *
 * `factKind` refines the answer where one event type carries more than one kind
 * of content: a `generation.end` holds the response *and*, on providers that
 * report it, the reasoning that produced it, and collapsing those into one signal
 * would make "drop reasoning, keep responses" unexpressible.
 */
export const logSignalOf = (event: CanonicalEvent, factKind?: ContentFact["kind"]): LogSignal => {
  switch (event.type) {
    case "session.start":
    case "session.end":
      return "session";
    case "prompt.submitted":
      return "prompt";
    case "generation.start":
      return factKind === "reasoning" ? "reasoning" : "prompt";
    case "generation.end":
      return factKind === "reasoning" ? "reasoning" : "response";
    case "subagent.start":
    case "subagent.end":
      return "delegation";
    case "compaction.performed":
      return "compaction";
    case "error.raised":
      return "error";
    case "tool.start":
      return toolSignal(event.toolName, event.toolKind);
    case "tool.end":
      // A `tool.end` carries no `toolKind`: only the start edge does. Classifying
      // from the name alone is what the canonical model permits here, so a shell
      // or file operation whose name does not say so lands on `tool` — and the
      // span for the same scope, which *did* recover the kind from state, is where
      // that detail is authoritative.
      return toolSignal(event.toolName, undefined);
  }
};

const toolSignal = (
  toolName: string,
  toolKind: Extract<CanonicalEvent, { type: "tool.start" }>["toolKind"] | undefined,
): LogSignal => {
  if (MCP_TOOL_NAME_PATTERN.test(toolName)) {
    return "mcp";
  }
  switch (toolKind) {
    case "execute":
      return "shell";
    case "read":
    case "write":
      return "file-operation";
    case "delegate":
      return "delegation";
    default:
      return "tool";
  }
};

/**
 * Log signals an adapter declaring these lifecycle events can produce.
 *
 * Derived from the adapter's existing `lifecycleEvents` declaration rather than
 * declared separately, which is the whole point: a hand-maintained second list
 * can disagree with the first, and a capability declaration that has gone stale is
 * worse than none — a consumer cannot tell "this provider reports no tool output"
 * from "this declaration was never updated".
 *
 * The tool refinements (`shell`, `file-operation`, `mcp`) are reported whenever
 * the adapter emits tool events at all, because which of them a given callback
 * produces depends on the payload, not on the adapter. So this is a statement
 * about what *may* appear, not what always will.
 */
export const logSignalsForLifecycleEvents = (
  lifecycleEvents: readonly CanonicalEventType[],
): readonly LogSignal[] => {
  const signals = new Set<LogSignal>();
  const add = (...values: readonly LogSignal[]): void => {
    for (const value of values) {
      signals.add(value);
    }
  };
  for (const type of lifecycleEvents) {
    switch (type) {
      case "session.start":
      case "session.end":
        add("session");
        break;
      case "prompt.submitted":
        add("prompt");
        break;
      case "generation.start":
        add("prompt");
        break;
      case "generation.end":
        add("response", "reasoning");
        break;
      case "tool.start":
      case "tool.end":
        add("tool", "shell", "file-operation", "mcp", "delegation");
        break;
      case "subagent.start":
      case "subagent.end":
        add("delegation");
        break;
      case "compaction.performed":
        add("compaction");
        break;
      case "error.raised":
        add("error");
        break;
    }
  }
  return LOG_SIGNALS.filter((signal) => signals.has(signal));
};

const severityFor = (event: CanonicalEvent): SeverityNumber => {
  switch (event.type) {
    case "error.raised":
      return event.severity === "error" ? SeverityNumber.ERROR : SeverityNumber.WARN;
    case "session.end":
      return event.reason === "error" || event.reason === "timeout"
        ? SeverityNumber.ERROR
        : event.reason === "aborted"
          ? SeverityNumber.WARN
          : SeverityNumber.INFO;
    case "generation.end":
    case "tool.end":
    case "subagent.end":
      return event.outcome === "error" || event.outcome === "timeout"
        ? SeverityNumber.ERROR
        : event.outcome === "denied" || event.outcome === "cancelled"
          ? SeverityNumber.WARN
          : SeverityNumber.INFO;
    default:
      return SeverityNumber.INFO;
  }
};

const SEVERITY_TEXT: Readonly<Record<number, string>> = Object.freeze({
  [SeverityNumber.INFO]: "INFO",
  [SeverityNumber.WARN]: "WARN",
  [SeverityNumber.ERROR]: "ERROR",
});

const identityAttributes = (event: CanonicalEvent): LogAttributes => ({
  [ATTR_SESSION_ID]: event.sessionId,
  [ATTR_OTELHOOK_INVOCATION_ID]: event.invocationId,
  [ATTR_OTELHOOK_PROVIDER_ID]: event.provenance.providerId,
  ...(event.provenance.providerVersion === undefined
    ? {}
    : { [ATTR_OTELHOOK_PROVIDER_VERSION]: event.provenance.providerVersion }),
  [ATTR_OTELHOOK_WORKSPACE_ID]: event.workspace.workspaceId,
});

/**
 * Attributes describing the event itself, independent of any content it carries.
 *
 * Every attribute here is a closed vocabulary, an identifier this library
 * derived, a count, or a boolean — the same restriction the privacy service
 * applies everywhere else, so an attribute can never become a second disclosure
 * path alongside the body.
 */
const eventAttributes = (event: CanonicalEvent): LogAttributes => {
  switch (event.type) {
    case "session.start":
      return {
        [ATTR_OTELHOOK_SESSION_KIND]: event.sessionKind,
        ...(event.agentName === undefined ? {} : { [ATTR_OTELHOOK_AGENT_NAME]: event.agentName }),
        ...(event.agentVersion === undefined
          ? {}
          : { [ATTR_OTELHOOK_AGENT_VERSION]: event.agentVersion }),
        ...(event.model === undefined
          ? {}
          : { [ATTR_GEN_AI_REQUEST_MODEL]: event.model.modelId }),
      };
    case "session.end":
      return {
        [ATTR_OTELHOOK_OUTCOME]: event.reason,
        ...usageAttributes(event.usage),
      };
    case "prompt.submitted":
      return {
        [ATTR_OTELHOOK_PROMPT_SOURCE]: event.promptSource,
        ...(event.turnIndex === undefined
          ? {}
          : { [ATTR_OTELHOOK_PROMPT_TURN_INDEX]: event.turnIndex }),
      };
    case "generation.start":
      return {
        [ATTR_GEN_AI_OPERATION_NAME]: "chat",
        [ATTR_OTELHOOK_GENERATION_ID]: event.generationId,
        [ATTR_GEN_AI_REQUEST_MODEL]: event.model.modelId,
        ...(event.model.vendor === undefined ? {} : { [ATTR_GEN_AI_SYSTEM]: event.model.vendor }),
      };
    case "generation.end":
      return {
        [ATTR_GEN_AI_OPERATION_NAME]: "chat",
        [ATTR_OTELHOOK_GENERATION_ID]: event.generationId,
        [ATTR_GEN_AI_RESPONSE_MODEL]: event.model.modelId,
        ...(event.model.vendor === undefined ? {} : { [ATTR_GEN_AI_SYSTEM]: event.model.vendor }),
        [ATTR_OTELHOOK_OUTCOME]: event.outcome,
        ...(event.stopReason === undefined ? {} : { [ATTR_OTELHOOK_STOP_REASON]: event.stopReason }),
        ...usageAttributes(event.usage),
      };
    case "tool.start":
      return {
        [ATTR_GEN_AI_TOOL_NAME]: event.toolName,
        [ATTR_GEN_AI_TOOL_CALL_ID]: event.toolCallId,
        [ATTR_OTELHOOK_TOOL_KIND]: event.toolKind,
        ...(event.generationId === undefined
          ? {}
          : { [ATTR_OTELHOOK_GENERATION_ID]: event.generationId }),
      };
    case "tool.end":
      return {
        [ATTR_GEN_AI_TOOL_NAME]: event.toolName,
        [ATTR_GEN_AI_TOOL_CALL_ID]: event.toolCallId,
        [ATTR_OTELHOOK_OUTCOME]: event.outcome,
        ...(event.permissionDecision === undefined
          ? {}
          : { [ATTR_OTELHOOK_TOOL_PERMISSION]: event.permissionDecision }),
      };
    case "subagent.start":
      return {
        [ATTR_OTELHOOK_DELEGATION_DEPTH]: event.delegationDepth,
        ...(event.subagentType === undefined
          ? {}
          : { [ATTR_OTELHOOK_SUBAGENT_TYPE]: event.subagentType }),
        ...(event.model === undefined ? {} : { [ATTR_GEN_AI_REQUEST_MODEL]: event.model.modelId }),
      };
    case "subagent.end":
      return {
        [ATTR_OTELHOOK_OUTCOME]: event.outcome,
        ...usageAttributes(event.usage),
      };
    case "compaction.performed":
      return {
        [ATTR_OTELHOOK_COMPACTION_TRIGGER]: event.trigger,
        ...(event.contextTokensBefore === undefined
          ? {}
          : { [ATTR_OTELHOOK_CONTEXT_TOKENS_BEFORE]: event.contextTokensBefore }),
        ...(event.contextTokensAfter === undefined
          ? {}
          : { [ATTR_OTELHOOK_CONTEXT_TOKENS_AFTER]: event.contextTokensAfter }),
        ...(event.droppedMessageCount === undefined
          ? {}
          : { [ATTR_OTELHOOK_DROPPED_MESSAGES]: event.droppedMessageCount }),
        ...usageAttributes(event.usage),
      };
    case "error.raised":
      return {
        [ATTR_ERROR_TYPE]: event.errorCode,
        [ATTR_OTELHOOK_ERROR_PHASE]: event.phase,
        [ATTR_OTELHOOK_ERROR_RETRYABLE]: event.retryable,
        [ATTR_OTELHOOK_ERROR_SEVERITY]: event.severity,
      };
  }
};

const usageAttributes = (
  usage: { readonly inputTokens: number; readonly outputTokens: number } | undefined,
): LogAttributes =>
  usage === undefined
    ? {}
    : {
        [ATTR_GEN_AI_USAGE_INPUT_TOKENS]: usage.inputTokens,
        [ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]: usage.outputTokens,
      };

/** Content facts an event carries, paired with the field they came from. */
const contentFactsOf = (event: CanonicalEvent): readonly ContentFact[] => {
  switch (event.type) {
    case "prompt.submitted":
      return event.content === undefined ? [] : [event.content];
    case "generation.start":
      return event.inputContent ?? [];
    case "generation.end":
      return event.outputContent ?? [];
    case "tool.start":
      return event.input === undefined ? [] : [event.input];
    case "tool.end":
      return event.output === undefined ? [] : [event.output];
    case "error.raised":
      return event.message === undefined ? [] : [event.message];
    default:
      return [];
  }
};

type DisclosedBody =
  | { readonly text: string; readonly truncated: boolean }
  | { readonly withheld: ContentWithholdingReason };

const discloseBody = (fact: ContentFact, policy: LogContentPolicy): DisclosedBody => {
  if (fact.text === undefined) {
    return { withheld: "privacy-policy" };
  }
  if (!policy.includeContent) {
    return { withheld: "logs-content-disabled" };
  }
  if (fact.disclosure === "raw" && !policy.allowRawContent) {
    // Belt to the privacy service's braces: `resolvePrivacyPolicy` already
    // downgrades `raw` without the opt-in, so reaching here means a fact was built
    // outside that path. Refusing rather than trusting it keeps the opt-in a
    // property of the wire, not of one code path.
    return { withheld: "raw-not-permitted" };
  }
  const length = codePointLength(fact.text);
  return length <= MAX_LOG_BODY_CHARACTERS
    ? { text: fact.text, truncated: false }
    : { text: sliceCodePoints(fact.text, MAX_LOG_BODY_CHARACTERS), truncated: true };
};

const contentAttributes = (fact: ContentFact, body: DisclosedBody): LogAttributes => ({
  [ATTR_CONTENT_KIND]: fact.kind,
  ...(fact.role === undefined ? {} : { [ATTR_CONTENT_ROLE]: fact.role }),
  [ATTR_CONTENT_DISCLOSURE]: fact.disclosure,
  [ATTR_CONTENT_CHARACTER_LENGTH]: fact.characterLength,
  [ATTR_CONTENT_BYTE_LENGTH]: fact.byteLength,
  [ATTR_CONTENT_HASH]: fact.contentHash,
  [ATTR_CONTENT_TRUNCATED]: fact.truncated,
  [ATTR_CONTENT_SECRETS_REDACTED]: fact.secretsRedacted,
  ...(fact.label === undefined ? {} : { [ATTR_CONTENT_LABEL]: fact.label }),
  ...("withheld" in body
    ? { [ATTR_CONTENT_WITHHELD]: body.withheld }
    : { [ATTR_CONTENT_BODY_TRUNCATED]: body.truncated }),
});

export type LogMappingOptions = {
  readonly resource: Resource;
  readonly instrumentationScope?: InstrumentationScope;
  /** Whether disclosed text may reach a body. Defaults to {@link NO_LOG_CONTENT}. */
  readonly content?: LogContentPolicy;
  /**
   * The same cross-process pairing facts the span mapping is given, so a record's
   * `spanContext` names the span id that batch actually exported.
   */
  readonly correlations?: readonly SpanCorrelation[];
  /** See `SemanticMappingOptions.correlationAvailable`. */
  readonly correlationAvailable?: boolean;
};

export type LogMappingResult = {
  readonly records: readonly ReadableLogRecord[];
  /**
   * Content facts no record was produced for, because a bound was reached.
   *
   * Reported rather than truncated silently: a caller that logged "N records
   * exported" and nothing else would read a clipped batch as a complete one.
   */
  readonly droppedFacts: number;
};

const buildRecord = (input: {
  readonly event: CanonicalEvent;
  readonly signal: LogSignal;
  readonly attributes: LogAttributes;
  readonly body?: string;
  readonly spanContext: SpanContext;
  readonly resource: Resource;
  readonly scope: InstrumentationScope;
}): ReadableLogRecord => {
  const severityNumber = severityFor(input.event);
  const hrTime = millisToHrTime(input.event.occurredAt);
  return {
    hrTime,
    // A hook observes an event that already happened, and this mapping is pure —
    // there is no clock here to read a real observation time from. Reporting the
    // occurrence time for both is the honest answer: it says "this is when it
    // happened" twice rather than inventing a second, wrong timestamp.
    hrTimeObserved: hrTime,
    spanContext: input.spanContext,
    severityNumber,
    severityText: SEVERITY_TEXT[severityNumber] ?? "INFO",
    ...(input.body === undefined ? {} : { body: input.body }),
    eventName: `otelhook.${input.event.type}`,
    resource: input.resource,
    instrumentationScope: input.scope,
    attributes: {
      ...identityAttributes(input.event),
      [ATTR_OTELHOOK_EVENT_TYPE]: input.event.type,
      [ATTR_OTELHOOK_EVENT_ID]: input.event.eventId,
      [ATTR_OTELHOOK_EVENT_SEQUENCE]: input.event.sequence,
      [ATTR_OTELHOOK_LOG_SIGNAL]: input.signal,
      [ATTR_OTELHOOK_LOG_MAPPING_VERSION]: LOG_MAPPING_VERSION,
      ...input.attributes,
    },
    droppedAttributesCount: 0,
  };
};

/**
 * Map one invocation's canonical event batch into OTLP-ready log records.
 *
 * One record per content fact, and one record per event that carries none, so an
 * event is never silently absent from the stream just because the provider
 * reported no text for it.
 */
export const canonicalEventsToLogRecords = (
  events: readonly CanonicalEvent[],
  options: LogMappingOptions,
): LogMappingResult => {
  const scope = options.instrumentationScope ?? DEFAULT_INSTRUMENTATION_SCOPE;
  const content = options.content ?? NO_LOG_CONTENT;
  const identities = canonicalEventTraceIdentities(events, {
    ...(options.correlations === undefined ? {} : { correlations: options.correlations }),
    ...(options.correlationAvailable === undefined
      ? {}
      : { correlationAvailable: options.correlationAvailable }),
  });

  const records: ReadableLogRecord[] = [];
  let droppedFacts = 0;

  for (const event of events) {
    const identity = identities.get(event.eventId);
    if (identity === undefined) {
      // Unreachable: every event in the batch is given an identity above.
      continue;
    }
    const spanContext: SpanContext = {
      traceId: identity.traceId,
      spanId: identity.spanId,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: false,
    };
    const shared = eventAttributes(event);
    const facts = contentFactsOf(event);

    if (facts.length === 0) {
      if (records.length >= MAX_LOG_RECORDS_PER_BATCH) {
        droppedFacts += 1;
        continue;
      }
      records.push(
        buildRecord({
          event,
          signal: logSignalOf(event),
          attributes: shared,
          spanContext,
          resource: options.resource,
          scope,
        }),
      );
      continue;
    }

    let perEvent = 0;
    for (const fact of facts) {
      if (perEvent >= MAX_LOG_RECORDS_PER_EVENT || records.length >= MAX_LOG_RECORDS_PER_BATCH) {
        droppedFacts += 1;
        continue;
      }
      perEvent += 1;
      const body = discloseBody(fact, content);
      records.push(
        buildRecord({
          event,
          signal: logSignalOf(event, fact.kind),
          attributes: { ...shared, ...contentAttributes(fact, body) },
          ...("withheld" in body ? {} : { body: body.text }),
          spanContext,
          resource: options.resource,
          scope,
        }),
      );
    }
  }

  return { records, droppedFacts };
};
