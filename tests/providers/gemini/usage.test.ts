import { describe, expect, it } from "vitest";

import { cumulativeToDelta, normalizeUsage } from "../../../src/model/usage.js";
import { hasGeminiUsageSnapshot, mapGeminiUsage } from "../../../src/providers/gemini/usage.js";

describe("mapGeminiUsage", () => {
  it("returns undefined when usageMetadata is absent", () => {
    expect(mapGeminiUsage(undefined)).toBeUndefined();
    expect(hasGeminiUsageSnapshot(undefined)).toBe(false);
  });

  it("returns undefined when usageMetadata reports no counters at all", () => {
    expect(mapGeminiUsage({})).toBeUndefined();
    expect(hasGeminiUsageSnapshot({})).toBe(false);
  });

  it("reports cumulative temporality: a chunk's counts are a snapshot, not that chunk's increment", () => {
    const report = mapGeminiUsage({
      promptTokenCount: 512,
      candidatesTokenCount: 40,
      totalTokenCount: 552,
    });
    expect(report?.temporality).toBe("cumulative");
    expect(hasGeminiUsageSnapshot({ totalTokenCount: 552 })).toBe(true);
  });

  it("maps the three counters the hook actually receives", () => {
    // HookTranslatorGenAIv1.toHookLLMResponse rebuilds usageMetadata as exactly
    // these three, so this is the shape every real AfterModel payload carries.
    const report = mapGeminiUsage({
      promptTokenCount: 512,
      candidatesTokenCount: 136,
      totalTokenCount: 648,
    });
    expect(report?.inputTokens).toBe(512);
    expect(report?.outputTokens).toBe(136);
    expect(report?.providerTotalTokens).toBe(648);
    // Neither counter is reported to hooks, so neither may be invented as zero:
    // "not reported" and "zero cache reads" have to stay distinguishable.
    expect(report).not.toHaveProperty("cachedInputTokens");
    expect(report).not.toHaveProperty("reasoningOutputTokens");

    const normalized = normalizeUsage(report);
    expect(normalized.status).toBe("ok");
    if (normalized.status === "ok") {
      expect(normalized.usage.providerTotalAgreement).toBe("agrees");
      expect(normalized.usage.uncachedInputTokens).toBe(512);
    }
  });

  it("diffs successive snapshots so a multi-chunk stream is billed once, not once per chunk", () => {
    const first = normalizeUsage(
      mapGeminiUsage({ promptTokenCount: 512, candidatesTokenCount: 40, totalTokenCount: 552 }),
    );
    const second = normalizeUsage(
      mapGeminiUsage({ promptTokenCount: 512, candidatesTokenCount: 136, totalTokenCount: 648 }),
    );
    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    if (first.status !== "ok" || second.status !== "ok") {
      return;
    }

    const delta = cumulativeToDelta(first.usage, second.usage);
    // The prompt is charged by the first snapshot and never again; only the
    // output the later chunk added is new.
    expect(delta.usage.inputTokens).toBe(0);
    expect(delta.usage.outputTokens).toBe(96);
    expect(delta.resetDetected).toBe(false);
    expect(first.usage.inputTokens + delta.usage.inputTokens).toBe(512);
  });

  it("yields a zero delta for a redelivered snapshot rather than a second charge", () => {
    const snapshot = normalizeUsage(
      mapGeminiUsage({ promptTokenCount: 512, candidatesTokenCount: 136, totalTokenCount: 648 }),
    );
    expect(snapshot.status).toBe("ok");
    if (snapshot.status !== "ok") {
      return;
    }

    const delta = cumulativeToDelta(snapshot.usage, snapshot.usage);
    expect(delta.usage.inputTokens).toBe(0);
    expect(delta.usage.outputTokens).toBe(0);
    expect(delta.resetDetected).toBe(false);
  });

  it("still honours cached and thought counters, which the current hook translator strips", () => {
    // Not a shape any current payload has — the translator drops both counters
    // before a hook runs, which is why the adapter declares neither capability.
    // The mapping stays because the translator is versioned, and silently
    // discarding a counter a later version starts sending would understate every
    // cache read and every reasoning token.
    const report = mapGeminiUsage({
      promptTokenCount: 100,
      cachedContentTokenCount: 40,
      candidatesTokenCount: 30,
      thoughtsTokenCount: 12,
    });
    expect(report?.inputTokens).toBe(100);
    expect(report?.cachedInputTokens).toBe(40);
    // Gemini reports thoughts separately; canonical output is inclusive of them.
    expect(report?.outputTokens).toBe(42);
    expect(report?.reasoningOutputTokens).toBe(12);

    const normalized = normalizeUsage(report);
    expect(normalized.status).toBe("ok");
    if (normalized.status === "ok") {
      expect(normalized.usage.uncachedInputTokens).toBe(60);
      expect(normalized.usage.reasoningOutputTokens).toBeLessThanOrEqual(
        normalized.usage.outputTokens,
      );
    }
  });

  it("never reports cache-creation tokens: normalization pins the accounting to not-reported", () => {
    const report = mapGeminiUsage({ promptTokenCount: 100, candidatesTokenCount: 10 });
    expect(report?.cacheCreationInputTokens).toBeUndefined();
    expect(report?.cacheCreationAccounting).toBeUndefined();

    const normalized = normalizeUsage(report);
    expect(normalized.status).toBe("ok");
    if (normalized.status === "ok") {
      expect(normalized.usage.cacheCreationInputTokens).toBe(0);
      expect(normalized.usage.cacheCreationAccounting).toBe("not-reported");
    }
  });

  it("passes totalTokenCount through as providerTotalTokens and lets normalizeUsage validate it", () => {
    const disagrees = mapGeminiUsage({
      promptTokenCount: 100,
      candidatesTokenCount: 10,
      totalTokenCount: 5000,
    });
    const result = normalizeUsage(disagrees);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.usage.providerTotalAgreement).toBe("disagrees");
      expect(result.usage.providerTotalTokens).toBe(5000);
      expect(result.usage.totalTokens).toBe(110);
    }
  });

  it("rejects a malformed report where cached tokens exceed the inclusive prompt total", () => {
    const report = mapGeminiUsage({ promptTokenCount: 10, cachedContentTokenCount: 999 });
    expect(normalizeUsage(report).status).toBe("invalid");
  });
});
