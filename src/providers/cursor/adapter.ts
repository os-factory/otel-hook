import { createErrorInfo } from "../../errors/index.js";
import type { EventOutcome, ModelDescriptor } from "../../model/events.js";
import { identityClaimSchema, type IdentityClaim } from "../../model/identity.js";
import { invocationIdSchema } from "../../model/primitives.js";
import { deriveWorkspaceIdentity } from "../../privacy/workspace.js";
import type { IdGenerator } from "../../runtime/ports.js";
import {
  asProviderId,
  providerDetectionSchema,
  SILENT_HOOK_RESPONSE,
  unknownDetection,
  type ProviderAdapter,
  type ProviderCapabilities,
  type ProviderContext,
  type ProviderDetection,
  type ProviderDetectionInput,
  type ProviderHookResponse,
  type ProviderHookResponseInput,
  type ProviderIdentityInput,
  type ProviderParseInput,
  type ProviderParseResult,
} from "../adapter.js";
import { createEventFactory } from "../builder.js";
import {
  CURSOR_PROVIDER_ID,
  normalizeCursorPayload,
  type CursorModelInput,
  type CursorPayload,
} from "./payload.js";

/** Hook event names whose protocol expects a decision response on stdout. */
const DECISION_EVENT_NAMES: ReadonlySet<string> = new Set([
  "beforeSubmitPrompt",
  "before_user_prompt",
  "beforeToolUse",
  "before_tool_use",
  "beforeShellExecution",
  "before_shell_execution",
  "beforeMCPExecution",
  "before_mcp_execution",
  "beforeReadFile",
  "before_read_file",
]);

export const CURSOR_CAPABILITIES: ProviderCapabilities = Object.freeze({
  lifecycleEvents: Object.freeze([
    "session.start",
    "session.end",
    "prompt.submitted",
    "generation.start",
    "generation.end",
    "tool.start",
    "tool.end",
    "subagent.start",
    "subagent.end",
    "compaction.performed",
  ] as const),
  usageTemporality: "delta",
  // Cursor hooks carry no authoritative token or cache breakdown: every usage
  // capability below is declared false rather than guessed from a partial total.
  reportsCachedInput: false,
  reportsCacheCreation: false,
  cacheCreationAccounting: "not-reported",
  reportsReasoningOutput: false,
  reportsProviderTotal: false,
  reportsCost: false,
  emitsSubagentEvents: true,
  emitsCompactionEvents: true,
  requiresHookResponse: true,
});

/** Sentinel used when a payload carries no model information at all. */
const UNKNOWN_MODEL: ModelDescriptor = Object.freeze({ modelId: "unknown" });

const toModelDescriptor = (model: CursorModelInput | undefined): ModelDescriptor =>
  model === undefined
    ? UNKNOWN_MODEL
    : { modelId: model.name, ...(model.provider === undefined ? {} : { vendor: model.provider }) };

const STOP_REASON_TO_OUTCOME: Readonly<Record<"completed" | "cancelled" | "error" | "timeout", EventOutcome>> =
  Object.freeze({
    completed: "ok",
    cancelled: "cancelled",
    error: "error",
    timeout: "timeout",
  });

/**
 * Derive privacy-safe workspace identity from Cursor's observed workspace
 * roots. Never falls back to a process cwd: an absent or empty list simply
 * contributes no workspace claim, letting the core's `unknown` fallback apply.
 */
const deriveWorkspace = (
  context: ProviderContext,
  workspaceRoots: readonly string[] | undefined,
): ReturnType<typeof deriveWorkspaceIdentity> | undefined => {
  if (workspaceRoots === undefined || workspaceRoots.length === 0) {
    return undefined;
  }
  if (workspaceRoots.length === 1) {
    const [root] = workspaceRoots;
    return deriveWorkspaceIdentity(context.privacy, { kind: "working-directory", absolutePath: root ?? "" });
  }
  const sortedRoots = [...workspaceRoots].sort();
  return deriveWorkspaceIdentity(context.privacy, { kind: "explicit", value: sortedRoots.join("\n") });
};

/**
 * Stable per-call uniqueness fed into the invocation id hash. Never derived
 * from process state or wall-clock reads: every value here comes from the
 * payload itself, so replaying the same payload reproduces the same id.
 */
