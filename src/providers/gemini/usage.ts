import { usageReportSchema, type UsageReport } from "../../model/usage.js";
import type { GeminiUsageMetadata } from "./schema.js";

/**
 * Map Gemini's `usageMetadata` onto a canonical {@link UsageReport}.
 *
 * `promptTokenCount` is inclusive of `cachedContentTokenCount` (a subset).
 * `candidatesTokenCount` and `thoughtsTokenCount` are reported as separate,
 * explicit counters by the Gemini API, so canonical `outputTokens` is their sum
 * (inclusive, per core usage semantics) and `reasoningOutputTokens` carries
 * `thoughtsTokenCount` unchanged. `totalTokenCount` is passed through as
 * `providerTotalTokens` and validated by `normalizeUsage`, never reconstructed by
 * this adapter. Gemini does not report a cache-creation counter, so that field
 * is always left absent. Any counter the provider did not report stays absent
 * here rather than being defaulted to zero.
 */
export const mapGeminiUsage = (usage: GeminiUsageMetadata | undefined): UsageReport | undefined => {
  if (usage === undefined) {
    return undefined;
  }
  const {
    promptTokenCount,
    cachedContentTokenCount,
    candidatesTokenCount,
    thoughtsTokenCount,
    totalTokenCount,
  } = usage;

  const reportsNothing =
    promptTokenCount === undefined &&
    cachedContentTokenCount === undefined &&
    candidatesTokenCount === undefined &&
    thoughtsTokenCount === undefined &&
    totalTokenCount === undefined;
  if (reportsNothing) {
    return undefined;
  }

  const hasOutput = candidatesTokenCount !== undefined || thoughtsTokenCount !== undefined;

  return usageReportSchema.parse({
    temporality: "delta",
    ...(promptTokenCount === undefined ? {} : { inputTokens: promptTokenCount }),
    ...(cachedContentTokenCount === undefined ? {} : { cachedInputTokens: cachedContentTokenCount }),
    ...(hasOutput
      ? { outputTokens: (candidatesTokenCount ?? 0) + (thoughtsTokenCount ?? 0) }
      : {}),
    ...(thoughtsTokenCount === undefined ? {} : { reasoningOutputTokens: thoughtsTokenCount }),
    ...(totalTokenCount === undefined ? {} : { providerTotalTokens: totalTokenCount }),
  });
};

/** A terminal Gemini usage signal is what completes a model invocation. */
export const isTerminalGeminiUsage = (usage: GeminiUsageMetadata | undefined): boolean =>
  mapGeminiUsage(usage) !== undefined;
