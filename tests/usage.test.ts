import { describe, expect, it } from "vitest";

import {
  addUsage,
  canonicalUsageSchema,
  cumulativeToDelta,
  EMPTY_DELTA_USAGE,
  normalizeUsage,
  normalizeUsageOrThrow,
  toReport,
  UsageNormalizationError,
  type CanonicalUsage,
} from "../src/index.js";
import { createSeededRandom } from "./helpers/random.js";

const ok = (report: unknown): CanonicalUsage => {
  const result = normalizeUsage(report);
  if (result.status !== "ok") {
    throw new Error(`expected ok, got issues: ${JSON.stringify(result.issues)}`);
  }
  return result.usage;
};

describe("usage normalization", () => {
  it("treats input and output as inclusive totals and derives subsets", () => {
    const usage = ok({
      temporality: "delta",
      inputTokens: 1000,
      cachedInputTokens: 400,
      outputTokens: 200,
      reasoningOutputTokens: 50,
    });

    expect(usage.uncachedInputTokens).toBe(600);
    expect(usage.totalTokens).toBe(1200);
    expect(usage.cacheCreationAccounting).toBe("not-reported");
    expect(usage.providerTotalAgreement).toBe("unreported");
  });

  it("adds disjoint cache-creation tokens to the canonical total", () => {
    const usage = ok({
      temporality: "delta",
      inputTokens: 100,
      cacheCreationInputTokens: 30,
      cacheCreationAccounting: "disjoint-from-input",
      outputTokens: 10,
    });

    expect(usage.totalTokens).toBe(140);
    expect(usage.uncachedInputTokens).toBe(100);
  });

  it("keeps included cache-creation tokens inside the input total", () => {
    const usage = ok({
      temporality: "delta",
      inputTokens: 100,
      cachedInputTokens: 20,
      cacheCreationInputTokens: 30,
      cacheCreationAccounting: "included-in-input",
      outputTokens: 10,
    });

    expect(usage.totalTokens).toBe(110);
    expect(usage.uncachedInputTokens).toBe(50);
  });

  it("defaults absent counters to zero", () => {
    const usage = ok({ temporality: "cumulative" });
    expect(usage).toMatchObject({
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
      cacheCreationAccounting: "not-reported",
    });
    expect(usage.providerTotalTokens).toBeUndefined();
  });

  it("rejects a cached subset larger than its inclusive input", () => {
    const result = normalizeUsage({ temporality: "delta", inputTokens: 10, cachedInputTokens: 11 });
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.issues.map((issue) => issue.code)).toContain("cached-exceeds-input");
    }
  });

  it("rejects a reasoning subset larger than its inclusive output", () => {
    const result = normalizeUsage({
      temporality: "delta",
      outputTokens: 5,
      reasoningOutputTokens: 6,
    });
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.issues.map((issue) => issue.code)).toContain("reasoning-exceeds-output");
    }
  });

  it("rejects included cache creation that overflows the input total", () => {
    const result = normalizeUsage({
      temporality: "delta",
      inputTokens: 100,
      cachedInputTokens: 80,
      cacheCreationInputTokens: 40,
      cacheCreationAccounting: "included-in-input",
    });
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.issues.map((issue) => issue.code)).toContain("cache-creation-exceeds-input");
    }
  });

  it("refuses to guess accounting when cache-creation tokens are reported", () => {
    const result = normalizeUsage({ temporality: "delta", cacheCreationInputTokens: 10 });
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.issues.map((issue) => issue.code)).toContain(
        "cache-creation-accounting-missing",
      );
    }
  });

  it("rejects negative and fractional counters", () => {
    expect(normalizeUsage({ temporality: "delta", inputTokens: -1 }).status).toBe("invalid");
    expect(normalizeUsage({ temporality: "delta", inputTokens: 1.5 }).status).toBe("invalid");
    expect(normalizeUsage({ temporality: "delta", inputTokens: Number.NaN }).status).toBe("invalid");
  });

  it("rejects an unknown temporality and unknown fields", () => {
    expect(normalizeUsage({ temporality: "gauge" }).status).toBe("invalid");
    expect(normalizeUsage({ temporality: "delta", surprise: 1 }).status).toBe("invalid");
  });

  it("preserves a disagreeing provider total instead of editing either number", () => {
    const result = normalizeUsage({
      temporality: "delta",
      inputTokens: 10,
      outputTokens: 5,
      providerTotalTokens: 99,
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.usage.totalTokens).toBe(15);
      expect(result.usage.providerTotalTokens).toBe(99);
      expect(result.usage.providerTotalAgreement).toBe("disagrees");
      expect(result.notes.join(" ")).toContain("disagrees");
    }
  });

  it("marks an agreeing provider total", () => {
    const usage = ok({
      temporality: "delta",
      inputTokens: 10,
      outputTokens: 5,
      providerTotalTokens: 15,
    });
    expect(usage.providerTotalAgreement).toBe("agrees");
  });
});

