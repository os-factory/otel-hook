import { z } from "zod";

/**
 * Raw Claude Code hook payload shapes.
 *
 * Field names and event names are taken from Claude Code's published hooks
 * reference (`code.claude.com/docs/en/hooks`). Objects are intentionally
 * non-strict: an unrecognized field is ignored rather than rejected, so a
 * protocol addition does not break detection or parsing. Discriminants
 * (`hook_event_name`, and the enum-shaped fields we do constrain) are strict.
 */

/** Fields Claude Code includes on effectively every hook invocation. */
const commonFields = {
  session_id: z.string().min(1),
  transcript_path: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  permission_mode: z.string().min(1).optional(),
  /** Correlates a hook firing with the user prompt that triggered it (Claude Code v2.1.196+). */
  prompt_id: z.string().min(1).optional(),
  /** Present when the hook fired while running inside a subagent. */
  agent_id: z.string().min(1).optional(),
  agent_type: z.string().min(1).optional(),
};

/**
 * Anthropic Messages API usage shape, as a wrapping harness may attach it
 * after correlating a hook firing with the transcript. This adapter never
 * reads the transcript itself (AGENT.md forbids scanning transcript
 * directories from provider adapters); the field is accepted only when a
 * caller has already placed it on the payload.
 */
export const claudeUsageSchema = z.object({
  input_tokens: z.number().int().min(0),
  output_tokens: z.number().int().min(0),
  cache_creation_input_tokens: z.number().int().min(0).optional(),
  cache_read_input_tokens: z.number().int().min(0).optional(),
});
export type ClaudeUsage = z.infer<typeof claudeUsageSchema>;

export const sessionStartPayloadSchema = z.object({
  ...commonFields,
  hook_event_name: z.literal("SessionStart"),
  /** Matcher values: startup | resume | clear | compact | fork. Forward-compatible: any string. */
  source: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  session_title: z.string().min(1).optional(),
});
export type SessionStartPayload = z.infer<typeof sessionStartPayloadSchema>;

export const sessionEndPayloadSchema = z.object({
  ...commonFields,
  hook_event_name: z.literal("SessionEnd"),
  /** Matcher values: clear | resume | logout | prompt_input_exit | bypass_permissions_disabled | other. */
  end_reason: z.string().min(1),
});
export type SessionEndPayload = z.infer<typeof sessionEndPayloadSchema>;

export const userPromptSubmitPayloadSchema = z.object({
  ...commonFields,
  hook_event_name: z.literal("UserPromptSubmit"),
  prompt: z.string(),
});
export type UserPromptSubmitPayload = z.infer<typeof userPromptSubmitPayloadSchema>;

export const preToolUsePayloadSchema = z.object({
  ...commonFields,
  hook_event_name: z.literal("PreToolUse"),
  tool_name: z.string().min(1),
  tool_input: z.unknown(),
  tool_use_id: z.string().min(1),
});
export type PreToolUsePayload = z.infer<typeof preToolUsePayloadSchema>;

export const postToolUsePayloadSchema = z.object({
  ...commonFields,
  hook_event_name: z.literal("PostToolUse"),
  tool_name: z.string().min(1),
  tool_input: z.unknown().optional(),
  tool_response: z.unknown(),
  tool_use_id: z.string().min(1),
});
export type PostToolUsePayload = z.infer<typeof postToolUsePayloadSchema>;

export const postToolUseFailurePayloadSchema = z.object({
  ...commonFields,
  hook_event_name: z.literal("PostToolUseFailure"),
  tool_name: z.string().min(1),
  tool_input: z.unknown().optional(),
  tool_error: z.unknown(),
  tool_use_id: z.string().min(1),
});
export type PostToolUseFailurePayload = z.infer<typeof postToolUseFailurePayloadSchema>;

export const permissionRequestPayloadSchema = z.object({
  ...commonFields,
  hook_event_name: z.literal("PermissionRequest"),
  tool_name: z.string().min(1),
  tool_input: z.unknown().optional(),
  tool_use_id: z.string().min(1),
});
export type PermissionRequestPayload = z.infer<typeof permissionRequestPayloadSchema>;

