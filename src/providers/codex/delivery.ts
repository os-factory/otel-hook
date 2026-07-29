import type { ProviderDeliveryClaim, ProviderIdentityInput } from "../adapter.js";
import { codexHookPayloadSchema, type CodexHookPayload } from "./payload.js";

/**
 * Which Codex callbacks carry an identifier that survives a redelivery.
 *
 * - `tool_call_id` names one tool call. The event name separates the pre-edge,
 *   the permission prompt, and the post-edge of that same call.
 * - `subagent_id` is required on `SubagentStart`/`SubagentStop`.
 * - `turn_id` names one turn, and Codex fires `UserPromptSubmit` and `Stop`
 *   exactly once per turn — `Stop` is documented as the reliable end-of-turn
 *   callback, which is what makes it safe to key on here even though Claude
 *   Code's `Stop` is not.
 *
 * Excluded: `SessionStart`, `PreCompact`, and `PostCompact` carry no per-callback
 * field at all, and `tool_name` alone is not one — the same tool called twice in
 * a turn would collapse into a single delivery. `occurred_at` is not used either:
 * it is this adapter's own optional convenience field, not part of the documented
 * protocol, so a real Codex payload would not carry it.
 */
const deliveryComponents = (
  payload: CodexHookPayload,
): { readonly components: readonly string[]; readonly evidence: readonly string[] } | undefined => {
  switch (payload.hook_event_name) {
    case "PreToolUse":
    case "PermissionRequest":
    case "PostToolUse":
      return payload.tool_call_id === undefined
        ? undefined
        : {
            components: [payload.tool_call_id],
            evidence: ["payload.tool_call_id names one tool call and repeats on redelivery"],
          };
    case "SubagentStart":
    case "SubagentStop":
      return {
        components: [payload.subagent_id],
        evidence: ["payload.subagent_id names one subagent instance"],
      };
    case "UserPromptSubmit":
    case "Stop":
      return payload.turn_id === undefined
        ? undefined
        : {
            components: [payload.turn_id],
            evidence: [`payload.turn_id names one turn, which fires ${payload.hook_event_name} once`],
          };
    case "SessionStart":
    case "PreCompact":
    case "PostCompact":
      return undefined;
  }
};

/**
 * Why each Codex callback that {@link codexDeliveryIdentity} declines carries no
 * delivery identity.
 *
 * Exhaustive over {@link CODEX_HOOK_EVENT_NAMES}. The tool and turn events appear
 * here because their identifying field is optional in the documented protocol:
 * `tool_call_id` and `turn_id` are this adapter's chosen correlation keys, and a
 * payload that omits one reaches the same dead end as an event that never had it.
 * Naming the absent field is the point — that is the one thing a host can fix.
 */
export const CODEX_DELIVERY_GAPS: Readonly<Record<string, string>> = Object.freeze({
  SessionStart:
    "no per-firing id; payload `source` (startup, resume, clear, compact) means SessionStart fires repeatedly under one session_id",
  PreCompact: "no compaction id; payload `trigger` does not separate two genuine compactions",
  PostCompact: "no compaction id; payload `trigger` does not separate two genuine compactions",
  PreToolUse:
    "payload.tool_call_id absent; tool_name is not a substitute because one turn can call the same tool twice",
  PostToolUse:
    "payload.tool_call_id absent; tool_name is not a substitute because one turn can call the same tool twice",
  PermissionRequest:
    "payload.tool_call_id absent; tool_name is not a substitute because one turn can prompt for the same tool twice",
  UserPromptSubmit: "payload.turn_id absent; nothing else in this callback names one turn",
  Stop: "payload.turn_id absent; nothing else in this callback names one turn",
  SubagentStart: "payload.subagent_id absent, so no subagent instance is named",
  SubagentStop: "payload.subagent_id absent, so no subagent instance is named",
});

export const codexDeliveryIdentity = (
  input: ProviderIdentityInput,
): ProviderDeliveryClaim | undefined => {
  const parsed = codexHookPayloadSchema.safeParse(input.payload);
  if (!parsed.success) {
    return undefined;
  }
  const payload = parsed.data;
  const identified = deliveryComponents(payload);
  if (identified === undefined) {
    return undefined;
  }
  return {
    sessionId: payload.session_id,
    sourceEventName: payload.hook_event_name,
    components: identified.components,
    evidence: identified.evidence,
  };
};