describe("canonical usage schema invariants", () => {
  it("rejects a hand-built object with inconsistent derived fields", () => {
    const valid = ok({ temporality: "delta", inputTokens: 10, cachedInputTokens: 4 });
    expect(canonicalUsageSchema.safeParse(valid).success).toBe(true);
    expect(
      canonicalUsageSchema.safeParse({ ...valid, uncachedInputTokens: 999 }).success,
    ).toBe(false);
    expect(canonicalUsageSchema.safeParse({ ...valid, totalTokens: 999 }).success).toBe(false);
    expect(
      canonicalUsageSchema.safeParse({ ...valid, providerTotalAgreement: "agrees" }).success,
    ).toBe(false);
  });

  it("rejects cache-creation tokens under not-reported accounting", () => {
    const valid = ok({ temporality: "delta", inputTokens: 10 });
    expect(
      canonicalUsageSchema.safeParse({
        ...valid,
        cacheCreationInputTokens: 5,
        totalTokens: 10,
      }).success,
    ).toBe(false);
  });
});

describe("cumulative to delta", () => {
  const cumulative = (input: number, output: number): CanonicalUsage =>
    ok({ temporality: "cumulative", inputTokens: input, outputTokens: output });

  it("diffs two snapshots", () => {
    const result = cumulativeToDelta(cumulative(100, 10), cumulative(180, 30));
    expect(result.resetDetected).toBe(false);
    expect(result.usage.temporality).toBe("delta");
    expect(result.usage.inputTokens).toBe(80);
    expect(result.usage.outputTokens).toBe(20);
  });

  it("is replay-safe: re-processing the same snapshot yields a zero delta", () => {
    const snapshot = cumulative(100, 10);
    const result = cumulativeToDelta(snapshot, snapshot);
    expect(result.usage.totalTokens).toBe(0);
    expect(result.resetDetected).toBe(false);
  });

  it("reports a reset instead of a negative delta", () => {
    const result = cumulativeToDelta(cumulative(100, 10), cumulative(20, 2));
    expect(result.resetDetected).toBe(true);
    expect(result.usage.inputTokens).toBe(20);
    expect(result.usage.outputTokens).toBe(2);
  });

  it("refuses to diff delta observations", () => {
    const delta = ok({ temporality: "delta", inputTokens: 1 });
    expect(() => cumulativeToDelta(delta, cumulative(2, 0))).toThrow(UsageNormalizationError);
  });

  it("refuses to diff across differing cache-creation accounting", () => {
    const previous = ok({
      temporality: "cumulative",
      inputTokens: 100,
      cacheCreationInputTokens: 10,
      cacheCreationAccounting: "included-in-input",
    });
    const current = ok({
      temporality: "cumulative",
      inputTokens: 200,
      cacheCreationInputTokens: 20,
      cacheCreationAccounting: "disjoint-from-input",
    });
    expect(() => cumulativeToDelta(previous, current)).toThrow(UsageNormalizationError);
  });
});

