/**
 * Codex and Gemini CLI semantic coverage.
 *
 * Scope note, deliberately narrower than the claude-code and cursor suites: this
 * file establishes what the **shipped** `codex` and `gemini-cli` adapters emit for
 * fixtures in each provider's real hook shape, and makes **no equality claim
 * against `opentelemetry-hooks==0.14.0`** for either provider.
 *
 * That restraint is empirical, not cautious hand-waving:
 *
 *  - For Gemini, the pinned reference does not model the provider's own event
 *    vocabulary at all — it rewrites `BeforeTool` into Claude Code's
 *    `PreToolUse` (DIVERGENCE-007). Asserting "parity" against a reference that
 *    relabels the provider would be asserting agreement with a mistranslation.
 *  - For Codex, the pinned reference attaches `gen_ai.client.version` read from
 *    whichever `codex` binary happens to be on the *host's* PATH rather than from
 *    the payload (DIVERGENCE-008). That value is host-dependent (absent on a
 *    machine without the CLI installed, and wrong for any replayed payload), so no
 *    reproducible parity assertion can be written on Codex provenance.
 *
 * Where the reference *is* consulted here, it is to pin the divergence by name,
 * never to claim agreement.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createCodexAdapter } from "../../src/providers/codex/adapter.js";
import { createGeminiCliAdapter } from "../../src/providers/gemini/adapter.js";
import { findDivergence } from "./divergence-manifest.js";
import { runThroughRealAdapter } from "./harness/real-adapters.js";
import { isPythonReferenceAvailable, runPythonSession } from "./harness/python-spans.js";

const PARITY_DIR = path.resolve(import.meta.dirname, "..", "..", "fixtures", "parity");

const loadSession = async (
  provider: string,
  files: readonly string[],
): Promise<unknown[]> =>
  Promise.all(
    files.map(
      async (file) =>
        JSON.parse(await readFile(path.join(PARITY_DIR, provider, file), "utf8")) as unknown,
    ),
  );

const CODEX_FILES = ["user-prompt-submit.json", "stop.json"] as const;
const GEMINI_FILES = ["before-tool.json", "after-model.json"] as const;

/**
 * One session, in wall-clock order, whose usage-bearing callbacks are successive
 * points on a single session-wide cumulative curve:
 *
 *   Stop turn 1      total_tokens 13500
 *   Stop turn 2      total_tokens 22500   (+9000)
 *   SubagentStop     total_tokens  4800   (a *separate* series: the subagent's own)
 *   PostCompact      total_tokens 25300   (+2800 on the session curve)
 *
 * The subagent snapshot is deliberately interleaved and deliberately smaller than
 * the session total at that instant, because that is the shape that catches a
 * baseline keyed too broadly.
 */
const CODEX_SESSION_FILES = [
  "session-start.json",
  "user-prompt-submit.json",
  "stop.json",
  "stop-turn-2.json",
  "subagent-stop.json",
  "post-compact.json",
] as const;

const availability = await isPythonReferenceAvailable();

