import type { ProviderCapabilities } from "../adapter.js";

/**
 * What this adapter can actually observe from Claude Code hooks.
 *
 * `reportsCachedInput`/`reportsCacheCreation` are true because the payload
 * schema *accepts* Anthropic's usage shape when a wrapping harness attaches
 * it — Claude Code's own hook JSON never carries token counts, and this
 * adapter never reads the transcript to find them. `reportsReasoningOutput`
 * and `reportsProviderTotal` are false: Anthropic's usage shape has no
 * separate reasoning-token bucket and no grand-total field to disagree or
 * agree with.
 */
export const CLAUDE_CODE_CAPABILITIES: ProviderCapabilities = Object.freeze({
  lifecycleEvents: Object.freeze([
    "session.start",
    "session.end",
    "prompt.submitted",
    "generation.start",
    "generation.end",
    "tool.start",
    "tool.end",
    "subagent.start",
    "subagent.end",
    "compaction.performed",
  ] as const),
  usageTemporality: "delta",
  reportsCachedInput: true,
  reportsCacheCreation: true,
  cacheCreationAccounting: "included-in-input",
  reportsReasoningOutput: false,
  reportsProviderTotal: false,
  reportsCost: false,
  emitsSubagentEvents: true,
  emitsCompactionEvents: true,
  // The hook is telemetry-only and must never influence Claude Code's own
  // permission/continuation decisions (ADR 0004: fail-open).
  requiresHookResponse: false,
  // Tool, subagent, and prompt callbacks carry a replay-stable id; session,
  // stop, and compaction callbacks do not. See `./delivery.ts` for which and why.
  deliveryIdentifier: "partial",
});
