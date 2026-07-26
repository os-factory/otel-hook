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