export const subagentStartPayloadSchema = z.object({
  ...commonFields,
  hook_event_name: z.literal("SubagentStart"),
  agent_type: z.string().min(1),
  agent_id: z.string().min(1),
});
export type SubagentStartPayload = z.infer<typeof subagentStartPayloadSchema>;

export const subagentStopPayloadSchema = z.object({
  ...commonFields,
  hook_event_name: z.literal("SubagentStop"),
  agent_type: z.string().min(1),
  agent_id: z.string().min(1),
  last_assistant_message: z.string().optional(),
  usage: claudeUsageSchema.optional(),
});
export type SubagentStopPayload = z.infer<typeof subagentStopPayloadSchema>;

export const preCompactPayloadSchema = z.object({
  ...commonFields,
  hook_event_name: z.literal("PreCompact"),
  /** Matcher values: manual | auto. */
  compact_trigger: z.string().min(1).optional(),
  estimated_tokens_removed: z.number().int().min(0).optional(),
});
export type PreCompactPayload = z.infer<typeof preCompactPayloadSchema>;

export const postCompactPayloadSchema = z.object({
  ...commonFields,
  hook_event_name: z.literal("PostCompact"),
  compact_trigger: z.string().min(1).optional(),
  /** Best-effort/optional: not documented on the public schema, accepted if present. */
  context_tokens_before: z.number().int().min(0).optional(),
  context_tokens_after: z.number().int().min(0).optional(),
  dropped_message_count: z.number().int().min(0).optional(),
  usage: claudeUsageSchema.optional(),
});
export type PostCompactPayload = z.infer<typeof postCompactPayloadSchema>;

export const stopPayloadSchema = z.object({
  ...commonFields,
  hook_event_name: z.literal("Stop"),
  last_assistant_message: z.string().optional(),
  usage: claudeUsageSchema.optional(),
});
export type StopPayload = z.infer<typeof stopPayloadSchema>;

export const stopFailurePayloadSchema = z.object({
  ...commonFields,
  hook_event_name: z.literal("StopFailure"),
  /**
   * Matcher values: rate_limit | overloaded | authentication_failed |
   * oauth_org_not_allowed | billing_error | invalid_request | model_not_found
   * | server_error | max_output_tokens | unknown.
   */
  error_type: z.string().min(1),
  error_message: z.string().optional(),
  usage: claudeUsageSchema.optional(),
});
export type StopFailurePayload = z.infer<typeof stopFailurePayloadSchema>;

export const claudeHookPayloadSchema = z.discriminatedUnion("hook_event_name", [
  sessionStartPayloadSchema,
  sessionEndPayloadSchema,
  userPromptSubmitPayloadSchema,
  preToolUsePayloadSchema,
  postToolUsePayloadSchema,
  postToolUseFailurePayloadSchema,
  permissionRequestPayloadSchema,
  subagentStartPayloadSchema,
  subagentStopPayloadSchema,
  preCompactPayloadSchema,
  postCompactPayloadSchema,
  stopPayloadSchema,
  stopFailurePayloadSchema,
]);
export type ClaudeHookPayload = z.infer<typeof claudeHookPayloadSchema>;

/** Every `hook_event_name` this adapter recognizes. */
export const CLAUDE_HOOK_EVENT_NAMES = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "Stop",
  "StopFailure",
] as const;
export type ClaudeHookEventName = (typeof CLAUDE_HOOK_EVENT_NAMES)[number];

/**
 * Minimal shape identity resolution needs. Deliberately looser than
 * {@link claudeHookPayloadSchema}: a payload that is missing an
 * event-specific field (e.g. `PreToolUse` without `tool_use_id`) can still be
 * attributed to a session, so the deeper failure surfaces from `parse`
 * instead of silently declining attribution.
 */
export const claudeIdentityFieldsSchema = z.object({
  session_id: z.string().min(1),
  hook_event_name: z.string().min(1),
  cwd: z.string().min(1).optional(),
  prompt_id: z.string().min(1).optional(),
  agent_id: z.string().min(1).optional(),
  tool_use_id: z.string().min(1).optional(),
});
export type ClaudeIdentityFields = z.infer<typeof claudeIdentityFieldsSchema>;