const invocationDiscriminator = (payload: CursorPayload): string | undefined => {
  switch (payload.hookEventName) {
    case "sessionStart":
    case "sessionEnd":
      return undefined;
    case "beforeSubmitPrompt":
      return payload.turnIndex === undefined ? payload.generationId : `turn:${String(payload.turnIndex)}`;
    case "afterAgentResponse":
    case "stop":
    case "afterAgentThought":
      return payload.generationId;
    case "beforeToolUse":
    case "afterToolUse":
    case "toolUseFailed":
      return payload.toolCallId;
    case "beforeShellExecution":
      return payload.toolCallId ?? `before:${payload.command}`;
    case "afterShellExecution":
      return payload.toolCallId ?? `after:${payload.command}`;
    case "beforeMCPExecution":
      return payload.toolCallId ?? `before:${payload.server}:${payload.tool}`;
    case "afterMCPExecution":
      return payload.toolCallId ?? `after:${payload.server}:${payload.tool}`;
    case "subagentStart":
    case "subagentStop":
      return payload.subagentInvocationId;
    case "preCompact":
      return payload.trigger;
    case "afterFileEdit":
      return payload.toolCallId ?? `edit:${payload.filePath}`;
    case "beforeReadFile":
      return payload.toolCallId ?? `read:${payload.filePath}`;
  }
};

type ToolCorrelation = "explicit" | "matched" | "uncorrelated";

/**
 * Resolve the tool call a dedicated "after" shell/MCP hook belongs to.
 *
 * Cursor's dedicated shell/MCP callbacks do not always carry the same call id
 * across the before/after pair. When it is absent, correlation is attempted
 * against the candidate open invocations the payload itself reports; a match
 * is only trusted when exactly one candidate is compatible. Zero or multiple
 * candidates stay uncorrelated rather than guessing.
 */
const resolveShellToolCallId = (
  payload: Extract<CursorPayload, { hookEventName: "afterShellExecution" }>,
  ids: IdGenerator,
  sessionId: string,
): { readonly toolCallId: string; readonly correlation: ToolCorrelation } => {
  if (payload.toolCallId !== undefined) {
    return { toolCallId: payload.toolCallId, correlation: "explicit" };
  }
  const candidates = (payload.openInvocations ?? []).filter(
    (candidate) => candidate.command === payload.command,
  );
  if (candidates.length === 1) {
    return { toolCallId: candidates[0]?.toolCallId ?? "", correlation: "matched" };
  }
  return {
    toolCallId: ids.newOpaqueId([sessionId, "shell", payload.command, String(payload.timestampMillis)]),
    correlation: "uncorrelated",
  };
};

const resolveMcpToolCallId = (
  payload: Extract<CursorPayload, { hookEventName: "afterMCPExecution" }>,
  ids: IdGenerator,
  sessionId: string,
): { readonly toolCallId: string; readonly correlation: ToolCorrelation } => {
  if (payload.toolCallId !== undefined) {
    return { toolCallId: payload.toolCallId, correlation: "explicit" };
  }
  const candidates = (payload.openInvocations ?? []).filter(
    (candidate) => candidate.server === payload.server && candidate.tool === payload.tool,
  );
  if (candidates.length === 1) {
    return { toolCallId: candidates[0]?.toolCallId ?? "", correlation: "matched" };
  }
  return {
    toolCallId: ids.newOpaqueId([sessionId, "mcp", payload.server, payload.tool, String(payload.timestampMillis)]),
    correlation: "uncorrelated",
  };
};

export type CursorAdapterOptions = {
  readonly version?: string;
};

/**
 * Provider adapter for Cursor's coding-agent hooks.
 *
 * See `./payload.ts` for the full provenance note on the synthetic payload
 * contract this adapter interprets.
 */
