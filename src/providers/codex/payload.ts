import { z } from "zod";

/**
 * Codex CLI hook stdin payloads.
 *
 * Shape is drawn from the public Codex hooks reference (developers.openai.com
 * /codex/hooks, mirrored at learn.chatgpt.com/docs/hooks) as of 2026-07. Codex
 * has no dependable `SessionEnd`, so it is deliberately not modelled here; see
 * `adapter.ts` for how `Stop` and a state-store TTL substitute for it.
 *
 * Field names Codex does not document precisely (`tool_call_id`,
 * `subagent_id`, `occurred_at`) are this adapter's own choice of a stable
 * correlation key; see the provenance note in `tests/fixtures/codex/PROVENANCE.md`.
 */

const permissionModeSchema = z.enum([
  "default",
  "acceptEdits",
  "plan",
  "dontAsk",
  "bypassPermissions",
]);
export type CodexPermissionMode = z.infer<typeof permissionModeSchema>;

/** Mirrors the rollout/exec `total_token_usage` / `last_token_usage` shape. */
export const codexUsageSchema = z.object({
  input_tokens: z.number().int().min(0).optional(),
  cached_input_tokens: z.number().int().min(0).optional(),
  output_tokens: z.number().int().min(0).optional(),
  reasoning_output_tokens: z.number().int().min(0).optional(),
  total_tokens: z.number().int().min(0).optional(),
});
export type CodexUsage = z.infer<typeof codexUsageSchema>;

const baseFields = {
  session_id: z.string().min(1).max(256),
  cwd: z.string().min(1).max(4096).optional(),
  model: z.string().min(1).max(256).optional(),
  permission_mode: permissionModeSchema.optional(),
  transcript_path: z.string().min(1).max(4096).optional(),
  codex_version: z.string().min(1).max(64).optional(),
  /** Not part of the documented protocol; lets tests and replay stay deterministic. */
  occurred_at: z.number().int().min(0).optional(),
};

export const codexSessionStartPayloadSchema = z.object({
  ...baseFields,
  hook_event_name: z.literal("SessionStart"),
  source: z.enum(["startup", "resume", "clear", "compact"]).optional(),
});
export type CodexSessionStartPayload = z.infer<typeof codexSessionStartPayloadSchema>;

export const codexUserPromptSubmitPayloadSchema = z.object({
  ...baseFields,
  hook_event_name: z.literal("UserPromptSubmit"),
  turn_id: z.string().min(1).max(256).optional(),
  prompt: z.string().max(1_000_000).optional(),
});
export type CodexUserPromptSubmitPayload = z.infer<typeof codexUserPromptSubmitPayloadSchema>;

export const codexPreToolUsePayloadSchema = z.object({
  ...baseFields,
  hook_event_name: z.literal("PreToolUse"),
  turn_id: z.string().min(1).max(256).optional(),
  tool_name: z.string().min(1).max(256),
  tool_call_id: z.string().min(1).max(256).optional(),
  tool_input: z.unknown().optional(),
});
export type CodexPreToolUsePayload = z.infer<typeof codexPreToolUsePayloadSchema>;

export const codexPermissionRequestPayloadSchema = z.object({
  ...baseFields,
  hook_event_name: z.literal("PermissionRequest"),
  turn_id: z.string().min(1).max(256).optional(),
  tool_name: z.string().min(1).max(256).optional(),
  tool_call_id: z.string().min(1).max(256).optional(),
  tool_input: z.unknown().optional(),
});
export type CodexPermissionRequestPayload = z.infer<typeof codexPermissionRequestPayloadSchema>;

export const codexPostToolUsePayloadSchema = z.object({
  ...baseFields,
  hook_event_name: z.literal("PostToolUse"),
  turn_id: z.string().min(1).max(256).optional(),
  tool_name: z.string().min(1).max(256),
  tool_call_id: z.string().min(1).max(256).optional(),
  tool_input: z.unknown().optional(),
  tool_response: z.unknown().optional(),
  permission_decision: z.enum(["allowed", "denied", "deferred"]).optional(),
  duration_ms: z.number().min(0).optional(),
});
export type CodexPostToolUsePayload = z.infer<typeof codexPostToolUsePayloadSchema>;

export const codexPreCompactPayloadSchema = z.object({
  ...baseFields,
  hook_event_name: z.literal("PreCompact"),
  trigger: z.enum(["auto", "manual"]).optional(),
  context_tokens_before: z.number().int().min(0).optional(),
});
export type CodexPreCompactPayload = z.infer<typeof codexPreCompactPayloadSchema>;

export const codexPostCompactPayloadSchema = z.object({
  ...baseFields,
  hook_event_name: z.literal("PostCompact"),
  trigger: z.enum(["auto", "manual"]).optional(),
  context_tokens_after: z.number().int().min(0).optional(),
  dropped_message_count: z.number().int().min(0).optional(),
  usage: codexUsageSchema.optional(),
});
export type CodexPostCompactPayload = z.infer<typeof codexPostCompactPayloadSchema>;

export const codexSubagentStartPayloadSchema = z.object({
  ...baseFields,
  hook_event_name: z.literal("SubagentStart"),
  turn_id: z.string().min(1).max(256).optional(),
  subagent_id: z.string().min(1).max(256),
  subagent_type: z.string().min(1).max(256).optional(),
});
export type CodexSubagentStartPayload = z.infer<typeof codexSubagentStartPayloadSchema>;

export const codexSubagentStopPayloadSchema = z.object({
  ...baseFields,
  hook_event_name: z.literal("SubagentStop"),
  turn_id: z.string().min(1).max(256).optional(),
  subagent_id: z.string().min(1).max(256),
  status: z.enum(["completed", "failed", "cancelled"]).optional(),
  usage: codexUsageSchema.optional(),
});
export type CodexSubagentStopPayload = z.infer<typeof codexSubagentStopPayloadSchema>;

export const codexStopPayloadSchema = z.object({
  ...baseFields,
  hook_event_name: z.literal("Stop"),
  turn_id: z.string().min(1).max(256).optional(),
  stop_reason: z.string().min(1).max(256).optional(),
  usage: codexUsageSchema.optional(),
  duration_ms: z.number().min(0).optional(),
});
export type CodexStopPayload = z.infer<typeof codexStopPayloadSchema>;

export const CODEX_HOOK_EVENT_NAMES = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "SubagentStart",
  "SubagentStop",
  "Stop",
] as const;
export type CodexHookEventName = (typeof CODEX_HOOK_EVENT_NAMES)[number];

export const codexHookPayloadSchema = z.discriminatedUnion("hook_event_name", [
  codexSessionStartPayloadSchema,
  codexUserPromptSubmitPayloadSchema,
  codexPreToolUsePayloadSchema,
  codexPermissionRequestPayloadSchema,
  codexPostToolUsePayloadSchema,
  codexPreCompactPayloadSchema,
  codexPostCompactPayloadSchema,
  codexSubagentStartPayloadSchema,
  codexSubagentStopPayloadSchema,
  codexStopPayloadSchema,
]);
export type CodexHookPayload = z.infer<typeof codexHookPayloadSchema>;

/** Loose shape check used to award `weak` confidence to a recognizable-but-malformed payload. */
export const codexHookEnvelopeSchema = z.object({
  session_id: z.string().min(1),
  hook_event_name: z.enum(CODEX_HOOK_EVENT_NAMES),
});
