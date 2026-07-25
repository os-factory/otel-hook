import { createErrorInfo } from "../../errors/index.js";
import type { ModelDescriptor } from "../../model/index.js";
import { createEventFactory } from "../builder.js";
import type { ProviderContext, ProviderParseInput, ProviderParseResult } from "../adapter.js";
import { subagentInvocationIdFor } from "./identity.js";
import { claudeHookPayloadSchema, type ClaudeUsage } from "./schema.js";
import { inferToolKind } from "./tool-kind.js";
import { normalizeClaudeUsage } from "./usage.js";

/**
 * Claude Code hooks never report a model identifier on the events this
 * adapter turns into `generation.start`/`generation.end` (`Stop`,
 * `StopFailure`). Using a real-looking model id here would assert something
 * the payload never said; `unknown` is the same honest-absence sentinel the
 * core model uses for provider and workspace identity.
 */
const UNKNOWN_MODEL: ModelDescriptor = { modelId: "unknown" };

type SessionEndReason = "completed" | "aborted" | "error" | "timeout" | "unknown";

const SESSION_END_REASON: Readonly<Record<string, SessionEndReason>> = Object.freeze({
  clear: "completed",
  resume: "completed",
  prompt_input_exit: "completed",
  logout: "aborted",
  bypass_permissions_disabled: "aborted",
  other: "unknown",
});

const mapSessionEndReason = (raw: string): SessionEndReason => SESSION_END_REASON[raw] ?? "unknown";

type CompactionTrigger = "automatic" | "manual" | "unknown";

const mapCompactTrigger = (raw: string | undefined): CompactionTrigger => {
  if (raw === "auto") {
    return "automatic";
  }
  if (raw === "manual") {
    return "manual";
  }
  return "unknown";
};

type GenerationOutcome = "ok" | "error" | "cancelled" | "timeout" | "denied" | "unknown";

/** `StopFailure` error categories that represent the request being refused rather than failing. */
const DENIED_STOP_FAILURE_TYPES: ReadonlySet<string> = new Set([
  "authentication_failed",
  "oauth_org_not_allowed",
  "billing_error",
]);

const mapStopFailureOutcome = (errorType: string): GenerationOutcome =>
  DENIED_STOP_FAILURE_TYPES.has(errorType) ? "denied" : "error";

const applyUsage = (normalized: ReturnType<typeof normalizeClaudeUsage>): { usage?: ReturnType<typeof normalizeClaudeUsage>["usage"] } =>
  normalized.usage === undefined ? {} : { usage: normalized.usage };

