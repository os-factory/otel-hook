import { usageReportSchema, type UsageReport } from "../../model/usage.js";
import type { GeminiUsageMetadata } from "./schema.js";

/**
 * Map Gemini's `usageMetadata` onto a canonical {@link UsageReport}.
 *
 * ## Why `cumulative`
 *
 * `AfterModel` fires per streaming chunk, and a chunk's `usageMetadata` is a
 * snapshot of the response so far, not that chunk's own increment. Two places in
 * the Gemini CLI state this by construction: `loggingContentGenerator`'s
 * `loggingStreamWrapper` keeps `lastUsageMetadata` across the stream and reports
 * that single value as the call's usage, and `chatRecordingService`
 * `recordMessageTokens` *replaces* the recorded token counts rather than adding
 * to them. Neither sums, so a later snapshot must already contain the earlier
 * one.
 *
 * Reporting these as `delta` would therefore add every snapshot together: a
 * stream that carries usage on three chunks would bill roughly three times the
 * true prompt. Declaring `cumulative` hands the composition to the runtime,
 * which diffs each snapshot against the baseline stored at
 * `usage:<sessionId>:generation:<generationId>` — so N usage-bearing chunks
 * contribute the final total exactly once, and a redelivered chunk yields a zero
 * delta rather than a second charge.
 *
 * This holds whether the API emits usage on one chunk or on many: a lone
 * snapshot with no baseline is emitted as its own first delta, which is the same
 * number `delta` would have produced.
 *
 * ## Counters
 *
 * `promptTokenCount` is inclusive of `cachedContentTokenCount` (a subset).
 * `candidatesTokenCount` and `thoughtsTokenCount` are separate, explicit
 * counters, so canonical `outputTokens` is their sum (inclusive, per core usage
 * semantics) and `reasoningOutputTokens` carries `thoughtsTokenCount` unchanged.
 * `totalTokenCount` is passed through as `providerTotalTokens` and validated by
 * `normalizeUsage`, never reconstructed here. Gemini reports no cache-creation
 * counter, so that field is always left absent. Any counter the provider did not
 * report stays absent rather than being defaulted to zero.
 *
 * Today the CLI's hook translator strips `cachedContentTokenCount` and
 * `thoughtsTokenCount` before a hook sees them (see
 * {@link GeminiUsageMetadata}), so on current payloads the cache and reasoning
 * branches below are dormant. They are kept because the translator is versioned
 * and dropping a counter the CLI started sending is the worse failure.
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
    temporality: "cumulative",
    ...(promptTokenCount === undefined ? {} : { inputTokens: promptTokenCount }),
    ...(cachedContentTokenCount === undefined ? {} : { cachedInputTokens: cachedContentTokenCount }),
    ...(hasOutput
      ? { outputTokens: (candidatesTokenCount ?? 0) + (thoughtsTokenCount ?? 0) }
      : {}),
    ...(thoughtsTokenCount === undefined ? {} : { reasoningOutputTokens: thoughtsTokenCount }),
    ...(totalTokenCount === undefined ? {} : { providerTotalTokens: totalTokenCount }),
  });
};

/**
 * Whether a chunk carries a usage snapshot at all.
 *
 * Most chunks of a stream do not. Those carry no billable observation, so the
 * adapter ignores them rather than closing a generation with no usage.
 */
export const hasGeminiUsageSnapshot = (usage: GeminiUsageMetadata | undefined): boolean =>
  mapGeminiUsage(usage) !== undefined;