describe("codex: shipped adapter semantics", () => {
  it("attributes both fixtures and maps them onto the lifecycle it declares", async () => {
    const run = await runThroughRealAdapter("codex", await loadSession("codex", CODEX_FILES));

    expect(run.attributions).toEqual(["attributed", "attributed"]);
    expect(run.diagnosticCodes).toEqual([]);
    expect(run.events.map((event) => event.type)).toEqual(["prompt.submitted", "generation.end"]);
    // Codex has no dependable session end, so the adapter must not claim one.
    expect(createCodexAdapter().capabilities.lifecycleEvents).not.toContain("session.end");
    expect(run.events.some((event) => event.type === "session.end")).toBe(false);
  });

  it("reports cumulative usage as cumulative, with reasoning tokens as an output subset", async () => {
    const run = await runThroughRealAdapter("codex", await loadSession("codex", CODEX_FILES));
    const generationEnd = run.events.find((event) => event.type === "generation.end");
    const usage = generationEnd?.type === "generation.end" ? generationEnd.usage : undefined;

    expect(usage).toMatchObject({
      // The adapter declares cumulative temporality and reports it as such rather
      // than silently presenting a session total as a per-turn delta.
      temporality: "cumulative",
      inputTokens: 12_000,
      cachedInputTokens: 8_000,
      outputTokens: 1_500,
      reasoningOutputTokens: 400,
      totalTokens: 13_500,
      providerTotalTokens: 13_500,
      providerTotalAgreement: "agrees",
    });
    // Cache reads are a subset of the inclusive input total, so the fresh portion
    // is derivable rather than guessed.
    expect(usage?.uncachedInputTokens).toBe(4_000);
    // Reasoning output is a subset of output, never an additional bucket.
    expect(usage?.reasoningOutputTokens).toBeLessThanOrEqual(usage?.outputTokens ?? 0);
    expect(createCodexAdapter().capabilities.usageTemporality).toBe("cumulative");
    expect(createCodexAdapter().capabilities.reportsReasoningOutput).toBe(true);
  });

  it("converts the cumulative snapshot into a delta without double-counting a repeat", async () => {
    const payloads = await loadSession("codex", CODEX_FILES);
    // The same Stop payload delivered twice: a cumulative counter that has not
    // advanced must produce a zero delta, not a second full snapshot.
    const run = await runThroughRealAdapter("codex", [...payloads, payloads[1]]);

    const observations = run.outcomes.flatMap((outcome) => outcome.usageObservations);
    expect(observations).toHaveLength(2);
    expect(observations[0]?.reportedTemporality).toBe("cumulative");
    expect(observations[0]?.delta.inputTokens).toBe(12_000);
    expect(observations[1]?.delta.inputTokens).toBe(0);
    expect(observations[1]?.delta.outputTokens).toBe(0);
    expect(observations[1]?.resetDetected).toBe(false);
  });

  it("reports a provider version only when the payload states one", async () => {
    const run = await runThroughRealAdapter("codex", await loadSession("codex", CODEX_FILES));
    // Neither fixture carries `codex_version`, so provenance carries none. The
    // adapter never reaches for an installed binary to fill the gap — see this
    // file's header for why that matters for Codex parity specifically.
    for (const event of run.events) {
      expect(event.provenance.providerVersion).toBeUndefined();
    }
  });

  it("diffs successive turns against each other, not against a per-turn baseline", async () => {
    const run = await runThroughRealAdapter("codex", await loadSession("codex", CODEX_SESSION_FILES));
    expect(run.diagnosticCodes).toEqual([]);

    const observations = run.outcomes.flatMap((outcome) => outcome.usageObservations);
    const generations = observations.filter((observation) => observation.scope === "generation");

    // Two Stop callbacks, each carrying the *session's* running total under a
    // different turn_id. The second must report the 8000-token difference in
    // input, not re-count the whole 20000-token snapshot.
    expect(generations).toHaveLength(2);
    expect(generations[0]?.delta.inputTokens).toBe(12_000);
    expect(generations[1]?.delta.inputTokens).toBe(8_000);
    expect(generations[1]?.delta.outputTokens).toBe(1_000);
    expect(generations[1]?.resetDetected).toBe(false);

    // The whole point: summing the derived deltas reproduces the session's final
    // cumulative total exactly once. A per-turn baseline would total 36000.
    const sessionSeries = observations.filter((observation) => observation.scope !== "subagent");
    const summed = sessionSeries.reduce((total, observation) => total + observation.delta.totalTokens, 0);
    expect(summed).toBe(25_300);
  });

  it("keeps a compaction snapshot on the same session series as the turns", async () => {
    const run = await runThroughRealAdapter("codex", await loadSession("codex", CODEX_SESSION_FILES));

    const observations = run.outcomes.flatMap((outcome) => outcome.usageObservations);
    const compaction = observations.find((observation) => observation.scope === "session");

    // PostCompact reports total_tokens 25300 against the turn-2 snapshot of
    // 22500. Had compaction kept its own baseline it would have emitted the full
    // 25300 as a first delta, double-counting the entire session.
    expect(compaction?.delta.totalTokens).toBe(2_800);
    expect(compaction?.delta.inputTokens).toBe(2_600);
    expect(compaction?.resetDetected).toBe(false);
  });

  it("gives a subagent its own baseline series rather than the parent session's", async () => {
    const run = await runThroughRealAdapter("codex", await loadSession("codex", CODEX_SESSION_FILES));

    const observations = run.outcomes.flatMap((outcome) => outcome.usageObservations);
    const subagent = observations.find((observation) => observation.scope === "subagent");

    // The subagent's 4800 total is far below the session's 22500 at that instant.
    // Diffed against the session curve it would look like a reset; on its own
    // series it is simply that subagent's first and only observation.
    expect(subagent?.delta.totalTokens).toBe(4_800);
    expect(subagent?.resetDetected).toBe(false);
    expect(subagent?.scopeKey).not.toBe("sess-parity-codex-001");
  });

  it("reports a rewound session as one flagged reset, never as a negative delta", async () => {
    const payloads = await loadSession("codex", CODEX_SESSION_FILES);
    // The whole session delivered a second time from the top. A cumulative series
    // that goes backwards is genuinely ambiguous — Codex reuses a session id after
    // a `/clear`, so this is indistinguishable from a real restart — and the
    // contract is to say so rather than to guess.
    const run = await runThroughRealAdapter("codex", [...payloads, ...payloads]);

    const observations = run.outcomes.flatMap((outcome) => outcome.usageObservations);
    for (const observation of observations) {
      expect(observation.delta.inputTokens).toBeGreaterThanOrEqual(0);
      expect(observation.delta.outputTokens).toBeGreaterThanOrEqual(0);
      expect(observation.delta.totalTokens).toBeGreaterThanOrEqual(0);
      expect(observation.delta.cachedInputTokens).toBeLessThanOrEqual(observation.delta.inputTokens);
      expect(observation.delta.reasoningOutputTokens).toBeLessThanOrEqual(observation.delta.outputTokens);
    }

    // Exactly one observation is flagged: the first callback of the replayed half,
    // where the session total dropped from 25300 back to 13500. Every later
    // callback resumes diffing normally against the restarted series.
    const reset = observations.filter((observation) => observation.resetDetected);
    expect(reset).toHaveLength(1);
    expect(reset[0]?.delta.totalTokens).toBe(13_500);

    // The replay is accounted as a second run of the same series rather than as
    // 25300 tokens appearing from nowhere on top of the first: the flagged
    // observation restates the snapshot, and the unflagged ones still only ever
    // report differences.
    const unflagged = observations
      .filter((observation) => observation.scope !== "subagent" && !observation.resetDetected)
      .reduce((total, observation) => total + observation.delta.totalTokens, 0);
    expect(unflagged).toBe(25_300 + (22_500 - 13_500) + (25_300 - 22_500));
  });

  it("takes the client version from the payload, which is what makes a replay reproducible", async () => {
    const run = await runThroughRealAdapter("codex", await loadSession("codex", CODEX_SESSION_FILES));

    const sessionStart = run.events.find((event) => event.type === "session.start");
    // `codex_version` is the field Codex's own payload carries, and the only
    // source consulted. `ProviderContext` hands adapters no subprocess or
    // filesystem handle, so a host binary is not reachable even by accident.
    expect(sessionStart?.type === "session.start" ? sessionStart.agentVersion : undefined).toBe(
      "0.42.0-fixture",
    );
    expect(sessionStart?.provenance.providerVersion).toBe("0.42.0-fixture");

    // Callbacks that omit the field report no version rather than inheriting one
    // from a sibling callback or from the environment.
    const stop = run.events.find((event) => event.type === "generation.end");
    expect(stop?.provenance.providerVersion).toBeUndefined();
  });

  it("keeps the raw path and prompt out of every event", async () => {
    const run = await runThroughRealAdapter("codex", await loadSession("codex", CODEX_FILES));
    const serialized = JSON.stringify(run.events);

    expect(serialized).not.toContain("/workspace/fixture-repo");
    expect(serialized).not.toContain("Summarize the synthetic fixture directory layout.");
    const prompt = run.events.find((event) => event.type === "prompt.submitted");
    expect(prompt?.type === "prompt.submitted" ? prompt.content?.disclosure : undefined).toBe("omitted");
  });
});

