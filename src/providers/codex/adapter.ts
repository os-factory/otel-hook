import { createErrorInfo } from "../../errors/index.js";
import type { EventOutcome } from "../../model/events.js";
import { identityClaimSchema, type IdentityClaim } from "../../model/identity.js";
import {
  invocationIdSchema,
  sessionIdSchema,
  type InvocationId,
  type SessionId,
} from "../../model/primitives.js";
import { normalizeUsage, type CanonicalUsage } from "../../model/usage.js";
import { deriveWorkspaceIdentity } from "../../privacy/workspace.js";
import {
  providerDetectionSchema,
  SILENT_HOOK_RESPONSE,
  unknownDetection,
  type ProviderAdapter,
  type ProviderCapabilities,
  type ProviderContext,
  type ProviderDetection,
  type ProviderDetectionInput,
  type ProviderHookResponse,
  type ProviderIdentityInput,
  type ProviderParseInput,
  type ProviderParseResult,
} from "../adapter.js";
import { createEventFactory } from "../builder.js";
import {
  codexHookEnvelopeSchema,
  codexHookPayloadSchema,
  type CodexHookPayload,
  type CodexUsage,
} from "./payload.js";
import { codexDeliveryIdentity } from "./delivery.js";
import { classifyCodexToolKind } from "./tool-kind.js";
import { codexUsageToReport } from "./usage.js";
import { CODEX_ADAPTER_VERSION, CODEX_PROVIDER_ID } from "./version.js";

/**
 * Codex has no dependable `SessionEnd` (see AGENT.md task scope), so
 * `session.end` is deliberately absent from {@link CODEX_CAPABILITIES}.
 * `Stop` — fired reliably at the end of every turn — is mapped to
 * `generation.end` instead, giving a host's state store a steady stream of
 * per-session activity it can use for TTL-based session finalization.
 */
export const CODEX_CAPABILITIES: ProviderCapabilities = Object.freeze({
  lifecycleEvents: Object.freeze([
    "session.start",
    "prompt.submitted",
    "generation.end",
    "tool.start",
    "tool.end",
    "subagent.start",
    "subagent.end",
    "compaction.performed",
  ] as const),
  usageTemporality: "cumulative",
  reportsCachedInput: true,
  reportsCacheCreation: false,
  cacheCreationAccounting: "not-reported",
  reportsReasoningOutput: true,
  reportsProviderTotal: true,
  reportsCost: false,
  emitsSubagentEvents: true,
  emitsCompactionEvents: true,
  requiresHookResponse: false,
  // Tool, subagent, and per-turn callbacks carry a replay-stable id; session and
  // compaction callbacks do not. See `./delivery.ts` for which and why.
  deliveryIdentifier: "partial",
});

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** A Codex-specific marker strong enough to resolve a `strong` match to `exact`. */
const hasExactMarker = (payload: CodexHookPayload): boolean => {
  if (payload.codex_version !== undefined) {
    return true;
  }
  if (payload.permission_mode === "dontAsk") {
    return true;
  }
  return "tool_name" in payload && payload.tool_name === "apply_patch";
};

const detect = (input: ProviderDetectionInput): ProviderDetection => {
  const parsed = codexHookPayloadSchema.safeParse(input.payload);
  if (parsed.success) {
    const payload = parsed.data;
    const exact = hasExactMarker(payload);
    return providerDetectionSchema.parse({
      providerId: CODEX_PROVIDER_ID,
      confidence: exact ? "exact" : "strong",
      reasons: [
        "payload.hook_event_name matches the Codex hook protocol",
        ...(exact ? ["payload carries a Codex-specific marker"] : []),
      ],
      ...(payload.codex_version === undefined ? {} : { providerVersion: payload.codex_version }),
      sourceEventName: payload.hook_event_name,
    });
  }

  const envelope = codexHookEnvelopeSchema.safeParse(input.payload);
  if (envelope.success) {
    return providerDetectionSchema.parse({
      providerId: CODEX_PROVIDER_ID,
      confidence: "weak",
      reasons: [
        "payload.hook_event_name is a known Codex event but failed schema validation for it",
      ],
      sourceEventName: envelope.data.hook_event_name,
    });
  }

  return unknownDetection(["payload does not match the Codex hook protocol"]);
};

/** Per-event field that distinguishes concurrent hook calls in one session. */
const eventDiscriminator = (payload: CodexHookPayload): string | undefined => {
  switch (payload.hook_event_name) {
    case "PreToolUse":
    case "PermissionRequest":
    case "PostToolUse":
      return payload.tool_call_id ?? payload.tool_name;
    case "SubagentStart":
    case "SubagentStop":
      return payload.subagent_id;
    case "UserPromptSubmit":
    case "Stop":
      return payload.turn_id;
    case "SessionStart":
    case "PreCompact":
    case "PostCompact":
      return undefined;
  }
};

