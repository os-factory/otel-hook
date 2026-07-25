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
 * 1. Whether `PreInvocation`/`PostInvocation` ever expose a model identifier
 *    or usage figures. If they do, promote from the current ignored handling
 *    to `generation.start`/`generation.end` — this adapter deliberately does
 *    not fabricate a `modelId` to unlock that today, and does not treat
 *    `invocationNum === 0` as a session-start signal: Antigravity documents
 *    no such hook, and a genuine session-start fact requires more than an
 *    invocation counter reaching zero.
 * 2. Whether Antigravity documents any hook that reports a real session or
 *    conversation start/end (as opposed to per-invocation bookkeeping). If
 *    one exists, add `session.start`/`session.end` handling for it instead of
 *    inferring boundaries from `PreInvocation`/`Stop`.
 * 3. Whether `Stop` (or another hook) ever exposes enough to honestly close
 *    out a `generation.end` — a model identifier, an outcome, or a
 *    generation id correlating it to a prior invocation. Today `Stop` is
 *    ignored regardless of `fullyIdle`, because turn/execution completion
 *    alone does not map to any canonical event without inventing one.
 * 4. Whether Antigravity reports its own tool-call identifier. This adapter
 *    derives `toolCallId` from `conversationId` + `stepIdx`; a native id
 *    would be strictly more precise and should replace the derived one.
 * 5. Whether `invoke_subagent` warrants a dedicated subagent lifecycle
 *    (`subagent.start`/`subagent.end` with parent/child invocation identity)
 *    instead of being modeled as an ordinary delegated tool call.
 * 6. Whether `PostToolUse.isError` is really optional or always present.
 * 7. A captured, redacted end-to-end transcript replayed through this
 *    adapter with zero `schema-validation-failed` or `privacy-policy-violation`
 *    diagnostics.
 */
export const ANTIGRAVITY_PROMOTION_GATES: readonly string[] = Object.freeze([
  "confirm whether PreInvocation/PostInvocation ever expose modelId or usage",
  "confirm whether any hook documents a genuine session/conversation start or end",
  "confirm whether Stop or another hook can honestly close out a generation.end",
  "confirm whether Antigravity reports a native tool-call identifier",
  "confirm whether invoke_subagent should have a dedicated subagent lifecycle",
  "confirm PostToolUse.isError against real payloads",
  "replay a captured, redacted transcript with zero validation/privacy diagnostics",
]);
