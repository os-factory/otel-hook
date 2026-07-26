import type { ProviderDeliveryClaim, ProviderIdentityInput } from "../adapter.js";
import { antigravityHookPayloadSchema } from "./payload.js";

/**
 * Which Antigravity callbacks carry an identifier that survives a redelivery.
 *
 * Only the tool pair, and only from `invocationNum` and `stepIdx` — the two
 * counters on the *verified* field list (see `./payload.ts`). Together with
 * `conversationId`, which scopes the identity, they name one step of one
 * invocation, and the event name separates its before-edge from its after-edge.
 *
 * `PreInvocation`, `PostInvocation`, and `Stop` are excluded. `Stop` in
 * particular can fire more than once per invocation (idle, then fully idle), and
 * the only field that would separate those two firings — `fullyIdle` — is a
 * reconstruction this adapter has not confirmed against a real capture, so it is
 * not something to build an at-most-once guarantee on. All three produce no
 * canonical events anyway, so nothing is lost by not identifying them.
 */
export const antigravityDeliveryIdentity = (
  input: ProviderIdentityInput,
): ProviderDeliveryClaim | undefined => {
  const parsed = antigravityHookPayloadSchema.safeParse(input.payload);
  if (!parsed.success) {
    return undefined;
  }
  const payload = parsed.data;
  if (payload.hookEventName !== "PreToolUse" && payload.hookEventName !== "PostToolUse") {
    return undefined;
  }
  return {
    sessionId: payload.conversationId,
    sourceEventName: payload.hookEventName,
    components: [String(payload.invocationNum), String(payload.stepIdx)],
    evidence: ["payload.invocationNum with payload.stepIdx names one step of one invocation"],
  };
};
