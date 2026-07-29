import type { ProviderDeliveryClaim, ProviderIdentityInput } from "../adapter.js";
import { claudeIdentityFieldsSchema } from "./schema.js";

/**
 * Which Claude Code callbacks carry an identifier that survives a redelivery.
 *
 * Grounded in the fields the hook payloads actually carry (see `schema.ts`, taken
 * from Claude Code's published hooks reference):
 *
 * - `tool_use_id` is required on `PreToolUse`, `PostToolUse`,
 *   `PostToolUseFailure`, and `PermissionRequest`. It names one tool call, and
 *   the event name separates the pre-edge from the post-edge of that same call.
 * - `agent_id` is required on `SubagentStart`/`SubagentStop` and names one
 *   subagent instance.
 * - `prompt_id` (v2.1.196+) correlates a firing with the prompt that triggered
 *   it, and exactly one `UserPromptSubmit` exists per prompt.
 *
 * Everything else is deliberately excluded. `Stop` and `StopFailure` carry only
 * `prompt_id`, and Claude Code can fire `Stop` more than once for one prompt when
 * a hook continues the turn (`stop_hook_active`) — keying on `prompt_id` there
 * would suppress a *genuine* second stop and lose its usage numbers.
 * `SessionStart`, `SessionEnd`, `PreCompact`, and `PostCompact` carry nothing
 * that distinguishes a redelivery from a real second firing at all.
 */
const TOOL_SCOPED_EVENTS: readonly string[] = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
];

const SUBAGENT_SCOPED_EVENTS: readonly string[] = ["SubagentStart", "SubagentStop"];

export const claudeDeliveryIdentity = (
  input: ProviderIdentityInput,
): ProviderDeliveryClaim | undefined => {
  const parsed = claudeIdentityFieldsSchema.safeParse(input.payload);
  if (!parsed.success) {
    return undefined;
  }
  const fields = parsed.data;
  const base = { sessionId: fields.session_id, sourceEventName: fields.hook_event_name };

  if (TOOL_SCOPED_EVENTS.includes(fields.hook_event_name) && fields.tool_use_id !== undefined) {
    return {
      ...base,
      components: [fields.tool_use_id],
      evidence: ["payload.tool_use_id names one tool call and repeats on redelivery"],
    };
  }

  if (SUBAGENT_SCOPED_EVENTS.includes(fields.hook_event_name) && fields.agent_id !== undefined) {
    return {
      ...base,
      components: [fields.agent_id],
      evidence: ["payload.agent_id names one subagent instance"],
    };
  }

  if (fields.hook_event_name === "UserPromptSubmit" && fields.prompt_id !== undefined) {
    return {
      ...base,
      components: [fields.prompt_id],
      evidence: ["payload.prompt_id names one prompt, submitted exactly once"],
    };
  }

  return undefined;
};

/**
 * Why each remaining Claude Code callback carries no delivery identity, and what
 * would have to exist for it to.
 *
 * Reported through `readDeliveryGap` when `requireCallbackId` is set, so an
 * operator auditing coverage reads the actual protocol reason instead of
 * "callback-not-identifiable". Kept exhaustive over
 * {@link CLAUDE_HOOK_EVENT_NAMES} — every event is either identified above or
 * explained here, so adding a hook event without deciding its delivery status
 * reads as an omission rather than passing silently.
 *
 * The four tool events and the two subagent events appear here too, because their
 * identifying field is *optional in practice*: a payload that omits `tool_use_id`
 * or `agent_id` reaches the same dead end as an event that never had one, and the
 * diagnostic should say which field is missing rather than blame the event.
 */
export const CLAUDE_DELIVERY_GAPS: Readonly<Record<string, string>> = Object.freeze({
  SessionStart:
    "no per-firing id; payload `source` (startup, resume, clear, compact, fork) means SessionStart fires repeatedly under one session_id",
  SessionEnd: "no per-firing id; a cleared and a resumed session end under the same session_id",
  PreCompact: "no compaction id; payload `trigger` does not separate two genuine compactions",
  PostCompact: "no compaction id; payload `trigger` does not separate two genuine compactions",
  Stop:
    "prompt_id is not a delivery identity here: Claude Code can fire Stop more than once per prompt when a hook continues the turn (stop_hook_active)",
  StopFailure:
    "prompt_id is not a delivery identity here: one prompt can fail more than once, and error_type names a class rather than a firing",
  PreToolUse: "payload.tool_use_id absent; nothing else in this callback names one tool call",
  PostToolUse: "payload.tool_use_id absent; nothing else in this callback names one tool call",
  PostToolUseFailure:
    "payload.tool_use_id absent; nothing else in this callback names one tool call",
  PermissionRequest:
    "payload.tool_use_id absent; nothing else in this callback names one tool call",
  SubagentStart: "payload.agent_id absent; agent_type names a class of subagents, not an instance",
  SubagentStop: "payload.agent_id absent; agent_type names a class of subagents, not an instance",
  UserPromptSubmit: "payload.prompt_id absent; requires Claude Code v2.1.196 or later",
});
