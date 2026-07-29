import { normalizeUsage, type CanonicalUsage } from "../../model/index.js";

export type CursorTokenCounters = {
  readonly input_tokens?: number | undefined;
  readonly output_tokens?: number | undefined;
  readonly cache_read_tokens?: number | undefined;
  readonly cache_write_tokens?: number | undefined;
};

export type CursorUsageNormalization = {
  readonly usage?: CanonicalUsage;
  readonly warnings: readonly string[];
};

/**
 * Normalize Cursor's token counters into canonical usage.
 *
 * These four counters appear on `afterAgentResponse` and `stop` in the IDE
 * captures and are absent from Cursor's published reference, so the mapping is
 * deliberately narrow:
 *
 * - `input_tokens` is read as the canonical *inclusive* input total and
 *   `cache_read_tokens` as a subset of it. `CURSOR_USAGE_INCLUSIVITY_NOTE` in
 *   `./payload.ts` records the captured evidence for that reading, and the fact
 *   that Cursor does not document it.
 * - A payload where `cache_read_tokens` exceeds `input_tokens` contradicts the
 *   inclusive reading. Rather than clamp — which would invent a billing story —
 *   the cache breakdown is dropped, the input and output totals are kept, and a
 *   warning names the contradiction.
 * - `cache_write_tokens` is **not** reported at all. Canonical usage requires an
 *   explicit `cacheCreationAccounting` whenever `cacheCreationInputTokens` is
 *   non-zero, and whether Cursor bills cache writes inside or beside
 *   `input_tokens` is exactly what no source establishes: the reference does not
 *   mention the field, and every captured sample reports 0, so there is not even
 *   an arithmetic hint. `included-in-input` would understate the total and
 *   `disjoint-from-input` would inflate it, so a non-zero value produces a
 *   warning naming the dropped field rather than either guess.
 *
 * Each snapshot covers one generation, never a running session total, so it is
 * always reported as a `delta` observation.
 */
export const normalizeCursorUsage = (raw: CursorTokenCounters): CursorUsageNormalization => {
  const inputTokens = raw.input_tokens;
  const outputTokens = raw.output_tokens;
  const cacheReadTokens = raw.cache_read_tokens;
  const cacheWriteTokens = raw.cache_write_tokens;

  const dropped: string[] =
    cacheWriteTokens === undefined || cacheWriteTokens === 0
      ? []
      : [
          `cursor reported cache_write_tokens (${String(cacheWriteTokens)}), whose accounting relative to ` +
            "input_tokens is undocumented, so it was not folded into canonical usage",
        ];

  if (inputTokens === undefined && outputTokens === undefined && cacheReadTokens === undefined) {
    return { warnings: dropped };
  }

  const warnings: string[] = [...dropped];
  const contradictsInclusive =
    cacheReadTokens !== undefined && inputTokens !== undefined && cacheReadTokens > inputTokens;
  if (contradictsInclusive) {
    warnings.push(
      `cursor reported cache_read_tokens (${String(cacheReadTokens)}) above input_tokens ` +
        `(${String(inputTokens)}); the cache breakdown was dropped rather than reinterpreted`,
    );
  }

  const result = normalizeUsage({
    temporality: "delta",
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cacheReadTokens === undefined || contradictsInclusive
      ? {}
      : { cachedInputTokens: cacheReadTokens }),
  });

  if (result.status === "invalid") {
    return { warnings: [...warnings, ...result.issues.map((issue) => issue.message)] };
  }
  return { usage: result.usage, warnings: [...warnings, ...result.notes] };
};
