import type { UsageReport, UsageTemporality } from "../../model/usage.js";
import type { CodexUsage } from "./payload.js";

/**
 * Project a Codex usage snapshot onto a canonical usage report.
 *
 * Codex does not report a distinct cache-*creation* counter (only cache
 * *reads*, `cached_input_tokens`), so `cacheCreationInputTokens` is always
 * omitted here and the adapter declares `cacheCreationAccounting:
 * "not-reported"` in its capabilities. `cached_input_tokens` and
 * `reasoning_output_tokens` are always subsets of the inclusive
 * `input_tokens` / `output_tokens` totals, matching Codex's own accounting.
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
