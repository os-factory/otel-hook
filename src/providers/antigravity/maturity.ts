/**
 * Maturity of the Antigravity provider adapter.
 *
 * `experimental` means: the five hook names and the six field names this
 * adapter treats as verified (`conversationId`, `workspacePaths`, `stepIdx`,
 * `invocationNum`, `transcriptPath`, `artifactDirectoryPath`) came from the
 * integration task, not from a captured transcript this package has seen.
 * Every other field (`toolName`, `toolInput`, `toolResponse`, `isError`,
 * `fullyIdle`, `agentVersion`) and every mapping decision below is a
 * conservative reconstruction pending confirmation.
 */
export const ANTIGRAVITY_PROVIDER_MATURITY = "experimental" as const;
export type AntigravityProviderMaturity = typeof ANTIGRAVITY_PROVIDER_MATURITY;

/**
 * What must be verified against real Antigravity hook captures before this
 * adapter can be promoted past `experimental`:
 *
 * 1. `invocationNum` indexing: this adapter assumes it is 0-based and treats
 *    `invocationNum === 0` as the first invocation of a conversation, which is
 *    the only signal used to emit a (marked-inferred) `session.start`. If the
 *    real counter is 1-based, or does not reset per conversation, that
 *    assumption is wrong and needs a fixed base or an explicit start signal.
 * 2. Whether `PreInvocation`/`PostInvocation` ever expose a model identifier
 *    or usage figures. If they do, promote from the current session-start/
 *    ignored handling to `generation.start`/`generation.end` — this adapter
 *    deliberately does not fabricate a `modelId` to unlock that today.
 * 3. Whether Antigravity reports its own tool-call identifier. This adapter
 *    derives `toolCallId` from `conversationId` + `stepIdx`; a native id
 *    would be strictly more precise and should replace the derived one.
 * 4. Whether `invoke_subagent` warrants a dedicated subagent lifecycle
 *    (`subagent.start`/`subagent.end` with parent/child invocation identity)
 *    instead of being modeled as an ordinary delegated tool call.
 * 5. Whether `Stop.fullyIdle` is the correct — and only — terminal signal for
 *    a conversation, and whether `PostToolUse.isError` is really optional or
 *    always present.
 * 6. A captured, redacted end-to-end transcript replayed through this
 *    adapter with zero `schema-validation-failed` or `privacy-policy-violation`
 *    diagnostics.
 */
export const ANTIGRAVITY_PROMOTION_GATES: readonly string[] = Object.freeze([
  "confirm invocationNum indexing base and per-conversation reset behaviour",
  "confirm whether PreInvocation/PostInvocation ever expose modelId or usage",
  "confirm whether Antigravity reports a native tool-call identifier",
  "confirm whether invoke_subagent should have a dedicated subagent lifecycle",
  "confirm Stop.fullyIdle and PostToolUse.isError against real payloads",
  "replay a captured, redacted transcript with zero validation/privacy diagnostics",
]);
