import { normalizeUsage, type CanonicalUsage } from "../../model/index.js";
import type { ClaudeUsage } from "./schema.js";

export type ClaudeUsageNormalization = {
  readonly usage?: CanonicalUsage;
  readonly warnings: readonly string[];
};

/**
 * Counters this adapter deliberately does not read.
 *
 * Both are absent from Claude Code's usage shape — 0 of 4,999 real usage objects
 * carried either (docs/claude-code-usage-contract.md, finding 5) — and both have
 * a home in the canonical model, which is exactly why reading a
 * harness-supplied one would be wrong: `providerTotalAgreement` would start
 * reporting `agrees`/`disagrees` for a provider that reports no total, and
 * `reasoningOutputTokens` would carry a figure `reportsReasoningOutput: false`
 * says does not exist. A consumer's ability to tell "not reported" from "zero"
 * depends on the capability declaration staying true.
 *
 * So the field is excluded and *said out loud*, rather than silently dropped.
 */
export const CLAUDE_EXCLUDED_USAGE_COUNTERS = Object.freeze({
  total_tokens:
    "usage.total_tokens is outside Claude Code's usage contract (capability reportsProviderTotal=false): " +
    "it is not read, so providerTotalAgreement stays \"unreported\"",
  reasoning_output_tokens:
    "usage.reasoning_output_tokens is outside Claude Code's usage contract (capability " +
    "reportsReasoningOutput=false): Anthropic bills thinking tokens inside output_tokens with no separate " +
    "counter, so it is not read and reasoningOutputTokens stays 0",
});

/** The four counters `usage.iterations[]` itemizes, and the outer fields they must match. */
const ITERATION_COUNTERS = [
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
] as const;

/**
 * Cache-creation tokens split by TTL, or `undefined` when the split is absent.
 *
 * The two sub-buckets summed to `cache_creation_input_tokens` in every capture,
 * so this is a *breakdown* to reconcile against, never an addend.
 */
const ttlSplitTotal = (raw: ClaudeUsage): number | undefined => {
  const split = raw.cache_creation;
  if (split === undefined) {
    return undefined;
  }
  return (split.ephemeral_5m_input_tokens ?? 0) + (split.ephemeral_1h_input_tokens ?? 0);
};

/**
 * Settle on one cache-creation figure from the two places it can be stated.
 *
 * The explicit counter wins when both are present: it is the billed total, and
 * preferring a sum of parts over a stated whole would let a future third TTL
 * bucket silently deflate it. A disagreement is reported rather than resolved
 * quietly, because only one of the two numbers can be the billing story.
 */
const resolveCacheCreationTokens = (raw: ClaudeUsage, warnings: string[]): number => {
  const declared = raw.cache_creation_input_tokens;
  const split = ttlSplitTotal(raw);
  if (declared === undefined) {
    // Only the TTL split was attached. Deriving the total is the whole point of
    // accepting the sub-object: the tokens were reported, just itemized.
    return split ?? 0;
  }
  if (split !== undefined && split !== declared) {
    warnings.push(
      `usage.cache_creation TTL buckets sum to ${String(split)} but ` +
        `usage.cache_creation_input_tokens reports ${String(declared)}; the explicit counter is used and the ` +
        `buckets are never added to it`,
    );
  }
  return declared;
};

/**
 * Reconcile `usage.iterations[]` against the outer counters without adding it.
 *
 * A multi-request turn itemizes the same tokens per model request, and the
 * per-iteration figures summed to the outer ones exactly in every capture. Adding
 * a breakdown to its own total is the archetypal double-count — it would double
 * every counter of every turn — so the sums are *checked* and a disagreement is
 * reported, which is the only reading under which either number could be wrong.
 */
