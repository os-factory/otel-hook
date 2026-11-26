import { createErrorInfo } from "../../errors/index.js";
import type { ModelDescriptor } from "../../model/index.js";
import { createEventFactory } from "../builder.js";
import type { ProviderContext, ProviderParseInput, ProviderParseResult } from "../adapter.js";
import { subagentInvocationIdFor } from "./identity.js";
import { normalizeClaudeHookPayload } from "./payload-normalize.js";
import { claudeHookPayloadSchema, type ClaudeUsage } from "./schema.js";
import { extractClaudeAssistantText } from "./stop-content.js";
import { sessionCwdHint } from "../../model/target.js";
import { claudeTargetHint } from "./target.js";
import { inferToolKind } from "./tool-kind.js";
import { extractClaudeUsage, normalizeClaudeUsage } from "./usage.js";

/**
 * Claude Code hooks never report a model identifier on the events this
 * adapter turns into `generation.start`/`generation.end` (`Stop`,
 * `StopFailure`). Only `SessionStart` names one.
 *
 * So a generation's model comes from, in order:
 *
 * 1. a `model` a wrapping harness attached to the stop payload — the per-turn
 *    model it read from the transcript's last assistant message, the only
 *    source that follows a `/model` switch exactly;
 * 2. the session's model, which the core remembers from `SessionStart` (or the
 *    last turn that named one) and hands in as `sessionModel` (ADR 0006: the
 *    adapter itself holds no cross-invocation state);
 * 3. `unknown`, when nothing in this session ever named a model. Using a
 *    real-looking model id here would assert something no payload said;
 *    `unknown` is the same honest-absence sentinel the core model uses for
 *    provider and workspace identity.
 *
 * The request model (`generation.start`) prefers the session's model, since that
 * is what the turn was sent to; the response model (`generation.end`) prefers the
 * attached per-turn one, since that is what answered.
 */
const UNKNOWN_MODEL: ModelDescriptor = { modelId: "unknown" };

const generationModels = (
  attached: string | undefined,
  sessionModel: ModelDescriptor | undefined,
): { readonly request: ModelDescriptor; readonly response: ModelDescriptor } => {
  const turnModel: ModelDescriptor | undefined = attached === undefined ? undefined : { modelId: attached };
  return {
    request: sessionModel ?? turnModel ?? UNKNOWN_MODEL,
    response: turnModel ?? sessionModel ?? UNKNOWN_MODEL,
  };
};

type SessionEndReason = "completed" | "aborted" | "error" | "timeout" | "unknown";

const SESSION_END_REASON: Readonly<Record<string, SessionEndReason>> = Object.freeze({
  completed: "completed",
  aborted: "aborted",
  error: "error",
  timeout: "timeout",
  clear: "completed",
  resume: "completed",
  prompt_input_exit: "completed",
  logout: "aborted",
  bypass_permissions_disabled: "aborted",
  other: "unknown",
});

const mapSessionEndReason = (raw: string | undefined): SessionEndReason =>
  raw === undefined ? "unknown" : (SESSION_END_REASON[raw] ?? "unknown");

type CompactionTrigger = "automatic" | "manual" | "unknown";

