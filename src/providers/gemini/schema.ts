import { z } from "zod";

/**
 * Zod schemas for the Gemini CLI command hook protocol.
 *
 * Shapes follow the public Gemini CLI hooks reference
 * (https://geminicli.com/docs/hooks/reference/,
 * https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/writing-hooks.md)
 * cross-checked field by field against the CLI source that *produces* these
 * payloads, pinned at `google-gemini/gemini-cli@3499c84`:
 *
 * - `packages/core/src/hooks/types.ts` — `HookEventName` and the per-event input
 *   interfaces.
 * - `packages/core/src/hooks/hookTranslator.ts` — `LLMRequest` / `LLMResponse`,
 *   the "decoupled", SDK-agnostic shapes the model events carry.
 * - `packages/core/src/hooks/hookEventHandler.ts` — how each input is assembled.
 *
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
 * `usageMetadata`, as the hook actually receives it.
 *
 * The hook does **not** see the Gemini API's `usageMetadata` verbatim.
 * `HookTranslatorGenAIv1.toHookLLMResponse` rebuilds the object with exactly
 * three counters — `promptTokenCount`, `candidatesTokenCount`, and
 * `totalTokenCount` — and the declared `LLMResponse['usageMetadata']` type lists
 * only those three. `cachedContentTokenCount` and `thoughtsTokenCount` exist on
 * the SDK response the CLI receives, but are dropped before any hook runs, which
 * is why {@link DEFAULT_GEMINI_CAPABILITIES} declares neither cached input nor
 * reasoning output as reported.
 *
 * They stay modelled here anyway, and `mapGeminiUsage` still honours them: the
 * translator is versioned (`HookTranslator` is an abstract base with a
 * `defaultHookTranslator` instance per SDK generation), so a later version may
 * widen the projection. Modelling a counter costs nothing; silently discarding
 * one the CLI started sending would understate every cache read.
 *
 * Inclusion semantics, when a counter *is* present, follow the Gemini API:
 * `promptTokenCount` is inclusive of `cachedContentTokenCount`, while
 * `candidatesTokenCount` and `thoughtsTokenCount` are separate counters that are
 * never merged before normalization.
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

/**
 * A candidate in the decoupled hook response format.
 *
 * `content.parts` is `string[]` here, not the SDK's `Part[]`: the translator
 * keeps only text parts and maps them to bare strings
 * (`parts: candidate.content?.parts?.filter(hasTextProperty).map((p) => p.text)`).
 * The element type stays `unknown` so that the `{ text }` spelling — which is
 * what a *hook* writes back in `hookSpecificOutput.llm_response`, and what the
 * SDK uses — is read rather than rejected.
 *
 * `finishReason`'s declared union is five values wide, but the translator casts
 * the SDK's own `FinishReason` through unchanged, so any value the API emits
 * (`BLOCKLIST`, `PROHIBITED_CONTENT`, `MALFORMED_FUNCTION_CALL`, …) reaches the
 * hook verbatim. It is therefore typed as a free string and classified by name.
 */
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
    index: z.number().int().min(0).optional(),
  })
  .loose();

export const geminiLlmResponseSchema = z
  .object({
    /** Whole-response text, set by the translator from `getResponseText`. */
    text: z.string().optional(),
    candidates: z.array(geminiCandidateSchema).optional(),
    usageMetadata: geminiUsageMetadataSchema.optional(),
  })
  .loose();
export type GeminiLlmResponse = z.infer<typeof geminiLlmResponseSchema>;

/**
 * Connection identity for an MCP-backed tool call, present on `BeforeTool` and
 * `AfterTool` only when the tool came from an MCP server (`McpToolContext`).
 * Modelled to record the vocabulary; the adapter reads none of it, because the
 * `command`/`args`/`url` fields describe a server the operator configured.
 */
const geminiMcpContextSchema = z
  .object({
    server_name: z.string().optional(),
    tool_name: z.string().optional(),
  })
  .loose();

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

/**
 * Fires once per **streaming chunk**, not once per model call: `geminiChat.ts`
 * calls `fireAfterModelEvent(originalRequest, chunk)` from inside its
 * `for await (const chunk of streamResponse)` loop. `llm_request` is the same
 * object for every chunk of one call, which is what lets `geminiGenerationId`
 * correlate them; `llm_response` is that one chunk.
 */
export const afterModelInputSchema = baseHookInputSchema.extend({
  hook_event_name: z.literal("AfterModel"),
  llm_request: geminiLlmRequestSchema,
  llm_response: geminiLlmResponseSchema,
});

export const beforeToolSelectionInputSchema = baseHookInputSchema.extend({
  hook_event_name: z.literal("BeforeToolSelection"),
  llm_request: geminiLlmRequestSchema,
});

/**
 * `original_request_name` is present only for a **tail tool call** — a second
 * tool the CLI runs in place of the first because an `AfterTool` hook returned
 * `hookSpecificOutput.tailToolCallRequest`. It names the tool the *model* asked
 * for, while `tool_name` names the tool actually executing
 * (`ToolCallRequestInfo.originalRequestName`). It is not a rewrite marker for
 * `tool_input`; see `identity.ts` for why that distinction changes correlation.
 */
export const beforeToolInputSchema = baseHookInputSchema.extend({
  hook_event_name: z.literal("BeforeTool"),
  tool_name: z.string().min(1),
  tool_input: z.unknown().optional(),
  mcp_context: geminiMcpContextSchema.optional(),
  original_request_name: z.string().min(1).optional(),
});

export const afterToolInputSchema = baseHookInputSchema.extend({
  hook_event_name: z.literal("AfterTool"),
  tool_name: z.string().min(1),
  tool_input: z.unknown().optional(),
  tool_response: geminiToolResponseSchema.optional(),
  mcp_context: geminiMcpContextSchema.optional(),
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
