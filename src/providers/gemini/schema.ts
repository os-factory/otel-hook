import { z } from "zod";

/**
 * Zod schemas for the Gemini CLI command hook protocol.
 *
 * Shapes follow the public Gemini CLI hooks reference
 * (https://geminicli.com/docs/hooks/reference/,
 * https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/writing-hooks.md).
 * Every hook receives the base fields below plus event-specific fields keyed by
 * `hook_event_name`. Unknown extra fields are stripped rather than rejected,
 * since the CLI is free to add fields the adapter does not yet model.
 */

export const GEMINI_HOOK_EVENT_NAMES = [
  "SessionStart",
  "SessionEnd",
  "BeforeAgent",
  "AfterAgent",
  "BeforeModel",
  "AfterModel",
  "BeforeToolSelection",
  "BeforeTool",
  "AfterTool",
  "PreCompress",
  "Notification",
] as const;
export type GeminiHookEventName = (typeof GEMINI_HOOK_EVENT_NAMES)[number];

const baseHookInputSchema = z.object({
  session_id: z.string().min(1),
  transcript_path: z.string().optional(),
  cwd: z.string().optional(),
  timestamp: z.string().min(1).optional(),
});

const llmMessageSchema = z
  .object({
    role: z.enum(["user", "model", "system"]).optional(),
    content: z.union([z.string(), z.array(z.unknown())]).optional(),
  })
  .loose();

const llmRequestConfigSchema = z
  .object({
    temperature: z.number().optional(),
    maxOutputTokens: z.number().int().min(0).optional(),
  })
  .loose();

export const geminiLlmRequestSchema = z
  .object({
    model: z.string().min(1).optional(),
    messages: z.array(llmMessageSchema).optional(),
    config: llmRequestConfigSchema.optional(),
    toolConfig: z.unknown().optional(),
  })
  .loose();
export type GeminiLlmRequest = z.infer<typeof geminiLlmRequestSchema>;

/**
 * Gemini API `usageMetadata`. Only the counters this adapter maps are typed;
 * everything else in the payload passes through untouched.
 *
 * `promptTokenCount` is inclusive of `cachedContentTokenCount`.
 * `candidatesTokenCount` and `thoughtsTokenCount` are reported separately by the
 * API and are never merged before normalization.
 */
export const geminiUsageMetadataSchema = z
  .object({
    promptTokenCount: z.number().int().min(0).optional(),
    cachedContentTokenCount: z.number().int().min(0).optional(),
    candidatesTokenCount: z.number().int().min(0).optional(),
    thoughtsTokenCount: z.number().int().min(0).optional(),
    totalTokenCount: z.number().int().min(0).optional(),
  })
  .loose();
export type GeminiUsageMetadata = z.infer<typeof geminiUsageMetadataSchema>;

const geminiCandidateSchema = z
  .object({
    content: z
      .object({
        role: z.string().optional(),
        parts: z.array(z.unknown()).optional(),
      })
      .loose()
      .optional(),
    finishReason: z.string().optional(),
  })
  .loose();

export const geminiLlmResponseSchema = z
  .object({
    candidates: z.array(geminiCandidateSchema).optional(),
    usageMetadata: geminiUsageMetadataSchema.optional(),
  })
  .loose();
export type GeminiLlmResponse = z.infer<typeof geminiLlmResponseSchema>;

const geminiToolResponseSchema = z
  .object({
    llmContent: z.unknown().optional(),
    returnDisplay: z.unknown().optional(),
    error: z.unknown().optional(),
  })
  .loose();

export const sessionStartInputSchema = baseHookInputSchema.extend({
  hook_event_name: z.literal("SessionStart"),
  source: z.enum(["startup", "resume", "clear"]).optional(),
});

export const sessionEndInputSchema = baseHookInputSchema.extend({
  hook_event_name: z.literal("SessionEnd"),
  reason: z.enum(["exit", "clear", "logout", "prompt_input_exit", "other"]).optional(),
});

export const beforeAgentInputSchema = baseHookInputSchema.extend({
  hook_event_name: z.literal("BeforeAgent"),
  prompt: z.string().optional(),
});

export const afterAgentInputSchema = baseHookInputSchema.extend({
  hook_event_name: z.literal("AfterAgent"),
  prompt: z.string().optional(),
  prompt_response: z.string().optional(),
  stop_hook_active: z.boolean().optional(),
});

export const beforeModelInputSchema = baseHookInputSchema.extend({
  hook_event_name: z.literal("BeforeModel"),
  llm_request: geminiLlmRequestSchema,
});

export const afterModelInputSchema = baseHookInputSchema.extend({
  hook_event_name: z.literal("AfterModel"),
  llm_request: geminiLlmRequestSchema,
  llm_response: geminiLlmResponseSchema,
});

export const beforeToolSelectionInputSchema = baseHookInputSchema.extend({
  hook_event_name: z.literal("BeforeToolSelection"),
  llm_request: geminiLlmRequestSchema,
});

export const beforeToolInputSchema = baseHookInputSchema.extend({
  hook_event_name: z.literal("BeforeTool"),
  tool_name: z.string().min(1),
  tool_input: z.unknown().optional(),
  mcp_context: z.unknown().optional(),
  original_request_name: z.string().min(1).optional(),
});

export const afterToolInputSchema = baseHookInputSchema.extend({
  hook_event_name: z.literal("AfterTool"),
  tool_name: z.string().min(1),
  tool_input: z.unknown().optional(),
  tool_response: geminiToolResponseSchema.optional(),
  mcp_context: z.unknown().optional(),
  original_request_name: z.string().min(1).optional(),
});

export const preCompressInputSchema = baseHookInputSchema.extend({
  hook_event_name: z.literal("PreCompress"),
  trigger: z.enum(["auto", "manual"]).optional(),
});

export const notificationInputSchema = baseHookInputSchema.extend({
  hook_event_name: z.literal("Notification"),
  notification_type: z.string().optional(),
  message: z.string().optional(),
  details: z.unknown().optional(),
});

export const geminiHookInputSchema = z.discriminatedUnion("hook_event_name", [
  sessionStartInputSchema,
  sessionEndInputSchema,
  beforeAgentInputSchema,
  afterAgentInputSchema,
  beforeModelInputSchema,
  afterModelInputSchema,
  beforeToolSelectionInputSchema,
  beforeToolInputSchema,
  afterToolInputSchema,
  preCompressInputSchema,
  notificationInputSchema,
]);
export type GeminiHookInput = z.infer<typeof geminiHookInputSchema>;

export type GeminiHookInputOfType<TName extends GeminiHookEventName> = Extract<
  GeminiHookInput,
  { hook_event_name: TName }
>;

/** Cheap structural check used to distinguish "not this protocol at all" from a shape mismatch. */
export const looksLikeGeminiHookPayload = (payload: unknown): boolean => {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return false;
  }
  const record = payload as Record<string, unknown>;
  return (
    typeof record.session_id === "string" &&
    typeof record.hook_event_name === "string" &&
    (GEMINI_HOOK_EVENT_NAMES as readonly string[]).includes(record.hook_event_name)
  );
};
