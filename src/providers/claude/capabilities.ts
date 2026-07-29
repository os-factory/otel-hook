import type { ProviderCapabilities } from "../adapter.js";

/**
 * What this adapter can actually observe from Claude Code hooks.
 *
 * Every value here is confirmed against Claude Code 2.1.220 — the CLI's own
 * hook-input schemas for what a callback carries, and 4,999 real `usage` objects
 * for what the counters mean. docs/claude-code-usage-contract.md records the
 * observations; the summary:
 *
 * - `reportsCachedInput`/`reportsCacheCreation` are true because the payload
 *   schema *accepts* Anthropic's `message.usage` shape when a wrapping harness
 *   attaches it. No hook callback in the protocol carries a token counter, and
 *   this adapter never reads the transcript to find them.
 * - `cacheCreationAccounting` is `included-in-input` because `input_tokens` is
 *   the fresh portion only, so the adapter folds all three input buckets into one
 *   inclusive total (see `usage.ts`).
 * - `reportsReasoningOutput` and `reportsProviderTotal` are false as an
 *   **explicit exclusion, not an unknown**: 0 of 4,999 real usage objects carried
 *   any reasoning-token or total-token key. Anthropic bills thinking tokens
 *   inside `output_tokens` with nothing distinguishing them, and reports no grand
 *   total for a canonical total to agree or disagree with.
 *
 * `contextTokensBefore` is excluded on the same footing, and has no capability
 * flag of its own to say so: neither compaction callback reports a context size,
 * so there is no figure to carry across the `PreCompact`/`PostCompact` boundary.
 * `PreCompact` states the exclusion when a harness attaches one anyway
 * (`events.ts`), and `ADAPTER-NOTE-002` records it.
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
  // Tool, subagent, and prompt callbacks carry a replay-stable id, and so does
  // the once-per-prompt `Stop` (`stop_hook_active: false`). Session, compaction,
  // and continuation stops do not. See `./delivery.ts` for which and why.
  deliveryIdentifier: "partial",
});
