import type { ProviderDeliveryClaim, ProviderIdentityInput } from "../adapter.js";
import { normalizeCursorPayload, type CursorPayload } from "./payload.js";

/**
 * Which Cursor callbacks carry an identifier that survives a redelivery.
 *
 * Cursor's envelope always carries `conversation_id`, which scopes the identity.
 * On top of it:
 *
 * - `tool_use_id` names one tool call, and the event name separates its
 *   before-edge from its after-edge and from its failure edge.
 * - `generation_id` names one generation, and `beforeSubmitPrompt` and `stop`
 *   each fire once per generation.
 * - `sessionStart`/`sessionEnd` fire once per conversation, so the event name
 *   alone identifies them.
 *
 * Excluded on purpose:
 *
 * - The dedicated shell, MCP, and file callbacks carry no `tool_use_id` at all —
 *   neither the reference nor any capture shows one. What distinguishes two of
 *   them is the command line or the file path, which are content, not
 *   identifiers; the contract's component guard rejects both (no whitespace, no
 *   path separators), and it is right to. `generation_id` alone would be wrong
 *   in the other direction: one generation runs many shell commands, so it would
 *   suppress genuine second calls as redeliveries.
 * - `preCompact` carries nothing that separates two genuine compactions.
 * - `subagentStart`/`subagentStop` produce no events at all (see `adapter.ts`),
 *   so there is nothing to deduplicate.
 * - There is no timestamp field to mix in, and Cursor sends none — so the usual
 *   temptation to make two same-millisecond callbacks distinguishable does not
 *   even arise here.
 */
const deliveryComponents = (
  payload: CursorPayload,
): { readonly components: readonly string[]; readonly evidence: readonly string[] } | undefined => {
  switch (payload.hook_event_name) {
    case "sessionStart":
    case "sessionEnd":
      return {
        components: [payload.hook_event_name],
        evidence: [`cursor fires ${payload.hook_event_name} once per conversation`],
      };
    case "beforeSubmitPrompt":
    case "stop":
      return payload.generation_id === undefined || payload.generation_id.length === 0
        ? undefined
        : {
            components: [payload.generation_id],
            evidence: [
              `payload.generation_id names one generation, which fires ${payload.hook_event_name} once`,
            ],
          };
    case "preToolUse":
    case "postToolUse":
    case "postToolUseFailure":
      return payload.tool_use_id === undefined || payload.tool_use_id.length === 0
        ? undefined
        : {
            components: [payload.tool_use_id],
            evidence: ["payload.tool_use_id names one tool call and repeats on redelivery"],
          };
    case "afterAgentResponse":
    case "afterAgentThought":
    case "beforeShellExecution":
    case "afterShellExecution":
    case "beforeMCPExecution":
    case "afterMCPExecution":
    case "beforeReadFile":
    case "afterFileEdit":
    case "subagentStart":
    case "subagentStop":
    case "preCompact":
      return undefined;
  }
};

/**
 * Why each Cursor callback that {@link cursorDeliveryIdentity} declines carries no
 * delivery identity.
 *
 * Exhaustive over the hook event names in `./payload.ts`. Only `preCompact` is
 * unconditionally unidentifiable; the rest appear here for the case where their
 * optional `toolCallId` is absent, which is the whole of Cursor's coverage gap.
 */
export const CURSOR_DELIVERY_GAPS: Readonly<Record<string, string>> = Object.freeze({
  preCompact: "no compaction id; payload `trigger` does not separate two genuine compactions",
  afterAgentThought:
    "payload.thoughtIndex absent; generationId alone names the generation, not one thought within it",
  beforeShellExecution:
    "payload.toolCallId absent; the only remaining field is the command line, which is content and may not become an id",
  afterShellExecution:
    "payload.toolCallId absent; the only remaining field is the command line, which is content and may not become an id",
  beforeMCPExecution:
    "payload.toolCallId absent; the only remaining fields are the tool name and its arguments, which are content",
  afterMCPExecution:
    "payload.toolCallId absent; the only remaining fields are the tool name and its arguments, which are content",
  afterFileEdit:
    "payload.toolCallId absent; the only remaining field is the file path, which is content and may not become an id",
  beforeReadFile:
    "payload.toolCallId absent; the only remaining field is the file path, which is content and may not become an id",
});

export const cursorDeliveryIdentity = (
  input: ProviderIdentityInput,
): ProviderDeliveryClaim | undefined => {
  const payload = normalizeCursorPayload(input.payload);
  if (payload === undefined) {
    return undefined;
  }
  const identified = deliveryComponents(payload);
  if (identified === undefined) {
    return undefined;
  }
  return {
    sessionId: payload.conversation_id,
    sourceEventName: payload.hook_event_name,
    components: identified.components,
    evidence: identified.evidence,
  };
};
