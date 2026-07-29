/**
 * Claude Code's usage contract, asserted against fixtures whose *shape* was
 * confirmed from real captures at 2.1.220.
 *
 * The other usage suite (`usage.test.ts`) unit-tests `normalizeClaudeUsage` with
 * hand-built inputs. This one replays whole payloads through the shipped adapter
 * and the real runtime, so a claim here covers detection, identity, privacy
 * screening, and the adapter's mapping — the path the CLI takes. Where the
 * contract says a counter does not exist, the assertion is that it stays absent
 * *and* that the exclusion is reported, because a silent zero and a declared
 * absence are indistinguishable downstream and only one of them is a fact.
 *
 * See docs/claude-code-usage-contract.md for what was observed and how.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { CanonicalEvent } from "../../../src/model/events.js";
import type { CanonicalUsage } from "../../../src/model/index.js";
import { createClaudeCodeAdapter } from "../../../src/providers/claude/index.js";
import { CLAUDE_EXCLUDED_USAGE_COUNTERS } from "../../../src/providers/claude/usage.js";
import type { HookIngestOutcome } from "../../../src/runtime/hook.js";
import { createTestHook } from "../../../src/testing/index.js";

const CONTRACTS_DIR = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "fixtures",
  "contracts",
  "claude-code",
);

const loadFixture = async (name: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(path.join(CONTRACTS_DIR, name), "utf8")) as Record<string, unknown>;

type Replay = {
  readonly outcome: HookIngestOutcome;
  readonly events: readonly CanonicalEvent[];
  /** Warnings the adapter reported for declining part of a payload it understood. */
  readonly adapterWarnings: readonly string[];
};

const replay = async (payload: unknown): Promise<Replay> => {
  const harness = createTestHook({ adapters: [createClaudeCodeAdapter()] });
  const outcome = await harness.hook.ingest({
    payload,
    transport: "hook-stdin",
    providerHint: "claude-code",
  });
  await harness.hook.flush();

  const adapterWarnings = harness.logger
    .records()
    .filter((record) => record.message === "adapter declined part of the payload it understood")
    .flatMap((record) => {
      const reported = record.fields?.["adapter.warnings"];
      return Array.isArray(reported) ? reported.map(String) : [];
    });

  return { outcome, events: outcome.events, adapterWarnings };
};

const usageOf = (events: readonly CanonicalEvent[], type: string): CanonicalUsage | undefined => {
  const event = events.find((candidate) => candidate.type === type);
  if (event === undefined || !("usage" in event)) {
    return undefined;
  }
  return event.usage;
};

/** Whichever end-edge the fixture produces, so one assertion can span fixtures. */
const anyUsage = (events: readonly CanonicalEvent[]): CanonicalUsage | undefined =>
  usageOf(events, "generation.end") ?? usageOf(events, "subagent.end");

describe("Claude Code usage contract: where every counter lives", () => {
  it("reads all four token buckets from the nested usage object", async () => {
    const { events } = await replay(await loadFixture("stop-usage-attached.json"));
    const usage = usageOf(events, "generation.end");
    expect(usage).toBeDefined();

    // usage.input_tokens is the *fresh* portion; the canonical inclusive total is
    // the fold of all three input buckets.
    expect(usage?.inputTokens).toBe(3 + 118_000 + 7_400);
    expect(usage?.cachedInputTokens).toBe(118_000);
    expect(usage?.cacheCreationInputTokens).toBe(7_400);
    expect(usage?.outputTokens).toBe(412);
    expect(usage?.cacheCreationAccounting).toBe("included-in-input");
    expect(usage?.temporality).toBe("delta");
    // The provider's own fresh figure survives the fold as a derived field.
    expect(usage?.uncachedInputTokens).toBe(3);
  });

  it("keeps fresh input, cache read, cache creation, output, and reasoning non-overlapping", async () => {
    for (const fixture of [
      "stop-usage-attached.json",
      "subagent-stop-cache-heavy.json",
      "stop-usage-ttl-split-only.json",
      "stop-usage-foreign-counters.json",
    ]) {
      const { events } = await replay(await loadFixture(fixture));
      const usage = anyUsage(events);
      expect(usage, fixture).toBeDefined();
      if (usage === undefined) {
        continue;
      }

      // Each subset is one of the addends of the total it is a subset of, so the
      // partition is exact rather than merely non-exceeding: nothing is counted
      // twice and nothing falls outside a bucket.
      expect(
        usage.uncachedInputTokens + usage.cachedInputTokens + usage.cacheCreationInputTokens,
        fixture,
      ).toBe(usage.inputTokens);
      expect(usage.reasoningOutputTokens, fixture).toBeLessThanOrEqual(usage.outputTokens);
      // Cache creation is included-in-input for this provider, so it is not added again.
      expect(usage.totalTokens, fixture).toBe(usage.inputTokens + usage.outputTokens);
    }
  });

  it("derives the fresh figure correctly when cache reads dominate by five orders of magnitude", async () => {
    const { events } = await replay(await loadFixture("subagent-stop-cache-heavy.json"));
    const usage = usageOf(events, "subagent.end");

    expect(usage?.uncachedInputTokens).toBe(2);
    expect(usage?.cachedInputTokens).toBe(713_000);
    expect(usage?.inputTokens).toBe(713_002);
    expect(usage?.cacheCreationInputTokens).toBe(0);
  });
});

