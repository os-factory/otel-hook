/**
 * Maturity of the Antigravity provider adapter.
 *
 * The published hooks reference (antigravity.google/docs/hooks, read
 * 2026-11-02) replaced the reconstructed `hookEventName` envelope this adapter
 * used to parse. What that reference establishes is implemented. What it does
 * not establish stays an exclusion, covered by a test, and is not promoted by
 * filling in the gap.
 *
 * `experimental` remains because two gates are still open: this repository has
 * no captured Antigravity transcript to replay, and the reference gives
 * `PreToolUse` the same fields as a `PostToolUse` that omits `error` (and the
 * same for the invocation pair). A capture that separated those edges would
 * close the second gate. Inventing the separation would not.
 */
export const ANTIGRAVITY_PROVIDER_MATURITY = "experimental" as const;
export type AntigravityProviderMaturity = typeof ANTIGRAVITY_PROVIDER_MATURITY;

/**
 * Open questions. Printed by `otel-hook providers`. Empty would mean the
 * adapter is eligible for `stable`; it is not.
 */
export const ANTIGRAVITY_PROMOTION_GATES: readonly string[] = Object.freeze([
  "replay a captured, redacted Antigravity transcript; the published hooks reference is not a capture, and this repository has none",
  "confirm a stdin discriminator separating PreToolUse from a PostToolUse that omits error, and PreInvocation from PostInvocation",
]);

/**
 * Decisions the reference settles, each one a behavior the adapter tests lock
 * in. These are exclusions, not pending gates: the adapter must not grow the
 * corresponding event by inference.
 */
export const ANTIGRAVITY_CONTRACT_EXCLUSIONS: readonly {
  readonly id: string;
  readonly summary: string;
}[] = Object.freeze([
  Object.freeze({
    id: "no-usage",
    summary:
      "The hooks reference documents modelName and no token, cache, reasoning, or cost field. Usage is never emitted, and modelName is copied only when a payload actually carries it.",
  }),
  Object.freeze({
    id: "no-session-end",
    summary:
      "SessionStart is the only session boundary the reference documents. Stop is execution-loop termination (fullyIdle, terminationReason, executionNum) and can be asked to continue, so it is not session.end.",
  }),
  Object.freeze({
    id: "no-generation",
    summary:
      "PreInvocation and PostInvocation are the model-call edges and share one stdin shape, so neither generation.start nor generation.end is emitted. modelName on those payloads is not a substitute for knowing which edge arrived.",
  }),
  Object.freeze({
    id: "no-native-tool-call-id",
    summary:
      "toolCall carries name and args only. A PostToolUse toolCallId is derived from conversationId and stepIdx. No native id is invented, and a tool payload without error is not given a toolCallId at all.",
  }),
  Object.freeze({
    id: "no-subagent-lifecycle",
    summary:
      "invoke_subagent is a documented tool, not a hook. A PostToolUse for it is tool.end. No subagent.start or subagent.end is emitted, and tool.start is not emitted either, so toolKind is never claimed.",
  }),
  Object.freeze({
    id: "no-unlabeled-tool-edge",
    summary:
      "A tool payload without an error key matches both PreToolUse and a PostToolUse that omitted the optional field. Neither tool.start nor tool.end is emitted. hookEventName is not consulted.",
  }),
  Object.freeze({
    id: "post-tool-error-is-a-string",
    summary:
      "PostToolUse.error is an optional string. A non-empty string is outcome error, an empty string is outcome ok, and the reconstructed boolean isError is ignored.",
  }),
  Object.freeze({
    id: "no-tool-output",
    summary:
      "PostToolUse does not carry tool output. args and the error string stay inside the adapter; the canonical event records the tool name and the outcome only.",
  }),
]);
