import type { ProviderDeliveryClaim, ProviderIdentityInput } from "../adapter.js";
import { normalizeCursorPayload, type CursorPayload } from "./payload.js";

/**
 * Which Cursor callbacks carry an identifier that survives a redelivery.
 *
 * Cursor's envelope always carries `conversationId` — which scopes the identity —
 * and most events carry a payload-native id on top of it:
 *
 * - `toolCallId` names one tool call; the event name separates its before-edge
 *   from its after-edge.
 * - `generationId` names one generation, and `beforeSubmitPrompt`,
 *   `afterAgentResponse`, and `stop` each fire once per generation.
 * - `subagentInvocationId` names one delegated invocation.
 * - `sessionStart`/`sessionEnd` fire once per conversation, so the event name
 *   alone identifies them.
 *
 * Excluded on purpose:
 *
 * - `preCompact` carries nothing that separates two genuine compactions.
 * - The dedicated shell, MCP, file-edit, and file-read callbacks make
 *   `toolCallId` optional. Without it the only distinguishing fields are the
 *   command line and the file path, which are content, not identifiers — the
 *   contract's component guard would reject them, and it is right to.
 * - `timestampMillis` is deliberately *not* mixed in. It would make two callbacks
 *   in the same millisecond distinguishable, but it would also make a host that
 *   restamps a redelivery undetectable, and losing a duplicate suppression is
 *   the worse of the two failures for accounting.
 */
const deliveryComponents = (
  payload: CursorPayload,
): { readonly components: readonly string[]; readonly evidence: readonly string[] } | undefined => {
  switch (payload.hookEventName) {
    case "sessionStart":
    case "sessionEnd":
      return {
        components: [payload.hookEventName],
        evidence: [`cursor fires ${payload.hookEventName} once per conversation`],
      };
    case "beforeSubmitPrompt":
    case "afterAgentResponse":
    case "stop":
      return {
        components: [payload.generationId],
        evidence: [
          `payload.generationId names one generation, which fires ${payload.hookEventName} once`,
        ],
      };
    case "afterAgentThought":
      return payload.thoughtIndex === undefined
        ? undefined
        : {
            components: [payload.generationId, String(payload.thoughtIndex)],
            evidence: ["payload.generationId with payload.thoughtIndex names one thought"],
          };
    case "beforeToolUse":
    case "afterToolUse":
    case "toolUseFailed":
      return {
        components: [payload.toolCallId],
        evidence: ["payload.toolCallId names one tool call and repeats on redelivery"],
      };
    case "subagentStart":
    case "subagentStop":
      return {
        components: [payload.subagentInvocationId],
        evidence: ["payload.subagentInvocationId names one delegated invocation"],
      };
    case "beforeShellExecution":
    case "afterShellExecution":
    case "beforeMCPExecution":
    case "afterMCPExecution":
    case "afterFileEdit":
    case "beforeReadFile":
      return payload.toolCallId === undefined
        ? undefined
        : {
            components: [payload.toolCallId],
            evidence: ["payload.toolCallId names one tool call and repeats on redelivery"],
          };
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
  const normalized = normalizeCursorPayload(input.payload);
  if (normalized === undefined) {
    return undefined;
  }
  const { payload } = normalized;
  const identified = deliveryComponents(payload);
  if (identified === undefined) {
    return undefined;
  }
  return {
    sessionId: payload.conversationId,
    // The current-shape event name, not the raw one: a legacy `session_start` and
    // a current `sessionStart` are the same callback and must not dedupe apart.
    sourceEventName: payload.hookEventName,
    components: identified.components,
    evidence: identified.evidence,
  };
};