describe.skipIf(!availability.available)(
  "codex: the pinned reference reads the client version off the host PATH (DIVERGENCE-008)",
  () => {
    it("ignores the payload's codex_version and reports the host binary's instead", async () => {
      const divergence = findDivergence("DIVERGENCE-008");
      const payloads = await loadSession("codex", ["session-start.json"]);
      const result = await runPythonSession("codex", payloads);
      expect(result.available).toBe(true);
      if (!result.available) {
        return;
      }

      const [span] = result.spans;
      const reported = span?.attributes["gen_ai.client.version"];

      // The assertion is deliberately negative, because the positive value is not
      // reproducible: on a host with the CLI installed this is that binary's
      // version string, and on a host without it the attribute is absent
      // altogether. What is stable on every machine is that it is *not* the
      // version the payload stated — `_detect_client_version` never reads
      // `codex_version`, so the payload's own evidence cannot win.
      expect(reported).not.toBe("0.42.0-fixture");
      if (typeof reported === "string") {
        expect(reported).not.toContain("fixture");
      }

      // Our side reads the payload and nothing else, so the same bytes replay to
      // the same version anywhere.
      const run = await runThroughRealAdapter("codex", payloads);
      expect(run.events[0]?.provenance.providerVersion).toBe("0.42.0-fixture");
      expect(divergence.dimension).toBe("lifecycle");
    });
  },
);