describe("Claude Code usage contract: breakdowns are reconciled, never added", () => {
  it("does not add the cache-creation TTL split to the total it itemizes", async () => {
    const { outcome, events, adapterWarnings } = await replay(
      await loadFixture("stop-usage-attached.json"),
    );
    const usage = usageOf(events, "generation.end");

    // 1,400 + 6,000 == 7,400. Added, cache creation would read 14,800.
    expect(usage?.cacheCreationInputTokens).toBe(7_400);
    // An agreeing breakdown is not worth a word.
    expect(adapterWarnings).toEqual([]);
    expect(outcome.diagnostics.map((info) => info.code)).not.toContain("usage-invalid");
  });

  it("derives cache creation from the TTL split when only the split is stated", async () => {
    const { events } = await replay(await loadFixture("stop-usage-ttl-split-only.json"));
    const usage = usageOf(events, "generation.end");

    // 900 + 2,100, rather than defaulting to zero and losing the write cost.
    expect(usage?.cacheCreationInputTokens).toBe(3_000);
    expect(usage?.inputTokens).toBe(11 + 24_000 + 3_000);
    expect(usage?.uncachedInputTokens).toBe(11);
  });

  it("does not add per-iteration figures to the outer counters", async () => {
    const { events } = await replay(await loadFixture("stop-usage-attached.json"));
    const usage = usageOf(events, "generation.end");

    // The fixture's single iteration restates the outer counters exactly. Added,
    // every counter would double.
    expect(usage?.outputTokens).toBe(412);
    expect(usage?.cachedInputTokens).toBe(118_000);
    expect(usage?.inputTokens).toBe(125_403);
  });

  it("reports a breakdown that disagrees with its own total instead of picking silently", async () => {
    const base = await loadFixture("stop-usage-attached.json");
    const { events, adapterWarnings } = await replay({
      ...base,
      usage: {
        input_tokens: 3,
        output_tokens: 412,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 7_400,
        cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 2 },
        iterations: [{ type: "message", input_tokens: 999, output_tokens: 412 }],
      },
    });
    const usage = usageOf(events, "generation.end");

    // The explicit counter wins; the disagreeing breakdown is never added.
    expect(usage?.cacheCreationInputTokens).toBe(7_400);
    expect(usage?.inputTokens).toBe(3 + 100 + 7_400);
    expect(adapterWarnings.some((warning) => warning.includes("usage.cache_creation TTL buckets"))).toBe(
      true,
    );
    expect(
      adapterWarnings.some((warning) => warning.includes("usage.iterations[].input_tokens")),
    ).toBe(true);
  });
});

describe("Claude Code usage contract: declared exclusions", () => {
  it("declines a foreign provider total and reasoning counter, and names both", async () => {
    const { events, adapterWarnings } = await replay(
      await loadFixture("stop-usage-foreign-counters.json"),
    );
    const usage = usageOf(events, "generation.end");

    // The fixture states total_tokens: 620 and reasoning_output_tokens: 15.
    // Honouring either would make the declared capabilities lie.
    expect(usage?.providerTotalTokens).toBeUndefined();
    expect(usage?.providerTotalAgreement).toBe("unreported");
    expect(usage?.reasoningOutputTokens).toBe(0);
    // The rest of the same object is read normally.
    expect(usage?.inputTokens).toBe(500 + 300 + 20);
    expect(usage?.outputTokens).toBe(120);

    // Excluded, not silently dropped: the adapter names each field it declined.
    for (const excluded of Object.values(CLAUDE_EXCLUDED_USAGE_COUNTERS)) {
      expect(adapterWarnings.some((warning) => excluded.startsWith(warning.slice(0, 60)))).toBe(true);
    }
  });

  it("declares the exclusions up front rather than leaving them to be inferred", () => {
    const { capabilities } = createClaudeCodeAdapter();

    expect(capabilities.reportsReasoningOutput).toBe(false);
    expect(capabilities.reportsProviderTotal).toBe(false);
    // What the provider *does* report, when a harness attaches it.
    expect(capabilities.reportsCachedInput).toBe(true);
    expect(capabilities.reportsCacheCreation).toBe(true);
    expect(capabilities.cacheCreationAccounting).toBe("included-in-input");
    expect(capabilities.usageTemporality).toBe("delta");
  });

  it("still rejects an impossible usage shape outright rather than clamping it", async () => {
    const base = await loadFixture("stop-usage-attached.json");
    // cache_read exceeding the fold is impossible by construction, so provoke the
    // rejection the only way left: a negative counter the provider could never send.
    const { events, outcome } = await replay({
      ...base,
      usage: { input_tokens: -1, output_tokens: 5 },
    });

    // The payload fails schema validation as a whole; no usage is invented.
    expect(anyUsage(events)).toBeUndefined();
    expect(outcome.attribution).toBe("failed");
  });
});
