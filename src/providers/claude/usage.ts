import { normalizeUsage, type CanonicalUsage } from "../../model/index.js";
import type { ClaudeUsage } from "./schema.js";

export type ClaudeUsageNormalization = {
  readonly usage?: CanonicalUsage;
  readonly warnings: readonly string[];
};

/**
 * Normalize Anthropic's on-wire usage shape into canonical usage.
 *
 * The Anthropic Messages API reports `input_tokens` as the *fresh* portion of
 * the prompt only: cache reads and cache writes are separate, additive
 * buckets. The canonical model instead wants an inclusive `inputTokens`, so
 * this folds all three into one total and marks cache creation
 * `included-in-input` — `uncachedInputTokens` then falls out to exactly
 * Anthropic's own `input_tokens`, and no bucket is double-counted.
 *
 * Each usage snapshot corresponds to a single turn, subagent invocation, or
 * compaction — never a running session total — so it is always reported as a
 * `delta` observation.
 */
export const normalizeClaudeUsage = (raw: ClaudeUsage | undefined): ClaudeUsageNormalization => {
  if (raw === undefined) {
    return { warnings: [] };
  }

  const cachedInputTokens = raw.cache_read_input_tokens ?? 0;
  const cacheCreationInputTokens = raw.cache_creation_input_tokens ?? 0;

  const result = normalizeUsage({
    temporality: "delta",
    inputTokens: raw.input_tokens + cachedInputTokens + cacheCreationInputTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    cacheCreationAccounting: "included-in-input",
    outputTokens: raw.output_tokens,
  });

  if (result.status === "invalid") {
    return { warnings: result.issues.map((issue) => issue.message) };
  }
  return { usage: result.usage, warnings: result.notes };
};
