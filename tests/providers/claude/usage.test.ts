import { describe, expect, it } from "vitest";

import {
  CLAUDE_EXCLUDED_USAGE_COUNTERS,
  normalizeClaudeUsage,
} from "../../../src/providers/claude/usage.js";

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

  it("cannot produce overlapping buckets, whatever the provider reports", () => {
    // The fold makes each canonical subset one of the addends of its own total, so
    // the partition is exact for every input rather than for the cases a test
    // happened to pick. Swept over ratios that would break a range-check
    // implementation: cache-dominated, write-dominated, all-fresh, all-zero.
    const shapes = [
      { input_tokens: 0, output_tokens: 0 },
      { input_tokens: 1, output_tokens: 1 },
      { input_tokens: 2, output_tokens: 3_000, cache_read_input_tokens: 713_543 },
      { input_tokens: 5_656, output_tokens: 1, cache_creation_input_tokens: 607_589 },
      {
        input_tokens: 12,
        output_tokens: 99,
        cache_read_input_tokens: 1,
        cache_creation_input_tokens: 999_999,
      },
    ] as const;

    for (const shape of shapes) {
      const usage = normalizeClaudeUsage(shape).usage;
      expect(usage, JSON.stringify(shape)).toBeDefined();
      if (usage === undefined) {
        continue;
      }
      expect(
        usage.uncachedInputTokens + usage.cachedInputTokens + usage.cacheCreationInputTokens,
      ).toBe(usage.inputTokens);
      expect(usage.uncachedInputTokens).toBe(shape.input_tokens);
      expect(usage.reasoningOutputTokens).toBeLessThanOrEqual(usage.outputTokens);
      expect(usage.totalTokens).toBe(usage.inputTokens + usage.outputTokens);
    }
  });
});

describe("Claude Code adapter: cache-creation TTL split", () => {
  it("derives the total from the TTL buckets when only they are stated", () => {
    const result = normalizeClaudeUsage({
      input_tokens: 10,
      output_tokens: 20,
      cache_creation: { ephemeral_5m_input_tokens: 900, ephemeral_1h_input_tokens: 2_100 },
    });
    expect(result.warnings).toEqual([]);
    expect(result.usage?.cacheCreationInputTokens).toBe(3_000);
    expect(result.usage?.inputTokens).toBe(10 + 3_000);
  });

  it("verifies an agreeing split without adding it", () => {
    const result = normalizeClaudeUsage({
      input_tokens: 3,
      output_tokens: 412,
      cache_creation_input_tokens: 7_400,
      cache_creation: { ephemeral_5m_input_tokens: 1_400, ephemeral_1h_input_tokens: 6_000 },
    });
    expect(result.warnings).toEqual([]);
    // Added, this would read 14,800.
    expect(result.usage?.cacheCreationInputTokens).toBe(7_400);
  });

  it("keeps the explicit counter and reports a disagreeing split", () => {
    const result = normalizeClaudeUsage({
      input_tokens: 3,
      output_tokens: 412,
      cache_creation_input_tokens: 7_400,
      cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 2 },
    });
    expect(result.usage?.cacheCreationInputTokens).toBe(7_400);
    expect(result.warnings.join(" ")).toContain("usage.cache_creation TTL buckets sum to 3");
    expect(result.warnings.join(" ")).toContain("never added");
  });

  it("treats a half-stated split as the sum of what is there", () => {
    const result = normalizeClaudeUsage({
      input_tokens: 1,
      output_tokens: 1,
      cache_creation: { ephemeral_1h_input_tokens: 500 },
    });
    expect(result.usage?.cacheCreationInputTokens).toBe(500);
  });
});

describe("Claude Code adapter: usage.iterations is a breakdown", () => {
  it("never adds per-iteration figures to the outer counters", () => {
    const result = normalizeClaudeUsage({
      input_tokens: 40,
      output_tokens: 60,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 100,
      iterations: [
        { input_tokens: 30, output_tokens: 20, cache_read_input_tokens: 900, cache_creation_input_tokens: 100 },
        { input_tokens: 10, output_tokens: 40 },
      ],
    });
    expect(result.warnings).toEqual([]);
    expect(result.usage?.inputTokens).toBe(40 + 900 + 100);
    expect(result.usage?.outputTokens).toBe(60);
  });

  it("reports each counter whose iterations disagree with the outer total", () => {
    const result = normalizeClaudeUsage({
      input_tokens: 40,
      output_tokens: 60,
      iterations: [{ input_tokens: 999, output_tokens: 1 }],
    });
    expect(result.usage?.inputTokens).toBe(40);
    expect(result.usage?.outputTokens).toBe(60);
    expect(result.warnings.join(" ")).toContain("usage.iterations[].input_tokens sums to 999");
    expect(result.warnings.join(" ")).toContain("usage.iterations[].output_tokens sums to 1");
  });

  it("ignores an empty iterations array", () => {
    const result = normalizeClaudeUsage({ input_tokens: 1, output_tokens: 2, iterations: [] });
    expect(result.warnings).toEqual([]);
    expect(result.usage?.inputTokens).toBe(1);
  });
});

describe("Claude Code adapter: excluded counters", () => {
  it("declines a harness-supplied provider total and says so", () => {
    const result = normalizeClaudeUsage({
      input_tokens: 500,
      output_tokens: 120,
      cache_read_input_tokens: 300,
      cache_creation_input_tokens: 20,
      total_tokens: 620,
    });
    // Absorbing it would make reportsProviderTotal=false a lie.
    expect(result.usage?.providerTotalTokens).toBeUndefined();
    expect(result.usage?.providerTotalAgreement).toBe("unreported");
    expect(result.warnings).toContain(CLAUDE_EXCLUDED_USAGE_COUNTERS.total_tokens);
  });

  it("declines a harness-supplied reasoning counter and says so", () => {
    const result = normalizeClaudeUsage({
      input_tokens: 500,
      output_tokens: 120,
      reasoning_output_tokens: 15,
    });
    expect(result.usage?.reasoningOutputTokens).toBe(0);
    expect(result.warnings).toContain(CLAUDE_EXCLUDED_USAGE_COUNTERS.reasoning_output_tokens);
  });

  it("stays silent when neither excluded counter is present", () => {
    const result = normalizeClaudeUsage({ input_tokens: 500, output_tokens: 120 });
    expect(result.warnings).toEqual([]);
  });
});
