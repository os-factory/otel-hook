/**
 * Comparison-only mapping from synthetic, third-party-shaped hook payloads to
 * canonical events.
 *
 * This is NOT a provider adapter: it is not registered with
 * `createProviderRegistry`, is not shipped in `dist`, and exists solely so the
 * parity harness can compare our canonical semantics against
 * `opentelemetry-hooks` for the *same* input payload. It deliberately uses only
 * the public `@osfactory/otel-hook` surface (`createEventFactory`,
 * `createPrivacyService`, `deriveWorkspaceIdentity`, ...) the same way a real
 * adapter would, so the comparison reflects real library behavior.
 */
import type { CanonicalEvent, CanonicalUsage, ToolKind } from "../../../src/model/index.js";
import {
  invocationIdentitySchema,
  normalizeUsage,
  sourceProvenanceSchema,
  type InvocationIdentity,
} from "../../../src/model/index.js";
import { createPrivacyService, deriveWorkspaceIdentity, type PrivacyService } from "../../../src/privacy/index.js";
import { DEFAULT_CONFIG } from "../../../src/config/index.js";
import { createEventFactory, type ProviderContext } from "../../../src/providers/index.js";
import { createDeterministicIdGenerator, createFixedClock, createRecordingLogger } from "../../../src/runtime/index.js";

export type ParityMappingResult = {
  readonly events: readonly CanonicalEvent[];
  readonly droppedExtensionKeys: readonly string[];
};

const buildContext = (): ProviderContext => {
  const privacy: PrivacyService = createPrivacyService(DEFAULT_CONFIG.privacy);
  return {
    privacy,
    clock: createFixedClock({ startMillis: 1_700_000_000_000, tickMillis: 1_000 }),
    ids: createDeterministicIdGenerator({ namespace: "parity" }),
    logger: createRecordingLogger("silent"),
    limits: DEFAULT_CONFIG.privacy.limits,
  };
};

const buildIdentity = (
  context: ProviderContext,
  input: {
    readonly providerId: string;
    readonly sessionId: string;
    readonly cwd?: string;
  },
): InvocationIdentity => {
  const workspace = deriveWorkspaceIdentity(
    context.privacy,
    input.cwd === undefined ? { kind: "unknown" } : { kind: "explicit", value: input.cwd },
  );
  return invocationIdentitySchema.parse({
    invocationId: context.ids.newInvocationId({
      providerId: input.providerId,
      sessionId: input.sessionId,
      occurredAt: context.clock.now(),
    }),
    sessionId: input.sessionId,
    provenance: sourceProvenanceSchema.parse({
      providerId: input.providerId,
      adapterId: `parity-mapper:${input.providerId}`,
      adapterVersion: "0.0.0-parity",
      detectionConfidence: "exact",
      transport: "test-fixture",
    }),
    workspace,
    startedAt: context.clock.now(),
    consumerAttributes: {},
  });
};

type ClaudeCodePayload = {
  readonly hook_event_name: string;
  readonly session_id: string;
  readonly cwd?: string;
  readonly prompt?: string;
  readonly tool_use_id?: string;
  readonly tool_name?: string;
  readonly tool_input?: unknown;
  readonly tool_response?: unknown;
  readonly duration_ms?: number;
  readonly trigger?: "automatic" | "manual";
  readonly context_tokens_before?: number;
  readonly context_tokens_after?: number;
  readonly last_assistant_message?: string;
  readonly reason?: string;
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly cache_creation_input_tokens?: number;
  readonly reasoning_output_tokens?: number;
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly total_tokens?: number;
  };
};

/** Maps a subset of Claude Code's own tool names to our canonical tool kinds. */
const claudeToolKind = (toolName: string | undefined): ToolKind => {
  switch (toolName) {
    case "Read":
    case "Glob":
    case "Grep":
      return "read";
    case "Write":
    case "Edit":
      return "write";
    case "Bash":
      return "execute";
    case "WebSearch":
      return "search";
    case "WebFetch":
      return "network";
    case "Task":
      return "delegate";
    default:
      return toolName === undefined ? "unknown" : "other";
  }
};

/**
 * Comparison-harness usage derivation.
 *
 * Unlike `opentelemetry-hooks` (which copies whichever of the top-level or
 * nested `usage.*` fields it sees last, with no cache-aware math — see
 * DIVERGENCE-001/002/003), this mirrors what a real adapter is expected to do:
 * state an explicit `cacheCreationAccounting` and let `normalizeUsage` compute
 * `totalTokens` rather than trusting a provider-reported figure blindly.
 */
