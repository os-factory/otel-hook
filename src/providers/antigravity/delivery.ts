import type { ProviderDeliveryClaim, ProviderIdentityInput } from "../adapter.js";
import { classifyAntigravityPayload } from "./payload.js";

/**
 * Which Antigravity callbacks carry an identifier that survives a redelivery.
 *
 * Stdin does not name the event, so a field that is shared by two events is
 * not an identifier: keying `PreInvocation` and `PostInvocation` on
 * `invocationNum` would suppress one of them. The two shapes that belong to
 * one event are identified:
 *
 * - `PostToolUse`, only once `error` is present (the field `PreToolUse` does
 *   not have). `stepIdx` is the documented index of that completed step.
 * - `Stop`. `executionNum` numbers the execution attempt and `fullyIdle`
 *   separates a not-yet-idle stop from the idle one. Both are required by the
 *   reference, so together they name one observation without collapsing the
 *   other. `invocationNum` is not on `Stop` and is not used.
 */
export const antigravityDeliveryIdentity = (
  input: ProviderIdentityInput,
): ProviderDeliveryClaim | undefined => {
  const classified = classifyAntigravityPayload(input.payload);
  if (classified.status !== "exact") {
    return undefined;
  }

  if (classified.kind === "tool-after") {
    return {
      sessionId: classified.payload.conversationId,
      sourceEventName: "PostToolUse",
      components: [String(classified.payload.stepIdx)],
      evidence: ["payload.stepIdx names the completed step once payload.error shows this is PostToolUse"],
    };
  }

  if (classified.kind === "stop") {
    return {
      sessionId: classified.payload.conversationId,
      sourceEventName: "Stop",
      components: [String(classified.payload.executionNum), classified.payload.fullyIdle ? "true" : "false"],
      evidence: ["payload.executionNum and payload.fullyIdle together name one Stop observation"],
    };
  }

  return undefined;
};

/**
 * Why the remaining callbacks carry no replay-stable identity.
 *
 * `Stop` is identified above. Every other documented event is here, including
 * `PostToolUse`: the claim above is conditional on `error`, and a payload that
 * omits it is not identified.
 */
export const ANTIGRAVITY_DELIVERY_GAPS: Readonly<Record<string, string>> = Object.freeze({
  SessionStart:
    "SessionStart has no callback discriminator besides conversationId, which is already the session scope, so a second start cannot be separated from a redelivery",
  PreToolUse:
    "stdin does not name the event, and PreToolUse shares toolCall plus stepIdx with a PostToolUse that omits error, so claiming either id would suppress the other edge",
  PostToolUse:
    "PostToolUse is identified from stepIdx only when error is present; without that field it is indistinguishable from PreToolUse and no id is claimed",
  PreInvocation:
    "PreInvocation and PostInvocation share invocationNum and initialNumSteps, and stdin does not say which edge arrived, so invocationNum would collapse the pair",
  PostInvocation:
    "PreInvocation and PostInvocation share invocationNum and initialNumSteps, and stdin does not say which edge arrived, so invocationNum would collapse the pair",
});
