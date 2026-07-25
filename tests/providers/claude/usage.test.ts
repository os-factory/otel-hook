import { describe, expect, it } from "vitest";

import { normalizeClaudeUsage } from "../../../src/providers/claude/usage.js";

describe("Claude Code adapter: usage normalization", () => {
  it("returns nothing when no usage was reported", () => {
    const result = normalizeClaudeUsage(undefined);
    expect(result.usage).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it("folds cache read and cache creation into an inclusive inputTokens total", () => {
    const result = normalizeClaudeUsage({
      input_tokens: 1_000,
      output_tokens: 250,
      cache_read_input_tokens: 9_000,
      cache_creation_input_tokens: 500,
    });
    expect(result.warnings).toEqual([]);
    expect(result.usage).toBeDefined();
    const usage = result.usage!;
    expect(usage.temporality).toBe("delta");
    expect(usage.inputTokens).toBe(1_000 + 9_000 + 500);
    expect(usage.cachedInputTokens).toBe(9_000);
    expect(usage.cacheCreationInputTokens).toBe(500);
    expect(usage.cacheCreationAccounting).toBe("included-in-input");
    // Anthropic's own "fresh" input figure must fall out of the inclusive total.
    expect(usage.uncachedInputTokens).toBe(1_000);
    expect(usage.totalTokens).toBe(usage.inputTokens + usage.outputTokens);
    expect(usage.reasoningOutputTokens).toBe(0);
    expect(usage.providerTotalTokens).toBeUndefined();
    expect(usage.providerTotalAgreement).toBe("unreported");
  });

  it("handles a cache-heavy turn where almost nothing is fresh input", () => {
    const result = normalizeClaudeUsage({
      input_tokens: 12,
      output_tokens: 3_000,
      cache_read_input_tokens: 180_000,
      cache_creation_input_tokens: 0,
    });
    const usage = result.usage!;
    expect(usage.uncachedInputTokens).toBe(12);
    expect(usage.cachedInputTokens).toBe(180_000);
    expect(usage.inputTokens).toBe(180_012);
  });

  it("treats missing cache fields as zero, never as unreported", () => {
    const result = normalizeClaudeUsage({ input_tokens: 500, output_tokens: 100 });
    const usage = result.usage!;
    expect(usage.cachedInputTokens).toBe(0);
    expect(usage.cacheCreationInputTokens).toBe(0);
    expect(usage.uncachedInputTokens).toBe(500);
    expect(usage.totalTokens).toBe(600);
  });
});
