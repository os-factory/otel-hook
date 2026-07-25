import { createErrorInfo } from "../../errors/index.js";
import type { EventOutcome, ToolKind } from "../../model/events.js";
import { identityClaimSchema, type IdentityClaim } from "../../model/identity.js";
import { providerIdSchema, type ProviderId } from "../../model/primitives.js";
import { normalizeUsage, type CanonicalUsage } from "../../model/usage.js";
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
  geminiCorrelationSeed,
  geminiGenerationId,
  geminiSessionId,
  geminiToolCallId,
  geminiToolCallKey,
  geminiWorkspace,
  parseGeminiTimestamp,
} from "./identity.js";
import { geminiHookInputSchema, looksLikeGeminiHookPayload, type GeminiHookInput } from "./schema.js";
import { classifyGeminiToolKind } from "./tool-kind.js";
import { mapGeminiUsage } from "./usage.js";

export const GEMINI_PROVIDER_ID = "gemini-cli" as const;
export const GEMINI_ADAPTER_VERSION = "0.1.0";

export const DEFAULT_GEMINI_CAPABILITIES: ProviderCapabilities = Object.freeze({
  lifecycleEvents: Object.freeze([
    "session.start",
    "session.end",
    "prompt.submitted",
    "generation.start",
    "generation.end",
    "tool.start",
    "tool.end",
    "compaction.performed",
  ] as const),
  usageTemporality: "delta",
  reportsCachedInput: true,
  reportsCacheCreation: false,
  cacheCreationAccounting: "not-reported",
  reportsReasoningOutput: true,
  reportsProviderTotal: true,
  reportsCost: false,
  emitsSubagentEvents: false,
  emitsCompactionEvents: true,
  requiresHookResponse: false,
});

export type GeminiAdapterOptions = {
  readonly id?: string;
  readonly version?: string;
  readonly capabilities?: Partial<ProviderCapabilities>;
};

const SESSION_END_REASON_OUTCOME: Readonly<Record<string, "completed" | "unknown">> = Object.freeze({
  exit: "completed",
  clear: "completed",
  logout: "completed",
  prompt_input_exit: "completed",
  other: "unknown",
});

const FINISH_REASON_OUTCOME: Readonly<Record<string, EventOutcome>> = Object.freeze({
  STOP: "ok",
  MAX_TOKENS: "ok",
  SAFETY: "denied",
  RECITATION: "denied",
  BLOCKLIST: "denied",
  PROHIBITED_CONTENT: "denied",
  SPII: "denied",
  LANGUAGE: "denied",
  MALFORMED_FUNCTION_CALL: "error",
  OTHER: "unknown",
});

const finishReasonOutcome = (finishReason: string | undefined): EventOutcome =>
  finishReason === undefined ? "unknown" : (FINISH_REASON_OUTCOME[finishReason] ?? "unknown");

const partText = (part: unknown): string | undefined => {
  if (typeof part === "string") {
    return part;
  }
  if (typeof part === "object" && part !== null && "text" in part) {
    const { text } = part;
    return typeof text === "string" ? text : undefined;
  }
  return undefined;
};

const joinResponseText = (parts: readonly unknown[] | undefined): string | undefined => {
  if (parts === undefined || parts.length === 0) {
    return undefined;
  }
  const texts = parts.map(partText).filter((text): text is string => text !== undefined);
  return texts.length === 0 ? undefined : texts.join("");
};

const messageText = (content: string | readonly unknown[] | undefined): string | undefined => {
  if (content === undefined) {
    return undefined;
  }
  if (typeof content === "string") {
    return content;
  }
  return joinResponseText(content);
};

/**
 * Provider adapter for the Gemini CLI's command hooks.
 *
 * Detection is purely structural (the protocol carries no provider tag), so
 * confidence is `exact` only when the full event-specific shape validates, and
 * `weak` when the payload merely looks like this protocol. Every hook event
 * documented at https://geminicli.com/docs/hooks/reference/ is recognized;
 * `BeforeToolSelection` and `Notification` carry no canonical telemetry and are
 * parsed as `ignored`, and only a terminal `AfterModel` firing (one that carries
 * `usageMetadata`) completes a `generation.end` — earlier streaming chunks are
 * ignored too. See the adapter gaps noted in the provider fixtures README for
 * the identity trade-offs this implies.
 */