describe("gemini-cli: shipped adapter semantics", () => {
  it("attributes both fixtures and preserves the provider's own event names", async () => {
    const run = await runThroughRealAdapter("gemini-cli", await loadSession("gemini-cli", GEMINI_FILES));

    expect(run.attributions).toEqual(["attributed", "attributed"]);
    expect(run.diagnosticCodes).toEqual([]);
    expect(run.events.map((event) => event.type)).toEqual(["tool.start", "generation.end"]);
    // The canonical type is provider-neutral; the provider's own name survives
    // verbatim in provenance instead of being translated.
    expect(run.events.map((event) => event.provenance.sourceEventName)).toEqual([
      "BeforeTool",
      "AfterModel",
    ]);
  });

  it("treats Gemini thought tokens as a subset of output, not an extra bucket", async () => {
    const run = await runThroughRealAdapter("gemini-cli", await loadSession("gemini-cli", GEMINI_FILES));
    const generationEnd = run.events.find((event) => event.type === "generation.end");
    const usage = generationEnd?.type === "generation.end" ? generationEnd.usage : undefined;

    expect(usage).toMatchObject({
      temporality: "delta",
      inputTokens: 512,
      cachedInputTokens: 128,
      // candidatesTokenCount (96) + thoughtsTokenCount (40): Gemini reports
      // thoughts separately, and the canonical model folds them into output with
      // the thought count retained as the reasoning subset.
      outputTokens: 136,
      reasoningOutputTokens: 40,
      providerTotalTokens: 648,
      providerTotalAgreement: "agrees",
    });
    expect(usage?.uncachedInputTokens).toBe(384);
    expect(createGeminiCliAdapter().capabilities.reportsReasoningOutput).toBe(true);
  });

  it("omits tool input and response text, and never exports the raw path", async () => {
    const run = await runThroughRealAdapter("gemini-cli", await loadSession("gemini-cli", GEMINI_FILES));
    const serialized = JSON.stringify(run.events);

    expect(serialized).not.toContain("/workspace/fixture-repo");
    expect(serialized).not.toContain("src/retry.ts");
    expect(serialized).not.toContain("exponential backoff");
    const toolStart = run.events.find((event) => event.type === "tool.start");
    expect(toolStart?.type === "tool.start" ? toolStart.input?.disclosure : undefined).toBe("omitted");
    expect(toolStart?.type === "tool.start" ? toolStart.toolName : undefined).toBe("read_file");
    expect(toolStart?.type === "tool.start" ? toolStart.toolKind : undefined).toBe("read");
  });
});

if (!availability.available) {
  console.warn(
    `[parity] skipping the gemini event-vocabulary divergence check: pinned opentelemetry-hooks reference unavailable (${
      availability.reason ?? "unknown reason"
    })`,
  );
}

describe.skipIf(!availability.available)(
  "gemini-cli: the pinned reference rewrites the provider's event vocabulary (DIVERGENCE-007)",
  () => {
    it("renames BeforeTool to Claude Code's PreToolUse, which is why no parity is claimed here", async () => {
      const divergence = findDivergence("DIVERGENCE-007");
      const payloads = await loadSession("gemini-cli", ["before-tool.json"]);
      const result = await runPythonSession("gemini", payloads);
      expect(result.available).toBe(true);
      if (!result.available) {
        return;
      }

      const [span] = result.spans;
      expect(span?.attributes["gen_ai.client.hook.event"]).toBe("PreToolUse");
      expect(span?.attributes["gen_ai.client.hook.original_event"]).toBe("BeforeTool");
      expect(span?.attributes["gen_ai.client.hook.provider_adapter"]).toBe("gemini");
      // And it copies the raw path verbatim, as DIVERGENCE-005 already documents
      // for Claude Code — the behaviour is not provider-specific.
      expect(span?.attributes["gen_ai.client.cwd"]).toBe("/workspace/fixture-repo");

      // Our side keeps the provider's own name and never adopts another
      // provider's vocabulary.
      const run = await runThroughRealAdapter("gemini-cli", payloads);
      expect(run.events[0]?.provenance.sourceEventName).toBe("BeforeTool");
      expect(run.events[0]?.type).toBe("tool.start");
      expect(divergence.dimension).toBe("lifecycle");
    });
  },
);
