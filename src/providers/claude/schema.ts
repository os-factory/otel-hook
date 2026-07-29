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
 * Cache-creation tokens split by cache TTL.
 *
 * A *breakdown* of `cache_creation_input_tokens`, not tokens beside it: the two
 * sub-buckets summed to that counter in 4,999 of 4,999 real usage objects. See
 * `usage.ts` for why they are verified and never added, and
 * docs/claude-code-usage-contract.md (finding 3) for the capture.
 */
export const claudeCacheCreationSchema = z.object({
  ephemeral_5m_input_tokens: z.number().int().min(0).optional(),
  ephemeral_1h_input_tokens: z.number().int().min(0).optional(),
});

/**
 * One model request inside a turn that took more than one.
 *
 * Also a breakdown: the per-iteration counters summed to the outer counters
 * exactly, for all four fields, in every capture (finding 4).
 */
export const claudeUsageIterationSchema = z.object({
  input_tokens: z.number().int().min(0).optional(),
  output_tokens: z.number().int().min(0).optional(),
  cache_creation_input_tokens: z.number().int().min(0).optional(),
  cache_read_input_tokens: z.number().int().min(0).optional(),
});

/**
 * Anthropic Messages API usage shape, as a wrapping harness may attach it
 * after correlating a hook firing with the transcript.
 *
 * **No Claude Code hook callback carries this object.** Confirmed against the
 * CLI's own hook-input schemas at 2.1.220: not `Stop`, not `SubagentStop`, not
 * `PostCompact` — no hook event in the protocol reports a token counter at all
 * (docs/claude-code-usage-contract.md, finding 1). The tokens exist only at
 * `message.usage` in the transcript, and this adapter never reads the transcript
 * itself (AGENT.md forbids scanning transcript directories from provider
 * adapters). So the field is accepted only when a caller has already placed it
 * on the payload, and the shape mirrors `message.usage` exactly so a harness can
 * attach what it read without reshaping it.
 *
 * `input_tokens` is the **fresh** portion of the prompt only; cache reads and
 * cache writes are separate, additive buckets (finding 2). `usage.ts` documents
 * the fold that turns those three into the canonical inclusive total.
 */
export const claudeUsageSchema = z.object({
  input_tokens: z.number().int().min(0),
  output_tokens: z.number().int().min(0),
  cache_creation_input_tokens: z.number().int().min(0).optional(),
  cache_read_input_tokens: z.number().int().min(0).optional(),
  cache_creation: claudeCacheCreationSchema.optional(),
  iterations: z.array(claudeUsageIterationSchema).optional(),
  /**
   * Counters the canonical model has a home for but Claude Code never reports:
   * 0 of 4,999 real usage objects carried either (finding 5).
   *
   * Named here rather than left to the object's forward-compatible looseness so
   * that a harness attaching one gets told it was excluded, instead of watching
   * it vanish. See `CLAUDE_EXCLUDED_USAGE_COUNTERS`.
   */
  total_tokens: z.number().int().min(0).optional(),
  reasoning_output_tokens: z.number().int().min(0).optional(),
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
  /** Current Claude Code field; values include clear, logout, prompt_input_exit, and other. */
  reason: z.string().min(1).optional(),
  /** Compatibility alias emitted by older wrappers and hook integrations. */
  end_reason: z.string().min(1).optional(),
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
  /** True when this stop fired because a hook continued the subagent's turn. */
  stop_hook_active: z.boolean().optional(),
  usage: claudeUsageSchema.optional(),
});
export type SubagentStopPayload = z.infer<typeof subagentStopPayloadSchema>;

/**
 * Compaction callbacks.
 *
 * The upstream contract at 2.1.220 is `PreCompact { trigger, custom_instructions }`
 * and `PostCompact { trigger, compact_summary }`. **Neither reports a token
 * count** — no context size before or after, no dropped-message count
 * (docs/claude-code-usage-contract.md, finding 6). The counters below are
 * accepted for a wrapping harness that computed them; they are not a claim that
 * Claude Code sends them, and `capabilities.ts` excludes `contextTokensBefore`
 * accordingly.
 *
 * `custom_instructions` and `compact_summary` are deliberately absent. The
 * summary is a model-generated précis of the conversation — content — and
 * compaction telemetry needs the trigger and the sizes, not the text. Both are
 * ignored by the object's forward-compatible looseness rather than read and
 * screened, so there is no path by which they could reach an event.
 */
export const preCompactPayloadSchema = z.object({
  ...commonFields,
  hook_event_name: z.literal("PreCompact"),
  /** Upstream values: manual | auto. Forward-compatible: any string. */
  trigger: z.string().min(1).optional(),
  /** Compatibility alias emitted by older wrappers and hook integrations. */
  compact_trigger: z.string().min(1).optional(),
  /**
   * Harness-supplied, never upstream. Reported as an explicit exclusion rather
   * than carried across the process boundary: see `events.ts`.
   */
  context_tokens_before: z.number().int().min(0).optional(),
  estimated_tokens_removed: z.number().int().min(0).optional(),
});
export type PreCompactPayload = z.infer<typeof preCompactPayloadSchema>;

export const postCompactPayloadSchema = z.object({
  ...commonFields,
  hook_event_name: z.literal("PostCompact"),
  trigger: z.string().min(1).optional(),
  compact_trigger: z.string().min(1).optional(),
  /** Harness-supplied, never upstream; accepted here because one callback carries both. */
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
  /**
   * True when this stop fired because a hook continued the turn.
   *
   * Required upstream, optional here. It is what separates the once-per-prompt
   * stop from a continuation stop, which is what lets `delivery.ts` deduplicate
   * the former without suppressing the latter.
   */
  stop_hook_active: z.boolean().optional(),
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
  /** Read by `delivery.ts` to tell a once-per-prompt stop from a continuation. */
  stop_hook_active: z.boolean().optional(),
});
export type ClaudeIdentityFields = z.infer<typeof claudeIdentityFieldsSchema>;
