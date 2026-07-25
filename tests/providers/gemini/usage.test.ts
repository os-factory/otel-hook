import { describe, expect, it } from "vitest";

import { normalizeUsage } from "../../../src/model/usage.js";
import { mapGeminiUsage } from "../../../src/providers/gemini/usage.js";

describe("mapGeminiUsage", () => {
  it("returns undefined when usageMetadata is absent", () => {
    expect(mapGeminiUsage(undefined)).toBeUndefined();
  });

  it("returns undefined when usageMetadata reports no counters at all", () => {
    expect(mapGeminiUsage({})).toBeUndefined();
  });

  it("treats promptTokenCount as inclusive of cachedContentTokenCount", () => {
    const report = mapGeminiUsage({
      promptTokenCount: 100,
      cachedContentTokenCount: 40,
      candidatesTokenCount: 10,
    });
    expect(report?.inputTokens).toBe(100);
    expect(report?.cachedInputTokens).toBe(40);

    const normalized = normalizeUsage(report);
    expect(normalized.status).toBe("ok");
    if (normalized.status === "ok") {
      expect(normalized.usage.uncachedInputTokens).toBe(60);
    }
  });

  it("keeps candidatesTokenCount and thoughtsTokenCount explicit, summed into inclusive outputTokens", () => {
    const report = mapGeminiUsage({ candidatesTokenCount: 30, thoughtsTokenCount: 12 });
    expect(report?.outputTokens).toBe(42);
    expect(report?.reasoningOutputTokens).toBe(12);

    const normalized = normalizeUsage(report);
    expect(normalized.status).toBe("ok");
    if (normalized.status === "ok") {
      expect(normalized.usage.outputTokens).toBe(42);
      expect(normalized.usage.reasoningOutputTokens).toBe(12);
    }
  });

  it("leaves missing cache fields absent rather than defaulting them to zero in the report", () => {
    const report = mapGeminiUsage({ promptTokenCount: 100, candidatesTokenCount: 10 });
    expect(report).not.toHaveProperty("cachedInputTokens");
    expect(report?.cacheCreationInputTokens).toBeUndefined();
    expect(report?.cacheCreationAccounting).toBeUndefined();
  });

  it("never reports cache-creation tokens: normalization pins the accounting to not-reported", () => {
    const report = mapGeminiUsage({ promptTokenCount: 100, candidatesTokenCount: 10 });
    const normalized = normalizeUsage(report);
    expect(normalized.status).toBe("ok");
    if (normalized.status === "ok") {
      expect(normalized.usage.cacheCreationInputTokens).toBe(0);
      expect(normalized.usage.cacheCreationAccounting).toBe("not-reported");
    }
  });

  it("passes totalTokenCount through as providerTotalTokens and lets normalizeUsage validate it", () => {
    const agrees = mapGeminiUsage({ promptTokenCount: 100, candidatesTokenCount: 10, totalTokenCount: 110 });
    const agreesResult = normalizeUsage(agrees);
    expect(agreesResult.status).toBe("ok");
    if (agreesResult.status === "ok") {
      expect(agreesResult.usage.providerTotalAgreement).toBe("agrees");
    }

    const disagrees = mapGeminiUsage({ promptTokenCount: 100, candidatesTokenCount: 10, totalTokenCount: 5000 });
    const disagreesResult = normalizeUsage(disagrees);
    expect(disagreesResult.status).toBe("ok");
    if (disagreesResult.status === "ok") {
      expect(disagreesResult.usage.providerTotalAgreement).toBe("disagrees");
      expect(disagreesResult.usage.providerTotalTokens).toBe(5000);
      expect(disagreesResult.usage.totalTokens).toBe(110);
    }
  });

  it("rejects a malformed report where cached tokens exceed the inclusive prompt total", () => {
    const report = mapGeminiUsage({ promptTokenCount: 10, cachedContentTokenCount: 999 });
    const normalized = normalizeUsage(report);
    expect(normalized.status).toBe("invalid");
  });
});