export const parseClaudeCode = (
  input: ProviderParseInput,
  context: ProviderContext,
): ProviderParseResult => {
  const parsed = claudeHookPayloadSchema.safeParse(input.payload);
  if (!parsed.success) {
    const rawEventName =
      typeof input.payload === "object" && input.payload !== null
        ? (input.payload as Record<string, unknown>).hook_event_name
        : undefined;
    return {
      status: "failed",
      error: createErrorInfo({
        code: "invalid-input",
        phase: "parsing",
        detail: `payload failed Claude Code schema validation: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "<root>"} ${issue.message}`)
          .join("; ")}`.slice(0, 480),
        details: { "hook.event_name": typeof rawEventName === "string" ? rawEventName : "" },
      }),
    };
  }
  const payload = parsed.data;

  const factory = createEventFactory({
    identity: input.identity,
    sequenceBase: input.sequenceBase,
    context,
  });
  const warnings: string[] = [];
  const withUsage = (usage: ClaudeUsage | undefined) => {
    const normalized = normalizeClaudeUsage(usage);
    warnings.push(...normalized.warnings);
    return applyUsage(normalized);
  };

  switch (payload.hook_event_name) {
    case "SessionStart":
      factory.build({
        type: "session.start",
        sessionKind: "unknown",
        agentName: "claude-code",
        ...(payload.model === undefined ? {} : { model: { modelId: payload.model } }),
      });
      break;

    case "SessionEnd":
      factory.build({
        type: "session.end",
        reason: mapSessionEndReason(payload.end_reason),
      });
      break;

    case "UserPromptSubmit":
      factory.build({
        type: "prompt.submitted",
        promptSource: "user",
        content: context.privacy.describeContent({ kind: "prompt", role: "user", text: payload.prompt }),
      });
      break;

    case "PreToolUse":
      factory.build({
        type: "tool.start",
        toolCallId: payload.tool_use_id,
        toolName: payload.tool_name,
        toolKind: inferToolKind(payload.tool_name),
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

    case "PostToolUse":
      factory.build({
        type: "tool.end",
        toolCallId: payload.tool_use_id,
        toolName: payload.tool_name,
        outcome: "ok",
        output: context.privacy.describeStructured({
          kind: "tool-output",
          value: payload.tool_response,
          label: payload.tool_name,
        }),
      });
      break;

    case "PostToolUseFailure":
      factory.build({
        type: "tool.end",
        toolCallId: payload.tool_use_id,
        toolName: payload.tool_name,
        outcome: "error",
        output: context.privacy.describeStructured({
          kind: "tool-output",
          value: payload.tool_error,
          label: payload.tool_name,
        }),
      });
      break;

    case "PermissionRequest":
      // The canonical model has no dedicated "permission requested" event: a
      // decision here either becomes a normal PreToolUse/PostToolUse pair (if
      // allowed) or the tool call never happens at all (if denied), so there
      // is nothing distinct to telemeter yet.
      return {
        status: "ignored",
        reason: "permission requests carry no telemetry independent of the tool call they gate",
      };

    case "SubagentStart":
      factory.build({
        type: "subagent.start",
        subagentInvocationId: subagentInvocationIdFor(context, payload.session_id, payload.agent_id),
        subagentType: payload.agent_type,
        delegationDepth: 1,
      });
      break;

    case "SubagentStop":
      factory.build({
        type: "subagent.end",
        subagentInvocationId: subagentInvocationIdFor(context, payload.session_id, payload.agent_id),
        outcome: "ok",
        ...withUsage(payload.usage),
      });
      break;

    case "PreCompact":
      // Fires before compaction runs, with only an estimate; the completed
      // operation is reported once at PostCompact instead.
      return {
        status: "ignored",
        reason: "compaction is reported once it completes, at PostCompact",
      };

    case "PostCompact":
      factory.build({
        type: "compaction.performed",
        trigger: mapCompactTrigger(payload.compact_trigger),
        ...(payload.context_tokens_before === undefined ? {} : { contextTokensBefore: payload.context_tokens_before }),
        ...(payload.context_tokens_after === undefined ? {} : { contextTokensAfter: payload.context_tokens_after }),
        ...(payload.dropped_message_count === undefined ? {} : { droppedMessageCount: payload.dropped_message_count }),
        ...withUsage(payload.usage),
      });
      break;

    case "Stop": {
      const generationId = context.ids.newOpaqueId([
        "claude-generation",
        payload.session_id,
        payload.prompt_id ?? String(input.sequenceBase),
      ]);
      factory.build({ type: "generation.start", generationId, model: UNKNOWN_MODEL });
      factory.build({
        type: "generation.end",
        generationId,
        model: UNKNOWN_MODEL,
        outcome: "ok",
        ...withUsage(payload.usage),
      });
      break;
    }

    case "StopFailure": {
      const generationId = context.ids.newOpaqueId([
        "claude-generation",
        payload.session_id,
        payload.prompt_id ?? String(input.sequenceBase),
      ]);
      factory.build({ type: "generation.start", generationId, model: UNKNOWN_MODEL });
      factory.build({
        type: "generation.end",
        generationId,
        model: UNKNOWN_MODEL,
        outcome: mapStopFailureOutcome(payload.error_type),
        stopReason: payload.error_type,
        ...withUsage(payload.usage),
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
