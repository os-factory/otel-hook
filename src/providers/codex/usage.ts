import type { UsageReport, UsageTemporality } from "../../model/usage.js";
import type { CodexUsage } from "./payload.js";

/**
 * Project a Codex usage snapshot onto a canonical usage report.
 *
 * Codex copies the Responses API usage verbatim, so `input_tokens` is the whole
 * prompt: `cached_input_tokens` (cache reads) and, from Codex 0.163,
 * `cache_write_input_tokens` (cache writes) are subsets of it, and
 * `reasoning_output_tokens` is a subset of `output_tokens`. That is the
 * canonical shape already (`cacheCreationAccounting: "included-in-input"`), the
 * same one Claude Code's disjoint buckets are folded into: no arithmetic here.
 * A Codex that reports no cache-write counter leaves the field absent, which
 * normalizes to zero with `not-reported`.
 */
export const codexUsageToReport = (
  usage: CodexUsage,
  temporality: UsageTemporality,
): UsageReport => ({
  temporality,
  ...(usage.input_tokens === undefined ? {} : { inputTokens: usage.input_tokens }),
  ...(usage.cached_input_tokens === undefined
    ? {}
    : { cachedInputTokens: usage.cached_input_tokens }),
  ...(usage.cache_write_input_tokens === undefined
    ? {}
    : {
        cacheCreationInputTokens: usage.cache_write_input_tokens,
        cacheCreationAccounting: "included-in-input" as const,
      }),
  ...(usage.output_tokens === undefined ? {} : { outputTokens: usage.output_tokens }),
  ...(usage.reasoning_output_tokens === undefined
    ? {}
    : { reasoningOutputTokens: usage.reasoning_output_tokens }),
  ...(usage.total_tokens === undefined ? {} : { providerTotalTokens: usage.total_tokens }),
});

export type CodexTokenCountObservation = {
  readonly totalTokenUsage?: CodexUsage;
  readonly lastTokenUsage?: CodexUsage;
};

/**
 * Prefer the cumulative session snapshot over a per-turn delta.
 *
 * Codex's rollout JSONL reports both a cumulative `total_token_usage` and a
 * per-turn `last_token_usage` on the same `token_count` event. The cumulative
 * figure is the authoritative running total (never sum repeats of it across
 * events); `last_token_usage` is only used, and only marked `delta`
 * explicitly, when no cumulative figure is present.
 */
export const codexTokenCountToReport = (
  observation: CodexTokenCountObservation,
): UsageReport | undefined => {
  if (observation.totalTokenUsage !== undefined) {
    return codexUsageToReport(observation.totalTokenUsage, "cumulative");
  }
  if (observation.lastTokenUsage !== undefined) {
    return codexUsageToReport(observation.lastTokenUsage, "delta");
  }
  return undefined;
};
