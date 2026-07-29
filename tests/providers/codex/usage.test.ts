import { describe, expect, it } from "vitest";

import { codexTokenCountToReport, codexUsageToReport } from "../../../src/providers/codex/usage.js";
import { createCodexAdapter } from "../../../src/providers/codex/index.js";
import { createTestHook } from "../../../src/testing/index.js";
import { loadHookFixture } from "./helpers.js";

const harness = () => createTestHook({ adapters: [createCodexAdapter()] });

describe("codex usage: unit conversion", () => {
  it("carries inclusive input/output and their subset counters through unchanged", () => {
    const report = codexUsageToReport(
      {
        input_tokens: 1000,
        cached_input_tokens: 400,
        output_tokens: 200,
        reasoning_output_tokens: 50,
        total_tokens: 1200,
      },
      "cumulative",
    );
    expect(report.temporality).toBe("cumulative");
    expect(report.inputTokens).toBe(1000);
    expect(report.cachedInputTokens).toBe(400);
    expect(report.outputTokens).toBe(200);
    expect(report.reasoningOutputTokens).toBe(50);
    expect(report.providerTotalTokens).toBe(1200);
    // Codex never reports a distinct cache-creation counter.
    expect(report.cacheCreationInputTokens).toBeUndefined();
  });

  it("prefers the cumulative total_token_usage over the per-turn last_token_usage", () => {
    const report = codexTokenCountToReport({
      totalTokenUsage: { input_tokens: 5000, output_tokens: 500 },
      lastTokenUsage: { input_tokens: 100, output_tokens: 20 },
    });
    expect(report?.temporality).toBe("cumulative");
    expect(report?.inputTokens).toBe(5000);
  });

  it("marks last_token_usage explicitly as a delta when no cumulative figure is present", () => {
    const report = codexTokenCountToReport({ lastTokenUsage: { input_tokens: 100, output_tokens: 20 } });
    expect(report?.temporality).toBe("delta");
    expect(report?.inputTokens).toBe(100);
  });

  it("returns undefined when neither figure is present", () => {
    expect(codexTokenCountToReport({})).toBeUndefined();
  });
});