describe("usage aggregation", () => {
  it("sums delta observations", () => {
    const a = ok({ temporality: "delta", inputTokens: 10, cachedInputTokens: 2, outputTokens: 3 });
    const b = ok({ temporality: "delta", inputTokens: 5, cachedInputTokens: 1, outputTokens: 1 });
    const sum = addUsage(a, b);
    expect(sum.inputTokens).toBe(15);
    expect(sum.cachedInputTokens).toBe(3);
    expect(sum.outputTokens).toBe(4);
    expect(sum.totalTokens).toBe(19);
  });

  it("refuses to sum cumulative observations", () => {
    const cumulative = ok({ temporality: "cumulative", inputTokens: 1 });
    expect(() => addUsage(cumulative, cumulative)).toThrow(UsageNormalizationError);
  });

  it("has an empty delta identity element", () => {
    const usage = ok({ temporality: "delta", inputTokens: 7, outputTokens: 2 });
    expect(addUsage(usage, EMPTY_DELTA_USAGE)).toEqual(usage);
  });
});

describe("usage properties", () => {
  const random = createSeededRandom(0x5eed);

  it("keeps invariants for 500 random valid reports", () => {
    for (let iteration = 0; iteration < 500; iteration += 1) {
      const inputTokens = random.int(0, 100_000);
      const cachedInputTokens = random.int(0, inputTokens);
      const accounting = random.pick(["not-reported", "included-in-input", "disjoint-from-input"] as const);
      const headroom = inputTokens - cachedInputTokens;
      const cacheCreationInputTokens =
        accounting === "not-reported"
          ? 0
          : accounting === "included-in-input"
            ? random.int(0, headroom)
            : random.int(0, 10_000);
      const outputTokens = random.int(0, 50_000);
      const reasoningOutputTokens = random.int(0, outputTokens);

      const usage = ok({
        temporality: random.pick(["delta", "cumulative"] as const),
        inputTokens,
        cachedInputTokens,
        cacheCreationInputTokens,
        cacheCreationAccounting: accounting,
        outputTokens,
        reasoningOutputTokens,
      });

      expect(usage.cachedInputTokens).toBeLessThanOrEqual(usage.inputTokens);
      expect(usage.reasoningOutputTokens).toBeLessThanOrEqual(usage.outputTokens);
      expect(usage.uncachedInputTokens).toBeGreaterThanOrEqual(0);
      expect(
        usage.uncachedInputTokens +
          usage.cachedInputTokens +
          (accounting === "included-in-input" ? usage.cacheCreationInputTokens : 0),
      ).toBe(usage.inputTokens);
      expect(usage.totalTokens).toBe(
        usage.inputTokens +
          (accounting === "disjoint-from-input" ? usage.cacheCreationInputTokens : 0) +
          usage.outputTokens,
      );
      // Round-tripping through the reported shape is lossless.
      expect(normalizeUsageOrThrow(toReport(usage))).toEqual({
        ...usage,
        temporality: usage.temporality,
      });
      expect(canonicalUsageSchema.safeParse(usage).success).toBe(true);
    }
  });

  it("never produces a negative delta from an increasing random series", () => {
    for (let iteration = 0; iteration < 200; iteration += 1) {
      const firstInput = random.int(0, 10_000);
      const firstOutput = random.int(0, 10_000);
      const previous = ok({
        temporality: "cumulative",
        inputTokens: firstInput,
        outputTokens: firstOutput,
      });
      const current = ok({
        temporality: "cumulative",
        inputTokens: firstInput + random.int(0, 5_000),
        outputTokens: firstOutput + random.int(0, 5_000),
      });
      const { usage, resetDetected } = cumulativeToDelta(previous, current);
      expect(resetDetected).toBe(false);
      expect(usage.inputTokens).toBeGreaterThanOrEqual(0);
      expect(usage.outputTokens).toBeGreaterThanOrEqual(0);
      expect(usage.inputTokens).toBe(current.inputTokens - previous.inputTokens);
    }
  });
});