const identify = (
  input: ProviderIdentityInput,
  context: ProviderContext,
): readonly IdentityClaim[] => {
  const parsed = codexHookPayloadSchema.safeParse(input.payload);
  if (!parsed.success) {
    return [];
  }
  const payload = parsed.data;
  const occurredAt = payload.occurred_at ?? context.clock.now();
  const sessionId = sessionIdSchema.parse(payload.session_id);
  const discriminator = eventDiscriminator(payload);
  const invocationId = context.ids.newInvocationId({
    providerId: CODEX_PROVIDER_ID,
    sessionId,
    sourceEventName: payload.hook_event_name,
    occurredAt,
    ...(discriminator === undefined ? {} : { discriminator }),
  });
  const workspace =
    payload.cwd === undefined
      ? undefined
      : deriveWorkspaceIdentity(context.privacy, { kind: "working-directory", absolutePath: payload.cwd });

  const claim = identityClaimSchema.parse({
    source: `adapter:${CODEX_PROVIDER_ID}`,
    confidence: input.detection.confidence,
    fields: {
      sessionId,
      invocationId,
      startedAt: occurredAt,
      ...(workspace === undefined ? {} : { workspace }),
    },
  });
  return [claim];
};

/**
 * Time-independent correlation key for a subagent, so `SubagentStart` and
 * `SubagentStop` — two separate hook process invocations — agree on the same
 * `subagentInvocationId` even though they occur at different times.
 */
const deriveSubagentInvocationId = (
  context: ProviderContext,
  sessionId: SessionId,
  subagentId: string,
): InvocationId =>
  invocationIdSchema.parse(
    `subinv_${context.ids.newOpaqueId(["codex", "subagent", sessionId, subagentId])}`,
  );

const outcomeFromToolResponse = (toolResponse: unknown): EventOutcome => {
  if (toolResponse === undefined) {
    return "unknown";
  }
  const record = asRecord(toolResponse);
  if (record === undefined) {
    return "ok";
  }
  if (typeof record.success === "boolean") {
    return record.success ? "ok" : "error";
  }
  if (typeof record.exit_code === "number" && record.exit_code !== 0) {
    return "error";
  }
  if (record.error !== undefined && record.error !== null && record.error !== false) {
    return "error";
  }
  return "ok";
};

const mapTrigger = (trigger: "auto" | "manual" | undefined): "automatic" | "manual" | "unknown" => {
  if (trigger === "auto") {
    return "automatic";
  }
  if (trigger === "manual") {
    return "manual";
  }
  return "unknown";
};

const mapSubagentOutcome = (
  status: "completed" | "failed" | "cancelled" | undefined,
): EventOutcome => {
  switch (status) {
    case "completed":
      return "ok";
    case "failed":
      return "error";
    case "cancelled":
      return "cancelled";
    default:
      return "unknown";
  }
};

const mapStopOutcome = (stopReason: string | undefined): EventOutcome => {
  if (stopReason === undefined) {
    return "ok";
  }
  const normalized = stopReason.toLowerCase();
  if (normalized.includes("cancel")) {
    return "cancelled";
  }
  if (normalized.includes("timeout")) {
    return "timeout";
  }
  if (normalized.includes("error") || normalized.includes("fail")) {
    return "error";
  }
  return "ok";
};