describe("codex usage: end-to-end through the hook", () => {
  it("normalizes a cache-heavy session (cached tokens as a subset of input)", async () => {
    const { hook, sink } = harness();
    await hook.ingest({ payload: loadHookFixture("stop-cache-heavy.json"), transport: "hook-stdin" });

    const event = sink.events().find((candidate) => candidate.type === "generation.end");
    expect(event?.type === "generation.end" && event.usage?.inputTokens).toBe(200000);
    expect(event?.type === "generation.end" && event.usage?.cachedInputTokens).toBe(196000);
    expect(event?.type === "generation.end" && event.usage?.uncachedInputTokens).toBe(4000);
  });

  it("normalizes a reasoning-heavy session (reasoning as a subset of output)", async () => {
    const { hook, sink } = harness();
    await hook.ingest({ payload: loadHookFixture("stop-reasoning-heavy.json"), transport: "hook-stdin" });

    const event = sink.events().find((candidate) => candidate.type === "generation.end");
    expect(event?.type === "generation.end" && event.usage?.outputTokens).toBe(40000);
    expect(event?.type === "generation.end" && event.usage?.reasoningOutputTokens).toBe(38000);
    expect(event?.type === "generation.end" && event.usage?.totalTokens).toBe(43000);
  });

  it("derives a delta from successive cumulative Stop reports for the same generation", async () => {
    const { hook } = harness();
    const base = loadHookFixture("stop.json") as Record<string, unknown>;

    const first = await hook.ingest({ payload: base, transport: "hook-stdin" });
    const second = await hook.ingest({
      payload: {
        ...base,
        usage: {
          input_tokens: 20000,
          cached_input_tokens: 15000,
          output_tokens: 2500,
          reasoning_output_tokens: 900,
          total_tokens: 22500,
        },
        occurred_at: 1_700_000_004_000,
      },
      transport: "hook-stdin",
    });

    expect(first.usageObservations[0]?.delta.inputTokens).toBe(12000);
    expect(second.usageObservations[0]?.delta.inputTokens).toBe(8000);
    expect(second.usageObservations[0]?.resetDetected).toBe(false);
  });

  it("reports a counter regression as a reset rather than a negative delta", async () => {
    const { hook } = harness();
    const base = loadHookFixture("stop.json") as Record<string, unknown>;

    await hook.ingest({ payload: base, transport: "hook-stdin" });
    const regressed = await hook.ingest({
      payload: {
        ...base,
        usage: {
          input_tokens: 500,
          cached_input_tokens: 100,
          output_tokens: 50,
          reasoning_output_tokens: 0,
          total_tokens: 550,
        },
        occurred_at: 1_700_000_004_000,
      },
      transport: "hook-stdin",
    });

    expect(regressed.usageObservations[0]?.resetDetected).toBe(true);
    expect(regressed.usageObservations[0]?.delta.inputTokens).toBe(500);
  });

  it("is replay-safe: re-ingesting the same cumulative Stop yields a zero delta", async () => {
    const { hook } = harness();
    const payload = loadHookFixture("stop.json");

    await hook.ingest({ payload, transport: "hook-stdin" });
    const replay = await hook.ingest({ payload, transport: "hook-stdin" });

    expect(replay.usageObservations[0]?.delta.totalTokens).toBe(0);
    expect(replay.usageObservations[0]?.resetDetected).toBe(false);
  });

  it("diffs a new turn against the previous turn, because Codex's counter is session-wide", async () => {
    const { hook } = harness();
    const base = loadHookFixture("stop.json") as Record<string, unknown>;

    // A real second turn: a *different* turn_id carrying the session's advanced
    // running total. Keying the baseline by turn_id would find no predecessor and
    // emit the whole 20000-token snapshot again, billing turn 1 twice.
    const first = await hook.ingest({ payload: base, transport: "hook-stdin" });
    const second = await hook.ingest({
      payload: {
        ...base,
        turn_id: "turn-0002",
        usage: {
          input_tokens: 20000,
          cached_input_tokens: 15000,
          output_tokens: 2500,
          reasoning_output_tokens: 900,
          total_tokens: 22500,
        },
        occurred_at: 1_700_000_004_000,
      },
      transport: "hook-stdin",
    });

    expect(first.usageObservations[0]?.delta.totalTokens).toBe(13500);
    expect(second.usageObservations[0]?.delta.totalTokens).toBe(9000);
    expect(second.usageObservations[0]?.resetDetected).toBe(false);
    // The observation is still attributed to the turn that reported it; only the
    // baseline it was diffed against is session-scoped.
    expect(second.usageObservations[0]?.scope).toBe("generation");
    expect(second.usageObservations[0]?.scopeKey).toBe("turn-0002");
  });

  it("declares the session-lifetime series it actually accumulates", () => {
    const adapter = createCodexAdapter();
    expect(adapter.capabilities.usageTemporality).toBe("cumulative");
    expect(adapter.capabilities.cumulativeUsageSeries).toBe("session-lifetime");
  });

  it("keeps a subagent's smaller snapshot off the parent session's series", async () => {
    const { hook } = harness();
    // The session is already at 13500 when a subagent reports its own 4800. On the
    // session series that would read as a reset; on its own series it is a first
    // observation.
    await hook.ingest({ payload: loadHookFixture("stop.json"), transport: "hook-stdin" });
    const outcome = await hook.ingest({
      payload: loadHookFixture("subagent-stop.json"),
      transport: "hook-stdin",
    });

    expect(outcome.usageObservations[0]?.scope).toBe("subagent");
    expect(outcome.usageObservations[0]?.delta.totalTokens).toBe(4800);
    expect(outcome.usageObservations[0]?.resetDetected).toBe(false);
  });

  it("never sums two cumulative snapshots: the second event still reports its own total, not an addition", async () => {
    const { hook, sink } = harness();
    const base = loadHookFixture("stop.json") as Record<string, unknown>;
    await hook.ingest({ payload: base, transport: "hook-stdin" });
    await hook.ingest({
      payload: {
        ...base,
        usage: { input_tokens: 20000, output_tokens: 2500, total_tokens: 22500 },
        occurred_at: 1_700_000_004_000,
      },
      transport: "hook-stdin",
    });

    const events = sink.events().filter((event) => event.type === "generation.end");
    expect(events[1]?.type === "generation.end" && events[1].usage?.inputTokens).toBe(20000);
  });
});