export const createCursorAdapter = (options: CursorAdapterOptions = {}): ProviderAdapter => {
  const id = asProviderId(CURSOR_PROVIDER_ID);
  const version = options.version ?? "1.0.0";
  const capabilities = CURSOR_CAPABILITIES;

  const detect = (input: ProviderDetectionInput): ProviderDetection => {
    const normalized = normalizeCursorPayload(input.payload);
    if (normalized === undefined) {
      return unknownDetection(["payload does not match the cursor hook contract (current or legacy)"]);
    }
    const reasons = normalized.isLegacy
      ? [
          `payload.hook_event_name "${normalized.rawEventName}" recognized as a legacy alias for "${normalized.payload.hookEventName}"`,
        ]
      : [`payload.hookEventName "${normalized.rawEventName}" recognized`];
    return providerDetectionSchema.parse({
      providerId: id,
      confidence: "exact",
      reasons,
      ...(normalized.payload.agentVersion === undefined
        ? {}
        : { providerVersion: normalized.payload.agentVersion }),
      sourceEventName: normalized.rawEventName,
    });
  };

  const identify = (
    input: ProviderIdentityInput,
    context: ProviderContext,
  ): readonly IdentityClaim[] => {
    const normalized = normalizeCursorPayload(input.payload);
    if (normalized === undefined) {
      return [];
    }
    const { payload } = normalized;
    const workspace = deriveWorkspace(context, payload.workspaceRoots);
    const discriminator = invocationDiscriminator(payload);
    const invocationId = context.ids.newInvocationId({
      providerId: id,
      sessionId: payload.conversationId,
      sourceEventName: payload.hookEventName,
      occurredAt: payload.timestampMillis,
      ...(discriminator === undefined ? {} : { discriminator }),
    });
    const claim = identityClaimSchema.parse({
      source: `adapter:${id}`,
      confidence: input.detection.confidence,
      fields: {
        // Cursor's own conversation id is used exactly as reported: never
        // normalized, parent/child matched, or substituted for a derived value.
        sessionId: payload.conversationId,
        invocationId,
        startedAt: payload.timestampMillis,
        ...(workspace === undefined ? {} : { workspace }),
      },
    });
    return [claim];
  };

  const parse = (input: ProviderParseInput, context: ProviderContext): ProviderParseResult => {
    const normalized = normalizeCursorPayload(input.payload);
    if (normalized === undefined) {
      return {
        status: "failed",
        error: createErrorInfo({
          code: "invalid-input",
          phase: "parsing",
          detail: "payload does not match the cursor hook contract (current or legacy)",
        }),
      };
    }

    const { payload, isLegacy, rawEventName } = normalized;
    const warnings: string[] = [];
    if (isLegacy) {
      warnings.push(`legacy event name "${rawEventName}" normalized to "${payload.hookEventName}"`);
    }

    if (payload.hookEventName === "stop" && payload.generationCompleted) {
      return {
        status: "ignored",
        reason: "generation outcome already reported by afterAgentResponse",
      };
    }

    const factory = createEventFactory({
      identity: input.identity,
      sequenceBase: input.sequenceBase,
      context,
    });
    const occurredAt = payload.timestampMillis;
    const sessionId = input.identity.sessionId;

    switch (payload.hookEventName) {
      case "sessionStart":
        factory.build({
          type: "session.start",
          sessionKind: payload.sessionKind ?? "unknown",
          ...(payload.agentName === undefined ? {} : { agentName: payload.agentName }),
          ...(payload.agentVersion === undefined ? {} : { agentVersion: payload.agentVersion }),
          ...(payload.model === undefined ? {} : { model: toModelDescriptor(payload.model) }),
          occurredAt,
        });
        break;

      case "sessionEnd":
        factory.build({
          type: "session.end",
          reason: payload.reason ?? "unknown",
          ...(payload.durationMillis === undefined ? {} : { durationMillis: payload.durationMillis }),
          occurredAt,
        });
        break;

      case "beforeSubmitPrompt":
        factory.build({
          type: "prompt.submitted",
          promptSource: payload.promptSource ?? "unknown",
          ...(payload.turnIndex === undefined ? {} : { turnIndex: payload.turnIndex }),
          ...(payload.promptText === undefined
            ? {}
            : {
                content: context.privacy.describeContent({
                  kind: "prompt",
                  role: "user",
                  text: payload.promptText,
                }),
              }),
          occurredAt,
        });
        factory.build({
          type: "generation.start",
          generationId: payload.generationId,
          model: toModelDescriptor(payload.model),
          occurredAt,
        });
        break;

      case "afterAgentResponse":
        factory.build({
          type: "generation.end",
          generationId: payload.generationId,
          model: toModelDescriptor(payload.model),
          outcome: payload.outcome ?? "ok",
          ...(payload.durationMillis === undefined ? {} : { durationMillis: payload.durationMillis }),
          ...(payload.responseText === undefined
            ? {}
            : {
                outputContent: [
                  context.privacy.describeContent({
                    kind: "response",
                    role: "assistant",
                    text: payload.responseText,
                  }),
                ],
              }),
          occurredAt,
        });
        break;

      case "beforeToolUse":
        factory.build({
          type: "tool.start",
          toolCallId: payload.toolCallId,
          toolName: payload.toolName,
          toolKind: payload.toolKind ?? "other",
          ...(payload.generationId === undefined ? {} : { generationId: payload.generationId }),
          ...(payload.toolInput === undefined
            ? {}
            : {
                input: context.privacy.describeStructured({
                  kind: "tool-input",
                  value: payload.toolInput,
                  label: payload.toolName,
                }),
              }),
          occurredAt,
        });
        break;

      case "afterToolUse":
        factory.build({
          type: "tool.end",
          toolCallId: payload.toolCallId,
          toolName: payload.toolName,
          outcome: "ok",
          ...(payload.durationMillis === undefined ? {} : { durationMillis: payload.durationMillis }),
          ...(payload.toolOutput === undefined
            ? {}
            : {
                output: context.privacy.describeStructured({
                  kind: "tool-output",
                  value: payload.toolOutput,
                  label: payload.toolName,
                }),
              }),
          occurredAt,
        });
        break;

      case "toolUseFailed":
        factory.build({
          type: "tool.end",
          toolCallId: payload.toolCallId,
          toolName: payload.toolName,
          outcome: "error",
          ...(payload.durationMillis === undefined ? {} : { durationMillis: payload.durationMillis }),
          ...(payload.errorText === undefined
            ? {}
            : {
                output: context.privacy.describeContent({
                  kind: "error-message",
                  text: payload.errorText,
                }),
              }),
          occurredAt,
        });
        break;

      case "beforeShellExecution": {
        const toolCallId =
          payload.toolCallId ??
          context.ids.newOpaqueId([sessionId, "shell", payload.command, String(occurredAt)]);
        factory.build({
          type: "tool.start",
          toolCallId,
          toolName: "shell",
          toolKind: "execute",
          ...(payload.generationId === undefined ? {} : { generationId: payload.generationId }),
          input: context.privacy.describeContent({ kind: "tool-input", text: payload.command, label: "shell" }),
          occurredAt,
        });
        break;
      }

      case "afterShellExecution": {
        const resolved = resolveShellToolCallId(payload, context.ids, sessionId);
        const outcome: EventOutcome = payload.exitCode !== undefined && payload.exitCode !== 0 ? "error" : "ok";
        factory.build({
          type: "tool.end",
          toolCallId: resolved.toolCallId,
          toolName: "shell",
          outcome,
          ...(payload.durationMillis === undefined ? {} : { durationMillis: payload.durationMillis }),
          ...(payload.outputText === undefined
            ? {}
            : {
                output: context.privacy.describeContent({
                  kind: "tool-output",
                  text: payload.outputText,
                  label: "shell",
                }),
              }),
          occurredAt,
          extensions: { "cursor.tool_correlation": resolved.correlation },
        });
        break;
      }

      case "beforeMCPExecution": {
        const toolCallId =
          payload.toolCallId ??
          context.ids.newOpaqueId([sessionId, "mcp", payload.server, payload.tool, String(occurredAt)]);
        const toolName = `${payload.server}:${payload.tool}`;
        factory.build({
          type: "tool.start",
          toolCallId,
          toolName,
          toolKind: "other",
          ...(payload.generationId === undefined ? {} : { generationId: payload.generationId }),
          ...(payload.input === undefined
            ? {}
            : {
                input: context.privacy.describeStructured({
                  kind: "tool-input",
                  value: payload.input,
                  label: toolName,
                }),
              }),
          occurredAt,
        });
        break;
      }

      case "afterMCPExecution": {
        const resolved = resolveMcpToolCallId(payload, context.ids, sessionId);
        const toolName = `${payload.server}:${payload.tool}`;
        factory.build({
          type: "tool.end",
          toolCallId: resolved.toolCallId,
          toolName,
          outcome: payload.isError === true ? "error" : "ok",
          ...(payload.durationMillis === undefined ? {} : { durationMillis: payload.durationMillis }),
          ...(payload.output === undefined
            ? {}
            : {
                output: context.privacy.describeStructured({
                  kind: "tool-output",
                  value: payload.output,
                  label: toolName,
                }),
              }),
          occurredAt,
          extensions: { "cursor.tool_correlation": resolved.correlation },
        });
        break;
      }

      case "subagentStart":
        factory.build({
          type: "subagent.start",
          subagentInvocationId: invocationIdSchema.parse(payload.subagentInvocationId),
          ...(payload.subagentType === undefined ? {} : { subagentType: payload.subagentType }),
          delegationDepth: payload.delegationDepth ?? 1,
          ...(payload.model === undefined ? {} : { model: toModelDescriptor(payload.model) }),
          occurredAt,
        });
        break;

      case "subagentStop":
        factory.build({
          type: "subagent.end",
          subagentInvocationId: invocationIdSchema.parse(payload.subagentInvocationId),
          outcome: payload.outcome ?? "unknown",
          ...(payload.durationMillis === undefined ? {} : { durationMillis: payload.durationMillis }),
          occurredAt,
        });
        break;

      case "preCompact":
        factory.build({
          type: "compaction.performed",
          trigger: payload.trigger ?? "unknown",
          ...(payload.contextTokensBefore === undefined
            ? {}
            : { contextTokensBefore: payload.contextTokensBefore }),
          occurredAt,
        });
        break;

      case "stop":
        // `generationCompleted` is checked above; only non-completed (i.e.
        // cancelled/error/timeout) statuses reach here, since a normal
        // completion was already reported by `afterAgentResponse`.
        factory.build({
          type: "generation.end",
          generationId: payload.generationId,
          model: toModelDescriptor(payload.model),
          outcome: STOP_REASON_TO_OUTCOME[payload.stopReason],
          stopReason: payload.stopReason,
          ...(payload.durationMillis === undefined ? {} : { durationMillis: payload.durationMillis }),
          occurredAt,
        });
        break;

      case "afterFileEdit": {
        const toolCallId =
          payload.toolCallId ??
          context.ids.newOpaqueId([sessionId, "file-edit", payload.filePath, String(occurredAt)]);
        const label = payload.editKind ?? "modify";
        factory.build({
          type: "tool.start",
          toolCallId,
          toolName: "edit_file",
          toolKind: "write",
          ...(payload.generationId === undefined ? {} : { generationId: payload.generationId }),
          occurredAt,
        });
        factory.build({
          type: "tool.end",
          toolCallId,
          toolName: "edit_file",
          outcome: "ok",
          output: context.privacy.describeContent({ kind: "tool-output", text: payload.filePath, label }),
          occurredAt,
        });
        break;
      }

      case "beforeReadFile": {
        const toolCallId =
          payload.toolCallId ??
          context.ids.newOpaqueId([sessionId, "read-file", payload.filePath, String(occurredAt)]);
        factory.build({
          type: "tool.start",
          toolCallId,
          toolName: "read_file",
          toolKind: "read",
          ...(payload.generationId === undefined ? {} : { generationId: payload.generationId }),
          input: context.privacy.describeContent({ kind: "tool-input", text: payload.filePath, label: "read_file" }),
          occurredAt,
        });
        break;
      }

      case "afterAgentThought": {
        // Reasoning has no dedicated canonical event type, so it is carried as
        // a `generation.end` scoped to its own derived generation id (never the
        // main turn's id) so it cannot be mistaken for the turn's response.
        const thoughtGenerationId = `${payload.generationId}.thought.${String(payload.thoughtIndex ?? 0)}`;
        factory.build({
          type: "generation.end",
          generationId: thoughtGenerationId,
          model: toModelDescriptor(payload.model),
          outcome: "ok",
          ...(payload.thoughtText === undefined
            ? {}
            : {
                outputContent: [
                  context.privacy.describeContent({
                    kind: "reasoning",
                    role: "assistant",
                    text: payload.thoughtText,
                  }),
                ],
              }),
          occurredAt,
          idDiscriminator: "thought",
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

  const hookResponse = (input: ProviderHookResponseInput): ProviderHookResponse => {
    const sourceEventName = input.detection?.sourceEventName;
    if (sourceEventName !== undefined && DECISION_EVENT_NAMES.has(sourceEventName)) {
      return {
        exitCode: 0,
        contract: "provider-protocol",
        stdout: JSON.stringify({ continue: true }),
      };
    }
    return SILENT_HOOK_RESPONSE;
  };

  return { id, version, capabilities, detect, identify, parse, hookResponse };
};