const claudeUsageReport = (payload: ClaudeCodePayload): Record<string, unknown> | undefined => {
  const inputTokens = payload.usage?.input_tokens ?? payload.input_tokens;
  const outputTokens = payload.usage?.output_tokens ?? payload.output_tokens;
  if (inputTokens === undefined && outputTokens === undefined) {
    return undefined;
  }
  const cacheCreationInputTokens = payload.cache_creation_input_tokens ?? 0;
  return {
    temporality: "delta",
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(payload.cache_read_input_tokens === undefined
      ? {}
      : { cachedInputTokens: payload.cache_read_input_tokens }),
    cacheCreationInputTokens,
    cacheCreationAccounting: cacheCreationInputTokens === 0 ? "not-reported" : "disjoint-from-input",
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(payload.reasoning_output_tokens === undefined
      ? {}
      : { reasoningOutputTokens: payload.reasoning_output_tokens }),
    ...(payload.usage?.total_tokens === undefined ? {} : { providerTotalTokens: payload.usage.total_tokens }),
  };
};

/**
 * Map one claude-code parity session (an ordered array of raw hook payloads
 * sharing one `session_id`) to canonical events.
 */
export const mapClaudeCodeSession = (payloads: readonly unknown[]): ParityMappingResult => {
  const context = buildContext();
  const typed = payloads as readonly ClaudeCodePayload[];
  const first = typed[0];
  if (first === undefined) {
    return { events: [], droppedExtensionKeys: [] };
  }
  const identity = buildIdentity(context, {
    providerId: "claude-code",
    sessionId: first.session_id,
    ...(first.cwd === undefined ? {} : { cwd: first.cwd }),
  });
  const factory = createEventFactory({ identity, sequenceBase: 0, context });

  let pendingCompactionBefore: number | undefined;
  let turn = 0;

  for (const payload of typed) {
    switch (payload.hook_event_name) {
      case "SessionStart":
        factory.build({
          type: "session.start",
          sessionKind: "interactive",
          agentName: "claude-code",
        });
        break;
      case "UserPromptSubmit":
        factory.build({
          type: "prompt.submitted",
          promptSource: "user",
          turnIndex: turn,
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
      case "PreToolUse":
        factory.build({
          type: "tool.start",
          toolCallId: payload.tool_use_id ?? context.ids.newOpaqueId([payload.session_id, "tool"]),
          toolName: payload.tool_name ?? "unknown-tool",
          toolKind: claudeToolKind(payload.tool_name),
          ...(payload.tool_input === undefined
            ? {}
            : {
                input: context.privacy.describeStructured({
                  kind: "tool-input",
                  value: payload.tool_input,
                  label: payload.tool_name ?? "unknown-tool",
                }),
              }),
        });
        break;
      case "PostToolUse":
        factory.build({
          type: "tool.end",
          toolCallId: payload.tool_use_id ?? context.ids.newOpaqueId([payload.session_id, "tool"]),
          toolName: payload.tool_name ?? "unknown-tool",
          outcome: "ok",
          ...(payload.duration_ms === undefined ? {} : { durationMillis: payload.duration_ms }),
          ...(payload.tool_response === undefined
            ? {}
            : {
                output: context.privacy.describeStructured({
                  kind: "tool-output",
                  value: payload.tool_response,
                  label: payload.tool_name ?? "unknown-tool",
                }),
              }),
        });
        break;
      case "PreCompact":
        pendingCompactionBefore = payload.context_tokens_before;
        break;
      case "PostCompact":
        factory.build({
          type: "compaction.performed",
          trigger: payload.trigger ?? "unknown",
          ...(pendingCompactionBefore === undefined
            ? {}
            : { contextTokensBefore: pendingCompactionBefore }),
          ...(payload.context_tokens_after === undefined
            ? {}
            : { contextTokensAfter: payload.context_tokens_after }),
        });
        pendingCompactionBefore = undefined;
        break;
      case "Stop": {
        const usageReport = claudeUsageReport(payload);
        factory.build({
          type: "generation.end",
          generationId: context.ids.newOpaqueId([payload.session_id, "generation", String(turn)]),
          // Claude Code's hook protocol does not surface a model id on Stop;
          // this placeholder keeps the event schema-valid without inventing a
          // specific model. Real adapters would source this from elsewhere.
          model: { modelId: "claude-code-model-unspecified" },
          outcome: "ok",
          ...(usageReport === undefined ? {} : { usage: normalizeOrDrop(usageReport) }),
        });
        turn += 1;
        break;
      }
      case "SessionEnd":
        factory.build({
          type: "session.end",
          reason: payload.reason === "completed" ? "completed" : "unknown",
        });
        break;
      default:
        break;
    }
  }

  return { events: factory.events(), droppedExtensionKeys: factory.droppedExtensionKeys() };
};

const normalizeOrDrop = (report: Record<string, unknown>): CanonicalUsage | undefined => {
  const result = normalizeUsage(report);
  return result.status === "ok" ? result.usage : undefined;
};

type CursorPayload = {
  readonly hook_event_name: string;
  readonly conversation_id: string;
  readonly generation_id?: string;
  readonly cwd?: string;
  readonly composer_mode?: string;
  readonly tool_name?: string;
  readonly tool_input?: unknown;
  readonly tool_use_id?: string;
  readonly duration?: number;
  readonly workspace_roots?: readonly string[];
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_read_tokens?: number;
};

const MCP_TOOL_NAME_PATTERN = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/;

/** Mirrors `_parse_encoded_mcp_tool_name` in opentelemetry-hooks: split on `__`, keep the tool name intact. */
const parseMcpToolName = (
  toolName: string,
): { readonly mcpServer: string; readonly mcpTool: string } | undefined => {
  const match = MCP_TOOL_NAME_PATTERN.exec(toolName);
  if (match === null) {
    return undefined;
  }
  const [, server, tool] = match;
  return server === undefined || tool === undefined ? undefined : { mcpServer: server, mcpTool: tool };
};

export const mapCursorSession = (payloads: readonly unknown[]): ParityMappingResult => {
  const context = buildContext();
  const typed = payloads as readonly CursorPayload[];
  const first = typed[0];
  if (first === undefined) {
    return { events: [], droppedExtensionKeys: [] };
  }
  const workspaceRoot = first.workspace_roots?.[0];
  const identity = buildIdentity(context, {
    providerId: "cursor",
    sessionId: first.conversation_id,
    ...(workspaceRoot === undefined ? {} : { cwd: workspaceRoot }),
  });
  const factory = createEventFactory({ identity, sequenceBase: 0, context });

  for (const payload of typed) {
    switch (payload.hook_event_name) {
      case "sessionStart":
        factory.build({
          type: "session.start",
          sessionKind: "interactive",
          agentName: "cursor",
        });
        break;
      case "preToolUse": {
        const mcp = payload.tool_name === undefined ? undefined : parseMcpToolName(payload.tool_name);
        factory.build({
          type: "tool.start",
          toolCallId:
            payload.tool_use_id ?? context.ids.newOpaqueId([payload.conversation_id, "tool"]),
          toolName: payload.tool_name ?? "unknown-tool",
          toolKind: mcp === undefined ? "other" : "network",
          ...(payload.tool_input === undefined
            ? {}
            : {
                input: context.privacy.describeStructured({
                  kind: "tool-input",
                  value: payload.tool_input,
                  label: payload.tool_name ?? "unknown-tool",
                }),
              }),
          ...(mcp === undefined
            ? {}
            : { extensions: { "cursor.mcp-server": mcp.mcpServer, "cursor.mcp-tool": mcp.mcpTool } }),
        });
        break;
      }
      case "afterMCPExecution":
      case "postToolUse":
        factory.build({
          type: "tool.end",
          toolCallId:
            payload.tool_use_id ?? context.ids.newOpaqueId([payload.conversation_id, "tool"]),
          toolName: payload.tool_name ?? "unknown-tool",
          outcome: "ok",
          // Cursor's `duration` is already milliseconds, so it is passed through
          // unscaled — see DIVERGENCE-008 for the reference's two different
          // wrong readings of the same key.
          ...(payload.duration === undefined ? {} : { durationMillis: payload.duration }),
        });
        break;
      case "stop":
        factory.build({
          type: "generation.end",
          generationId: payload.generation_id ?? "unknown-generation",
          model: { modelId: "unknown" },
          outcome: "ok",
          ...(payload.input_tokens === undefined
            ? {}
            : {
                usage: normalizeOrDrop({
                  temporality: "delta",
                  inputTokens: payload.input_tokens,
                  ...(payload.output_tokens === undefined ? {} : { outputTokens: payload.output_tokens }),
                  ...(payload.cache_read_tokens === undefined
                    ? {}
                    : { cachedInputTokens: payload.cache_read_tokens }),
                }),
              }),
        });
        break;
      default:
        break;
    }
  }

  return { events: factory.events(), droppedExtensionKeys: factory.droppedExtensionKeys() };
};