const parse = (input: ProviderParseInput, context: ProviderContext): ProviderParseResult => {
  const parsed = codexHookPayloadSchema.safeParse(input.payload);
  if (!parsed.success) {
    return {
      status: "failed",
      error: createErrorInfo({
        code: "invalid-input",
        phase: "parsing",
        detail: "payload does not match the Codex hook protocol",
      }),
    };
  }
  const payload = parsed.data;
  const occurredAt = payload.occurred_at ?? context.clock.now();
  const factory = createEventFactory({
    identity: input.identity,
    sequenceBase: input.sequenceBase,
    context,
  });
  const warnings: string[] = [];

  const buildUsage = (usage: CodexUsage | undefined): CanonicalUsage | undefined => {
    if (usage === undefined) {
      return undefined;
    }
    // Codex's hook-carried usage mirrors the rollout's cumulative
    // `total_token_usage`; see docs/usage-semantics.md.
    const normalized = normalizeUsage(codexUsageToReport(usage, "cumulative"));
    if (normalized.status === "invalid") {
      warnings.push(...normalized.issues.map((issue) => issue.message));
      return undefined;
    }
    return normalized.usage;
  };

  switch (payload.hook_event_name) {
    case "SessionStart":
      factory.build({
        type: "session.start",
        sessionKind: "unknown",
        agentName: "codex",
        occurredAt,
        ...(payload.codex_version === undefined ? {} : { agentVersion: payload.codex_version }),
        ...(payload.model === undefined ? {} : { model: { modelId: payload.model, vendor: "openai" } }),
      });
      break;

    case "UserPromptSubmit":
      factory.build({
        type: "prompt.submitted",
        promptSource: "user",
        occurredAt,
        ...(payload.prompt === undefined
          ? {}
          : {
              content: context.privacy.describeContent({
                kind: "prompt",
                role: "user",
                text: payload.prompt,
              }),
            }),
      });
      break;

    case "PreToolUse": {
      const toolCallId =
        payload.tool_call_id ??
        context.ids.newOpaqueId([input.identity.sessionId, payload.turn_id ?? "", payload.tool_name]);
      factory.build({
        type: "tool.start",
        toolCallId,
        toolName: payload.tool_name,
        toolKind: classifyCodexToolKind(payload.tool_name),
        occurredAt,
        ...(payload.tool_input === undefined
          ? {}
          : {
              input: context.privacy.describeStructured({
                kind: "tool-input",
                value: payload.tool_input,
                label: payload.tool_name,
              }),
            }),
      });
      break;
    }

    case "PermissionRequest":
      // No canonical event type represents an in-flight approval decision;
      // it surfaces as `permissionDecision` on the paired `tool.end`. This
      // hook is only ever a silent observer here (see `hookResponse`), never
      // a party to the actual allow/deny decision.
      return {
        status: "ignored",
        reason: "permission requests carry no telemetry of their own; the decision surfaces on tool.end",
      };

    case "PostToolUse": {
      const toolCallId =
        payload.tool_call_id ??
        context.ids.newOpaqueId([input.identity.sessionId, payload.turn_id ?? "", payload.tool_name]);
      const permissionDecision = payload.permission_decision ?? "not-required";
      const outcome =
        permissionDecision === "denied" ? "denied" : outcomeFromToolResponse(payload.tool_response);
      factory.build({
        type: "tool.end",
        toolCallId,
        toolName: payload.tool_name,
        outcome,
        permissionDecision,
        occurredAt,
        ...(payload.duration_ms === undefined ? {} : { durationMillis: payload.duration_ms }),
        ...(payload.tool_response === undefined
          ? {}
          : {
              output: context.privacy.describeStructured({
                kind: "tool-output",
                value: payload.tool_response,
                label: payload.tool_name,
              }),
            }),
      });
      break;
    }

    case "PreCompact":
      factory.build({
        type: "compaction.performed",
        trigger: mapTrigger(payload.trigger),
        occurredAt,
        ...(payload.context_tokens_before === undefined
          ? {}
          : { contextTokensBefore: payload.context_tokens_before }),
      });
      break;

    case "PostCompact": {
      const usage = buildUsage(payload.usage);
      factory.build({
        type: "compaction.performed",
        trigger: mapTrigger(payload.trigger),
        occurredAt,
        ...(payload.context_tokens_after === undefined
          ? {}
          : { contextTokensAfter: payload.context_tokens_after }),
        ...(payload.dropped_message_count === undefined
          ? {}
          : { droppedMessageCount: payload.dropped_message_count }),
        ...(usage === undefined ? {} : { usage }),
      });
      break;
    }

    case "SubagentStart": {
      const subagentInvocationId = deriveSubagentInvocationId(
        context,
        input.identity.sessionId,
        payload.subagent_id,
      );
      factory.build({
        type: "subagent.start",
        subagentInvocationId,
        delegationDepth: 1,
        occurredAt,
        ...(payload.subagent_type === undefined ? {} : { subagentType: payload.subagent_type }),
        ...(payload.model === undefined ? {} : { model: { modelId: payload.model, vendor: "openai" } }),
      });
      break;
    }

    case "SubagentStop": {
      const subagentInvocationId = deriveSubagentInvocationId(
        context,
        input.identity.sessionId,
        payload.subagent_id,
      );
      const usage = buildUsage(payload.usage);
      factory.build({
        type: "subagent.end",
        subagentInvocationId,
        outcome: mapSubagentOutcome(payload.status),
        occurredAt,
        ...(usage === undefined ? {} : { usage }),
      });
      break;
    }

    case "Stop": {
      const generationId =
        payload.turn_id ?? context.ids.newOpaqueId([input.identity.sessionId, "stop", String(occurredAt)]);
      const usage = buildUsage(payload.usage);
      factory.build({
        type: "generation.end",
        generationId,
        model: {
          modelId: payload.model ?? "unknown",
          ...(payload.model === undefined ? {} : { vendor: "openai" }),
        },
        outcome: mapStopOutcome(payload.stop_reason),
        occurredAt,
        ...(payload.stop_reason === undefined ? {} : { stopReason: payload.stop_reason }),
        ...(payload.duration_ms === undefined ? {} : { durationMillis: payload.duration_ms }),
        ...(usage === undefined ? {} : { usage }),
      });
      break;
    }
  }

  return {
    status: "parsed",
    events: factory.events(),
    ...(warnings.length === 0 ? {} : { warnings }),
  };
};

/**
 * A telemetry sidecar must never become a policy hook. Regardless of event
 * type or attribution outcome, this adapter answers every hook call silently
 * (ADR 0004): it never emits a `permissionDecision`, `continue: false`, or any
 * other field that could influence Codex's own control flow.
 */
const hookResponse = (): ProviderHookResponse => SILENT_HOOK_RESPONSE;

export const createCodexAdapter = (): ProviderAdapter => ({
  id: CODEX_PROVIDER_ID,
  version: CODEX_ADAPTER_VERSION,
  capabilities: CODEX_CAPABILITIES,
  detect,
  identify,
  deliveryIdentity: codexDeliveryIdentity,
  parse,
  hookResponse,
});