const auditIterations = (
  raw: ClaudeUsage,
  cacheCreationInputTokens: number,
  warnings: string[],
): void => {
  const iterations = raw.iterations;
  if (iterations === undefined || iterations.length === 0) {
    return;
  }
  const outer: Readonly<Record<(typeof ITERATION_COUNTERS)[number], number>> = {
    input_tokens: raw.input_tokens,
    output_tokens: raw.output_tokens,
    cache_read_input_tokens: raw.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: cacheCreationInputTokens,
  };
  for (const counter of ITERATION_COUNTERS) {
    const summed = iterations.reduce((total, iteration) => total + (iteration[counter] ?? 0), 0);
    if (summed !== outer[counter]) {
      warnings.push(
        `usage.iterations[].${counter} sums to ${String(summed)} but usage.${counter} reports ` +
          `${String(outer[counter])}; the outer counter is used and per-iteration figures are never added to it`,
      );
    }
  }
};

const auditExcludedCounters = (raw: ClaudeUsage, warnings: string[]): void => {
  if (raw.total_tokens !== undefined) {
    warnings.push(CLAUDE_EXCLUDED_USAGE_COUNTERS.total_tokens);
  }
  if (raw.reasoning_output_tokens !== undefined) {
    warnings.push(CLAUDE_EXCLUDED_USAGE_COUNTERS.reasoning_output_tokens);
  }
};

/**
 * `normalizeUsage` notes when a caller declared a cache-creation accounting mode
 * on a snapshot with zero cache-creation tokens. That note is aimed at a caller
 * choosing the mode per observation; this adapter's mode is a fixed property of
 * the provider, so on any turn that wrote nothing to cache the note restates the
 * design rather than reporting anything. It would fire on most turns and bury the
 * warnings that do mean something, so it is dropped here — by prefix, so a note
 * this adapter has not considered still reaches the caller.
 */
const ACCOUNTING_RETAINED_NOTE_PREFIX = "cacheCreationAccounting=";

const forwardableNotes = (notes: readonly string[]): readonly string[] =>
  notes.filter((note) => !note.startsWith(ACCOUNTING_RETAINED_NOTE_PREFIX));

/**
 * Normalize Anthropic's on-wire usage shape into canonical usage.
 *
 * `input_tokens` is the *fresh* portion of the prompt only: cache reads and cache
 * writes are separate, additive buckets. Confirmed against real captures rather
 * than assumed — across 4,999 usage objects `input_tokens` stayed within
 * 1..5,656 while `cache_read_input_tokens` reached 713,543
 * (docs/claude-code-usage-contract.md, finding 2). The canonical model instead
 * wants an inclusive `inputTokens`, so this folds all three into one total and
 * marks cache creation `included-in-input` — `uncachedInputTokens` then falls out
 * to exactly Anthropic's own `input_tokens`.
 *
 * The fold is what makes the canonical buckets **non-overlapping by
 * construction**: each subset is one of the addends of the total it is a subset
 * of, so no subset can exceed its total and no bucket is counted twice. That
 * holds structurally, not by a range check a provider change could invalidate.
 * The two places tokens are *itemized* rather than reported — the cache-creation
 * TTL split and `iterations[]` — are reconciled against the totals and never
 * added, which is where a double-count would otherwise come from within a single
 * callback. Double-counting *across* callbacks is the delivery layer's job; see
 * `delivery.ts`.
 *
 * Each usage snapshot corresponds to a single turn, subagent invocation, or
 * compaction — never a running session total — so it is always reported as a
 * `delta` observation.
 */
export const normalizeClaudeUsage = (raw: ClaudeUsage | undefined): ClaudeUsageNormalization => {
  if (raw === undefined) {
    return { warnings: [] };
  }

  const warnings: string[] = [];
  const cachedInputTokens = raw.cache_read_input_tokens ?? 0;
  const cacheCreationInputTokens = resolveCacheCreationTokens(raw, warnings);
  auditIterations(raw, cacheCreationInputTokens, warnings);
  auditExcludedCounters(raw, warnings);

  const result = normalizeUsage({
    temporality: "delta",
    inputTokens: raw.input_tokens + cachedInputTokens + cacheCreationInputTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    cacheCreationAccounting: "included-in-input",
    outputTokens: raw.output_tokens,
  });

  if (result.status === "invalid") {
    return { warnings: [...warnings, ...result.issues.map((issue) => issue.message)] };
  }
  return { usage: result.usage, warnings: [...warnings, ...forwardableNotes(result.notes)] };
};