export const createGeminiCliAdapter = (options: GeminiAdapterOptions = {}): ProviderAdapter => {
  const id: ProviderId = providerIdSchema.parse(options.id ?? GEMINI_PROVIDER_ID);
  const version = options.version ?? GEMINI_ADAPTER_VERSION;
  const capabilities: ProviderCapabilities = {
    ...DEFAULT_GEMINI_CAPABILITIES,
    ...options.capabilities,
  };

  const detect = (input: ProviderDetectionInput): ProviderDetection => {
    const parsed = geminiHookInputSchema.safeParse(input.payload);
    if (parsed.success) {
      return providerDetectionSchema.parse({
        providerId: id,
        confidence: "exact",
        reasons: [
          "payload matches the Gemini CLI command hook schema",
          `hook_event_name=${parsed.data.hook_event_name}`,
        ],
        sourceEventName: parsed.data.hook_event_name,
      });
    }
    if (looksLikeGeminiHookPayload(input.payload)) {
      const record = input.payload as { hook_event_name: string };
      return providerDetectionSchema.parse({
        providerId: id,
        confidence: "weak",
        reasons: [
          "payload has session_id and a recognized hook_event_name but failed event-specific validation",
        ],
        sourceEventName: record.hook_event_name,
      });
    }
    return unknownDetection(["payload does not match the Gemini CLI command hook protocol"]);
  };

  const identify = (input: ProviderIdentityInput, context: ProviderContext): readonly IdentityClaim[] => {
    const parsed = geminiHookInputSchema.safeParse(input.payload);
    if (!parsed.success) {
      return [];
    }
    const payload = parsed.data;
    const sessionId = geminiSessionId(payload);
    const startedAt = parseGeminiTimestamp(payload.timestamp) ?? context.clock.now();
    const workspace = geminiWorkspace(context, payload);
    const invocationId = context.ids.newInvocationId({
      providerId: id,
      sessionId,
      sourceEventName: payload.hook_event_name,
      occurredAt: startedAt,
      discriminator: geminiCorrelationSeed(payload),
    });

    return [
      identityClaimSchema.parse({
        source: `adapter:${id}`,
        confidence: input.detection.confidence,
        fields: {
          sessionId,
          invocationId,
          startedAt,
          ...(workspace === undefined ? {} : { workspace }),
        },
      }),
    ];
  };

  const parse = (input: ProviderParseInput, context: ProviderContext): ProviderParseResult => {
    const parsed = geminiHookInputSchema.safeParse(input.payload);
    if (!parsed.success) {
      return {
        status: "failed",
        error: createErrorInfo({
          code: "invalid-input",
          phase: "parsing",
          detail: "payload does not match the Gemini CLI command hook protocol",
        }),
      };
    }
    const payload: GeminiHookInput = parsed.data;
    const sessionId = String(input.identity.sessionId);
    const occurredAt = input.identity.startedAt;
    const factory = createEventFactory({
      identity: input.identity,
      sequenceBase: input.sequenceBase,
      context,
    });
    const warnings: string[] = [];

    switch (payload.hook_event_name) {
      case "SessionStart": {
        factory.build({
          type: "session.start",
          sessionKind: "unknown",
          agentName: "gemini-cli",
          occurredAt,
        });
        break;
      }

      case "SessionEnd": {
        factory.build({
          type: "session.end",
          reason: SESSION_END_REASON_OUTCOME[payload.reason ?? "other"] ?? "unknown",
          occurredAt,
        });
        break;
      }

      case "BeforeAgent": {
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
      }

      case "AfterAgent": {
        return {
          status: "ignored",
          reason:
            "AfterAgent marks turn completion; the canonical model has no turn-level event distinct from generation.end, so it carries no telemetry of its own",
        };
      }

      case "BeforeModel": {
        const generationId = geminiGenerationId(context, sessionId, payload.llm_request);
        const model = { modelId: payload.llm_request.model ?? "unknown", vendor: "google" };
        const inputContent = (payload.llm_request.messages ?? [])
          .map((message) => {
            const text = messageText(message.content);
            return text === undefined
              ? undefined
              : context.privacy.describeContent({
                  kind: "prompt",
                  role: message.role === "model" ? "assistant" : (message.role ?? "unknown"),
                  text,
                });
          })
          .filter((fact) => fact !== undefined);
        factory.build({
          type: "generation.start",
          generationId,
          model,
          occurredAt,
          ...(payload.llm_request.config?.maxOutputTokens === undefined
            ? {}
            : { requestedMaxOutputTokens: payload.llm_request.config.maxOutputTokens }),
          ...(inputContent.length === 0 ? {} : { inputContent }),
        });
        break;
      }

      case "AfterModel": {
        const usage = mapGeminiUsage(payload.llm_response.usageMetadata);
        if (usage === undefined) {
          return {
            status: "ignored",
            reason: "AfterModel fired for an intermediate streaming chunk with no terminal usage signal",
          };
        }
        const generationId = geminiGenerationId(context, sessionId, payload.llm_request);
        const model = { modelId: payload.llm_request.model ?? "unknown", vendor: "google" };
        const candidate = payload.llm_response.candidates?.[0];
        const outputText = joinResponseText(candidate?.content?.parts);
        const usageResult = normalizeUsageOrWarn(usage, warnings);
        factory.build({
          type: "generation.end",
          generationId,
          model,
          outcome: finishReasonOutcome(candidate?.finishReason),
          occurredAt,
          ...(candidate?.finishReason === undefined ? {} : { stopReason: candidate.finishReason }),
          ...(usageResult === undefined ? {} : { usage: usageResult }),
          ...(outputText === undefined
            ? {}
            : {
                outputContent: [
                  context.privacy.describeContent({ kind: "response", role: "assistant", text: outputText }),
                ],
              }),
        });
        break;
      }

      case "BeforeToolSelection": {
        return {
          status: "ignored",
          reason: "BeforeToolSelection carries tool-choice configuration only, not lifecycle telemetry",
        };
      }

      case "BeforeTool": {
        const toolCallId = geminiToolCallId(context, sessionId, geminiToolCallKey(payload));
        factory.build({
          type: "tool.start",
          toolCallId,
          toolName: payload.tool_name,
          toolKind: classifyGeminiToolKind(payload.tool_name) satisfies ToolKind,
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

      case "AfterTool": {
        const toolCallId = geminiToolCallId(context, sessionId, geminiToolCallKey(payload));
        const hasError = payload.tool_response?.error !== undefined;
        factory.build({
          type: "tool.end",
          toolCallId,
          toolName: payload.tool_name,
          outcome: hasError ? "error" : "ok",
          occurredAt,
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

      case "PreCompress": {
        factory.build({
          type: "compaction.performed",
          trigger: payload.trigger === "manual" ? "manual" : payload.trigger === "auto" ? "automatic" : "unknown",
          occurredAt,
        });
        break;
      }

      case "Notification": {
        return {
          status: "ignored",
          reason: "Notification is observability-only in the Gemini CLI protocol and has no canonical event type",
        };
      }
    }

    return {
      status: "parsed",
      events: factory.events(),
      ...(warnings.length === 0 ? {} : { warnings }),
    };
  };

  const hookResponse = (): ProviderHookResponse => SILENT_HOOK_RESPONSE;

  return { id, version, capabilities, detect, identify, parse, hookResponse };
};

const normalizeUsageOrWarn = (
  usage: ReturnType<typeof mapGeminiUsage>,
  warnings: string[],
): CanonicalUsage | undefined => {
  if (usage === undefined) {
    return undefined;
  }
  const normalized = normalizeUsage(usage);
  if (normalized.status === "invalid") {
    warnings.push(...normalized.issues.map((issue) => issue.message));
    return undefined;
  }
  return normalized.usage;
};
