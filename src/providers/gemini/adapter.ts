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
  // `AfterModel` fires per streaming chunk and a chunk's `usageMetadata` is a
  // snapshot of the response so far, not that chunk's increment. See
  // `./usage.ts` for the evidence; `delta` here would bill a multi-snapshot
  // stream several times over.
  usageTemporality: "cumulative",
  // Both false because the CLI's hook translator strips the counters before any
  // hook runs: `toHookLLMResponse` rebuilds `usageMetadata` as exactly
  // `{ promptTokenCount, candidatesTokenCount, totalTokenCount }`. The SDK
  // response it reads does carry `cachedContentTokenCount` and
  // `thoughtsTokenCount`, so this is a gap in the hook projection rather than in
  // the model — but a consumer must be able to tell "this provider reports no
  // cache reads" from "this session had none", and today it is the former.
  reportsCachedInput: false,
  reportsCacheCreation: false,
  cacheCreationAccounting: "not-reported",
  reportsReasoningOutput: false,
  reportsProviderTotal: true,
  reportsCost: false,
  // The Gemini CLI has no subagent hook events. Delegation happens through the
  // `invoke_agent` tool, so a subagent run is observable only as that tool's
  // BeforeTool/AfterTool pair — never as a distinct subagent lifecycle.
  emitsSubagentEvents: false,
  emitsCompactionEvents: true,
  requiresHookResponse: false,
  // Nothing in this protocol identifies a callback across a redelivery: there is
  // no request, turn, or tool-call id, and `session_id` repeats across resume and
  // clear. See `./delivery.ts` for the field-by-field reasoning.
  deliveryIdentifier: "none",
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

/**
 * The hook's `content.parts` is `string[]` — the CLI's translator keeps text
 * parts only and flattens them to bare strings. The `{ text }` spelling is read
 * too, because that is what a hook writes back in
 * `hookSpecificOutput.llm_response` and what the SDK response uses.
 */
const joinResponseText = (parts: readonly unknown[] | undefined): string | undefined => {
  if (parts === undefined || parts.length === 0) {
    return undefined;
  }
  const texts = parts.map(partText).filter((text): text is string => text !== undefined);
  const joined = texts.join("");
  return joined === "" ? undefined : joined;
};

const nonEmpty = (text: string | undefined): string | undefined =>
  text === undefined || text === "" ? undefined : text;

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
 * `weak` when the payload merely looks like this protocol. All eleven hook events
 * in the CLI's `HookEventName` enum are recognized; `AfterAgent`,
 * `BeforeToolSelection`, and `Notification` carry no canonical telemetry and are
 * parsed as `ignored`.
 *
 * `AfterModel` fires once per streaming chunk. A chunk that carries no
 * `usageMetadata` is ignored; a chunk that carries one completes a
 * `generation.end` for the generation its `llm_request` identifies. Several
 * chunks of one stream may each carry a snapshot, and each closes the *same*
 * generation: the snapshots are cumulative, so the runtime diffs them against the
 * generation's stored baseline and the stream is billed once in total rather than
 * once per chunk. See `./usage.ts` for why that is the correct reading, and
 * `./delivery.ts` for the identity trade-offs this protocol imposes.
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
            reason: "AfterModel fired for a streaming chunk carrying no usageMetadata snapshot",
          };
        }
        const generationId = geminiGenerationId(context, sessionId, payload.llm_request);
        const model = { modelId: payload.llm_request.model ?? "unknown", vendor: "google" };
        const candidate = payload.llm_response.candidates?.[0];
        // The translator also sets a whole-response `text`; fall back to it when
        // the chunk's candidate carries no text parts of its own.
        const outputText =
          joinResponseText(candidate?.content?.parts) ?? nonEmpty(payload.llm_response.text);
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

  return {
    id,
    version,
    capabilities,
    detect,
    identify,
    parse,
    hookResponse,
  };
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
