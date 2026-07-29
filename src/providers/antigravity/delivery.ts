import type { ProviderDeliveryClaim, ProviderIdentityInput } from "../adapter.js";
import { antigravityHookPayloadSchema } from "./payload.js";

/**
 * Which Antigravity callbacks carry an identifier that survives a redelivery.
 *
 * Everything here is built from `invocationNum` and `stepIdx` — the two counters
 * on the *verified* field list (see `./payload.ts`) — scoped by the equally
 * verified `conversationId`:
 *
 * - The tool pair takes both counters. Together they name one step of one
 *   invocation, and the event name separates its before-edge from its after-edge.
 * - The invocation pair takes `invocationNum` alone. A counter named for the
 *   invocation it numbers is what makes `PreInvocation` fire once per value of
 *   it: a redelivery repeats the number, while a genuine second invocation
 *   advances it. That is the same argument the tool pair rests on, applied to the
 *   field that is present on *every* Antigravity payload rather than only the
 *   tool ones.
 *
 * `Stop` remains excluded. It can fire more than once per invocation (idle, then
 * fully idle), and the only field that would separate those two firings —
 * `fullyIdle` — is a reconstruction this adapter has not confirmed against a real
 * capture, so it is not something to build an at-most-once guarantee on. Keying
 * `Stop` on `invocationNum` alone would be worse than not identifying it: it
 * would suppress the second, *real* firing.
 */
const INVOCATION_SCOPED_EVENTS: readonly string[] = ["PreInvocation", "PostInvocation"];

export const antigravityDeliveryIdentity = (
  input: ProviderIdentityInput,
): ProviderDeliveryClaim | undefined => {
  const parsed = antigravityHookPayloadSchema.safeParse(input.payload);
  if (!parsed.success) {
    return undefined;
  }
  const payload = parsed.data;

  if (payload.hookEventName === "PreToolUse" || payload.hookEventName === "PostToolUse") {
    return {
      sessionId: payload.conversationId,
      sourceEventName: payload.hookEventName,
      components: [String(payload.invocationNum), String(payload.stepIdx)],
      evidence: ["payload.invocationNum with payload.stepIdx names one step of one invocation"],
    };
  }

  if (INVOCATION_SCOPED_EVENTS.includes(payload.hookEventName)) {
    return {
      sessionId: payload.conversationId,
      sourceEventName: payload.hookEventName,
      components: [String(payload.invocationNum)],
      evidence: ["payload.invocationNum names one invocation, whose edges fire once each"],
    };
  }

  return undefined;
};

/**
 * Why the remaining Antigravity callback carries no delivery identity.
 *
 * Exhaustive over {@link ANTIGRAVITY_HOOK_EVENT_NAMES}: every other event is
 * identified above, so `Stop` is the whole of this adapter's coverage gap and the
 * reason names the field whose confirmation would close it.
 */
export const ANTIGRAVITY_DELIVERY_GAPS: Readonly<Record<string, string>> = Object.freeze({
  Stop:
    "Stop can fire twice per invocation (idle, then fully idle) and payload `fullyIdle` — the only field separating them — is an unconfirmed reconstruction, so invocationNum alone would suppress the second real firing",
});