const mapCompactTrigger = (raw: string | undefined): CompactionTrigger => {
  if (raw === "auto" || raw === "automatic") {
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
  const normalizedPayload = normalizeClaudeHookPayload(input.payload);
  const parsed = claudeHookPayloadSchema.safeParse(normalizedPayload);
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
  const extractedUsage = extractClaudeUsage(normalizedPayload);

  const factory = createEventFactory({
    identity: input.identity,
    sequenceBase: input.sequenceBase,
    context,
    // Present exactly when the hook fired inside a subagent (or describes one,
    // on SubagentStart/SubagentStop).
    ...(payload.agent_id === undefined ? {} : { subagentId: payload.agent_id }),
  });
  const warnings: string[] = [];
  const targetHintFor = (toolName: string, toolInput: unknown) => {
    const hint = claudeTargetHint(toolName, toolInput, payload.cwd);
    return hint === undefined ? {} : { targetHint: hint };
  };
  // The session's own directory: where it runs before any tool names a path.
  const sessionHint = sessionCwdHint(payload.cwd);
  const sessionTarget = sessionHint === undefined ? {} : { targetHint: sessionHint };
  const withUsage = (usage: ClaudeUsage | undefined) => {
    const normalized = normalizeClaudeUsage(usage);
    warnings.push(...normalized.warnings);
    return applyUsage(normalized);
  };

  /** Usage plus the attacher's statement of whether it covers the whole turn. */
  const withPartialUsage = (usage: ClaudeUsage | undefined, partial: boolean | undefined) => {
    const applied = withUsage(usage);
    return applied.usage === undefined || partial === undefined ? applied : { ...applied, usagePartial: partial };
  };

  switch (payload.hook_event_name) {
    case "SessionStart":
      factory.build({
        type: "session.start",
        sessionKind: "unknown",
        agentName: "claude-code",
        ...(payload.model === undefined ? {} : { model: { modelId: payload.model } }),
        ...sessionTarget,
      });
      break;

    case "SessionEnd":
      factory.build({
        type: "session.end",
        reason: mapSessionEndReason(payload.reason ?? payload.end_reason),
        ...withUsage(extractedUsage),
      });
      break;

    case "UserPromptSubmit":
      factory.build({
        type: "prompt.submitted",
        promptSource: "user",
        content: context.privacy.describeContent({ kind: "prompt", role: "user", text: payload.prompt }),
        ...sessionTarget,
      });
      break;

    case "PreToolUse":
      factory.build({
        type: "tool.start",
        toolCallId: payload.tool_use_id,
        toolName: payload.tool_name,
        toolKind: inferToolKind(payload.tool_name),
        ...targetHintFor(payload.tool_name, payload.tool_input),
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
        ...targetHintFor(payload.tool_name, payload.tool_input),
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
        ...targetHintFor(payload.tool_name, payload.tool_input),
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

    case "SubagentStop": {
      // The subagent's tokens (attached from its own transcript, issue #68) are
      // reported on a generation inside the subagent, where metrics and receivers
      // count generation spend, and nowhere else: not on the subagent span, which
      // would restate them, and not on the parent turn, which never sums sidechain
      // requests. The model is the subagent's own; the session's would be a guess.
      const usage = withPartialUsage(extractedUsage ?? payload.usage, payload.usage_partial);
      if (usage.usage !== undefined || payload.model !== undefined) {
        // Replay-stable for the once-per-run stop, which is also what delivery
        // deduplicates on (`delivery.ts`): a reclaimed delivery folds into the
        // same generation instead of opening a second one. A hook-continued stop
        // repeats `agent_id`, so it needs the sequence to be a generation of its own.
        const generationId = context.ids.newOpaqueId([
          "claude-subagent-generation",
          payload.session_id,
          payload.agent_id,
          ...(payload.stop_hook_active === true ? [String(input.sequenceBase)] : []),
        ]);
        const models = generationModels(payload.model, undefined);
        factory.build({ type: "generation.start", generationId, model: models.request });
        factory.build({
          type: "generation.end",
          generationId,
          model: models.response,
          outcome: "ok",
          outputContent: [
            payload.last_assistant_message === undefined
              ? context.privacy.describeUnavailableContent({ kind: "response", role: "assistant" })
              : context.privacy.describeContent({
                  kind: "response",
                  role: "assistant",
                  text: payload.last_assistant_message,
                }),
          ],
          ...usage,
        });
      }
      factory.build({
        type: "subagent.end",
        subagentInvocationId: subagentInvocationIdFor(context, payload.session_id, payload.agent_id),
        outcome: "ok",
      });
      break;
    }

    case "PreCompact":
      // Fires before compaction runs; the completed operation is reported once at
      // PostCompact instead. Claude Code reports no token count on either
      // compaction callback (docs/claude-code-usage-contract.md, finding 6), so
      // nothing is lost by ignoring this edge — but a *harness* may have attached
      // a before-figure here, and dropping that silently is what made
      // ADAPTER-NOTE-002 look like a plumbing gap. It is an exclusion, so it says
      // so: carrying the figure to PostCompact would need cross-invocation state
      // an adapter must not hold (ADR 0006), and the same harness can attach it to
      // PostCompact, where one callback carries both ends.
      // Kept inside the 160 characters an ignore reason survives at the log
      // boundary, so the remedy is not the part that gets truncated away.
      return {
        status: "ignored",
        reason:
          payload.context_tokens_before === undefined
            ? "compaction is reported once it completes, at PostCompact"
            : "contextTokensBefore is an explicit exclusion for this provider: attach " +
              "context_tokens_before to PostCompact, which carries both ends in one callback",
      };

    case "PostCompact":
      factory.build({
        type: "compaction.performed",
        trigger: mapCompactTrigger(payload.trigger ?? payload.compact_trigger),
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
      const assistantText = extractClaudeAssistantText(normalizedPayload);
      const models = generationModels(payload.model, input.sessionModel);
      factory.build({ type: "generation.start", generationId, model: models.request });
      factory.build({
        type: "generation.end",
        generationId,
        model: models.response,
        outcome: "ok",
        // Always a response fact: a body when Claude sent text, otherwise a
        // zero-length omitted fact so the log mapping can emit metadata_only
        // instead of a generation.end with no content.kind.
        outputContent: [
          assistantText === undefined
            ? context.privacy.describeUnavailableContent({ kind: "response", role: "assistant" })
            : context.privacy.describeContent({
                kind: "response",
                role: "assistant",
                text: assistantText,
              }),
        ],
        ...withPartialUsage(extractedUsage ?? payload.usage, payload.usage_partial),
      });
      break;
    }

    case "StopFailure": {
      const generationId = context.ids.newOpaqueId([
        "claude-generation",
        payload.session_id,
        payload.prompt_id ?? String(input.sequenceBase),
      ]);
      const assistantText = extractClaudeAssistantText(normalizedPayload);
      const models = generationModels(payload.model, input.sessionModel);
      factory.build({ type: "generation.start", generationId, model: models.request });
      factory.build({
        type: "generation.end",
        generationId,
        model: models.response,
        outcome: mapStopFailureOutcome(payload.error_type),
        stopReason: payload.error_type,
        ...(assistantText === undefined
          ? {}
          : {
              outputContent: [
                context.privacy.describeContent({
                  kind: "response",
                  role: "assistant",
                  text: assistantText,
                }),
              ],
            }),
        ...withPartialUsage(extractedUsage ?? payload.usage, payload.usage_partial),
      });
      break;
    }
  }

  const targetHints = factory.targetHints();
  return {
    status: "parsed",
    events: factory.events(),
    ...(warnings.length === 0 ? {} : { warnings }),
    ...(targetHints.size === 0 ? {} : { targetHints }),
  };
};
