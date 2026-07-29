import type { ProviderDeliveryClaim, ProviderIdentityInput } from "../adapter.js";
import { claudeIdentityFieldsSchema } from "./schema.js";

/**
 * Which Claude Code callbacks carry an identifier that survives a redelivery.
 *
 * Grounded in the fields the hook payloads actually carry — the CLI's own
 * hook-input schemas at 2.1.220, recorded in
 * docs/claude-code-usage-contract.md:
 *
 * - `tool_use_id` is required on `PreToolUse`, `PostToolUse`,
 *   `PostToolUseFailure`, and `PermissionRequest`. It names one tool call, and
 *   the event name separates the pre-edge from the post-edge of that same call.
 * - `agent_id` is required on `SubagentStart`/`SubagentStop` and names one
 *   subagent instance.
 * - `prompt_id` correlates a firing with the prompt that triggered it, and
 *   exactly one `UserPromptSubmit` exists per prompt.
 * - `stop_hook_active` is required on `Stop` and `SubagentStop`, and is `false`
 *   exactly on the once-per-turn stop (finding 7).
 *
 * ## Why `Stop` is claimable at all now
 *
 * `Stop` carries usage, so a redelivered one double-counts a turn's tokens —
 * the worst outcome on this list, because a corrupted total cannot be
 * reconstructed. But `prompt_id` alone cannot separate a redelivery from a
 * genuine second stop: Claude Code fires `Stop` again when a hook continues the
 * turn. `stop_hook_active` is precisely that distinction, so the once-per-prompt
 * stop (`stop_hook_active: false`) is claimed and every continuation stop stays
 * unidentifiable.
 *
 * The gate is deliberately one-sided. Two continuation stops both report
 * `stop_hook_active: true`, so claiming an identity for them would suppress a
 * real second firing and lose its tokens — a certain loss to avoid a possible
 * double-count, which is the wrong trade in this direction (see
 * `providerDeliveryClaimSchema`). A payload that omits the field predates the
 * flag or came from a wrapper, and is likewise declined rather than guessed at.
 *
 * The same reasoning fixes an inversion on `SubagentStop`, which was keyed on
 * `agent_id` alone: a hook-continued subagent stop repeats `agent_id`, so it
 * would have been suppressed as a redelivery and its usage lost. It now declines
 * when `stop_hook_active` is `true`, and keeps `agent_id` otherwise — including
 * when the field is absent, which is the pre-existing coverage and the case where
 * `agent_id` genuinely names one stop.
 *
 * Everything else is deliberately excluded. `StopFailure` reports no
 * `stop_hook_active` upstream at all. `SessionStart`, `SessionEnd`, `PreCompact`,
 * and `PostCompact` carry nothing that distinguishes a redelivery from a real
 * second firing.
 */
const TOOL_SCOPED_EVENTS: readonly string[] = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
];

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

  if (fields.hook_event_name === "SubagentStart" && fields.agent_id !== undefined) {
    return {
      ...base,
      components: [fields.agent_id],
      evidence: ["payload.agent_id names one subagent instance"],
    };
  }

  if (
    fields.hook_event_name === "SubagentStop" &&
    fields.agent_id !== undefined &&
    fields.stop_hook_active !== true
  ) {
    return {
      ...base,
      components: [fields.agent_id],
      evidence: [
        "payload.agent_id names one subagent instance",
        "payload.stop_hook_active is not true, so this is not a hook-continued second stop",
      ],
    };
  }

  if (fields.hook_event_name === "UserPromptSubmit" && fields.prompt_id !== undefined) {
    return {
      ...base,
      components: [fields.prompt_id],
      evidence: ["payload.prompt_id names one prompt, submitted exactly once"],
    };
  }

  if (
    fields.hook_event_name === "Stop" &&
    fields.prompt_id !== undefined &&
    fields.stop_hook_active === false
  ) {
    return {
      ...base,
      // `agent_id` is present when the stop fired inside a subagent, where the
      // prompt is shared with the main thread's own stop.
      components:
        fields.agent_id === undefined
          ? [fields.prompt_id]
          : [fields.prompt_id, fields.agent_id],
      evidence: [
        "payload.prompt_id names one prompt",
        "payload.stop_hook_active is false, so this is the once-per-prompt stop rather than a continuation",
      ],
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
