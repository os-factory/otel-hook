import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createClaudeCodeAdapter } from "../../src/providers/claude/adapter.js";
import { findAdapterParityNote } from "./adapter-parity-notes.js";
import { findDivergence } from "./divergence-manifest.js";
import { runThroughRealAdapter } from "./harness/real-adapters.js";
import { mapClaudeCodeSession } from "./harness/canonical-mapping.js";
import { isPythonReferenceAvailable, runPythonSession, type PythonSpan } from "./harness/python-spans.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "..", "..", "fixtures", "parity", "claude-code");

const SESSION_FILES = [
  "session-start.json",
  "user-prompt-submit.json",
  "pre-tool-use.json",
  "post-tool-use.json",
  "pre-compact.json",
  "post-compact.json",
  "stop.json",
  "session-end.json",
] as const;

const loadSession = async (): Promise<unknown[]> =>
  Promise.all(
    SESSION_FILES.map(
      async (file) => JSON.parse(await readFile(path.join(FIXTURES_DIR, file), "utf8")) as unknown,
    ),
  );

const findSpan = (spans: readonly PythonSpan[], eventName: string): PythonSpan | undefined =>
  spans.find((span) => span.attributes["gen_ai.client.hook.event"] === eventName);

const availability = await isPythonReferenceAvailable();

if (!availability.available) {
  console.warn(
    `[parity] skipping claude-code differential suite: pinned opentelemetry-hooks reference unavailable (${
      availability.reason ?? "unknown reason"
    })`,
  );
}

describe.skipIf(!availability.available)(
  "claude-code parity: opentelemetry-hooks==0.14.0 vs. canonical model",
  () => {
    it("agrees on lifecycle coverage except the named PreCompact/PostCompact collapse (DIVERGENCE-004) and the extra session rollup (DIVERGENCE-006)", async () => {
      const payloads = await loadSession();
      const { events } = mapClaudeCodeSession(payloads);
      const result = await runPythonSession("claude-code", payloads);
      expect(result.available).toBe(true);
      if (!result.available) {
        return;
      }

      const hookSpanNames = result.spans
        .map((span) => span.attributes["gen_ai.client.hook.event"])
        .filter((value): value is string => typeof value === "string");

      expect(hookSpanNames).toEqual([
        "SessionStart",
        "UserPromptSubmit",
        "PreToolUse",
        "PostToolUse",
        "PreCompact",
        "PostCompact",
        "Stop",
        "SessionEnd",
      ]);

      // Python emits two spans (PreCompact, PostCompact) for the one compaction;
      // we collapse both into a single canonical compaction.performed event.
      expect(events.filter((event) => event.type === "compaction.performed")).toHaveLength(1);
      expect(hookSpanNames.filter((name) => name === "PreCompact" || name === "PostCompact")).toHaveLength(2);

      // DIVERGENCE-006: an unconditional rollup span with no canonical counterpart.
      const rollupSpans = result.spans.filter((span) => span.name === "gen_ai.client.session");
      expect(rollupSpans.length).toBeGreaterThan(0);
      findDivergence("DIVERGENCE-006");
    });

    it("diverges on usage total computation exactly as documented (DIVERGENCE-001)", async () => {
      const divergence = findDivergence("DIVERGENCE-001");
      const payloads = await loadSession();
      const { events } = mapClaudeCodeSession(payloads);
      const result = await runPythonSession("claude-code", payloads);
      expect(result.available).toBe(true);
      if (!result.available) {
        return;
      }

      const stopSpan = findSpan(result.spans, "Stop");
      expect(stopSpan).toBeDefined();
      // The fixture's usage.total_tokens (620) deliberately disagrees with the
      // arithmetic total (500 input + 20 disjoint cache-creation + 120 output = 640).
      expect(stopSpan?.attributes["gen_ai.usage.total_tokens"]).toBe(620);
      expect(stopSpan?.attributes["gen_ai.usage.input_tokens"]).toBe(500);
      expect(stopSpan?.attributes["gen_ai.usage.output_tokens"]).toBe(120);
      expect(stopSpan?.attributes["gen_ai.usage.cache_read.input_tokens"]).toBe(300);
      expect(stopSpan?.attributes["gen_ai.usage.cache_creation.input_tokens"]).toBe(20);

      const generationEnd = events.find((event) => event.type === "generation.end");
      expect(generationEnd?.type === "generation.end" ? generationEnd.usage : undefined).toMatchObject({
        inputTokens: 500,
        outputTokens: 120,
        cachedInputTokens: 300,
        cacheCreationInputTokens: 20,
        totalTokens: 640,
        providerTotalTokens: 620,
        providerTotalAgreement: "disagrees",
      });

      expect(divergence.dimension).toBe("usage");
    });

    it("diverges on reasoning-token support exactly as documented (DIVERGENCE-002)", async () => {
      const divergence = findDivergence("DIVERGENCE-002");
      const payloads = await loadSession();
      const { events } = mapClaudeCodeSession(payloads);
      const result = await runPythonSession("claude-code", payloads);
      expect(result.available).toBe(true);
      if (!result.available) {
        return;
      }

      // The fixture's Stop payload reports reasoning_output_tokens: 15; the
      // Python package has no field mapping for it anywhere, so no span
      // attribute reflects it at all.
      const stopSpan = findSpan(result.spans, "Stop");
      const stopAttrKeys = Object.keys(stopSpan?.attributes ?? {});
      expect(stopAttrKeys.some((key) => key.toLowerCase().includes("reasoning"))).toBe(false);

      const generationEnd = events.find((event) => event.type === "generation.end");
      expect(
        generationEnd?.type === "generation.end" ? generationEnd.usage?.reasoningOutputTokens : undefined,
      ).toBe(15);

      expect(divergence.dimension).toBe("usage");
    });

    it("diverges on cache-vs-input validation exactly as documented (DIVERGENCE-003)", async () => {
      const divergence = findDivergence("DIVERGENCE-003");
      const first = (await loadSession())[0] as { readonly cwd?: string };

      // A deliberately invalid usage shape: cache_read_input_tokens (999) far
      // exceeds input_tokens (10). Not stored under fixtures/parity because it
      // exists only to prove a single edge case, not to model a provider
      // protocol shape.
      const invalidUsagePayload = {
        hook_event_name: "Stop",
        session_id: "sess-parity-claude-divergence-003",
        cwd: first.cwd,
        last_assistant_message: "n/a",
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 999,
        usage: { input_tokens: 10, output_tokens: 5 },
      };

      const result = await runPythonSession("claude-code", [invalidUsagePayload]);
      expect(result.available).toBe(true);
      if (!result.available) {
        return;
      }
      const stopSpan = findSpan(result.spans, "Stop");
      // Python accepts the impossible value silently: no rejection, no clamping.
      expect(stopSpan?.attributes["gen_ai.usage.cache_read.input_tokens"]).toBe(999);
      expect(stopSpan?.attributes["gen_ai.usage.input_tokens"]).toBe(10);

      const { events } = mapClaudeCodeSession([invalidUsagePayload]);
      const generationEnd = events.find((event) => event.type === "generation.end");
      // Our mapper's normalizeUsage rejects the same shape outright, so no
      // usage is attached at all rather than a silently-wrong one.
      expect(generationEnd?.type === "generation.end" ? generationEnd.usage : undefined).toBeUndefined();

      expect(divergence.dimension).toBe("usage");
    });

    it("diverges on compaction field retention exactly as documented (DIVERGENCE-004)", async () => {
      const divergence = findDivergence("DIVERGENCE-004");
      const payloads = await loadSession();
      const { events } = mapClaudeCodeSession(payloads);
      const result = await runPythonSession("claude-code", payloads);
      expect(result.available).toBe(true);
      if (!result.available) {
        return;
      }

      const preCompact = findSpan(result.spans, "PreCompact");
      const postCompact = findSpan(result.spans, "PostCompact");
      expect(preCompact).toBeDefined();
      expect(postCompact).toBeDefined();
      const compactionAttrKeys = [
        ...Object.keys(preCompact?.attributes ?? {}),
        ...Object.keys(postCompact?.attributes ?? {}),
      ];
      expect(compactionAttrKeys.some((key) => key.includes("context_tokens"))).toBe(false);
      expect(compactionAttrKeys.some((key) => key.includes("compaction"))).toBe(false);

      const compaction = events.find((event) => event.type === "compaction.performed");
      expect(compaction?.type === "compaction.performed" ? compaction.contextTokensBefore : undefined).toBe(
        180_000,
      );
      expect(compaction?.type === "compaction.performed" ? compaction.contextTokensAfter : undefined).toBe(
        42_000,
      );

      expect(divergence.dimension).toBe("lifecycle");
    });

    it("diverges on structural path disclosure exactly as documented (DIVERGENCE-005)", async () => {
      const divergence = findDivergence("DIVERGENCE-005");
      const payloads = await loadSession();
      const { events } = mapClaudeCodeSession(payloads);
      const result = await runPythonSession("claude-code", payloads);
      expect(result.available).toBe(true);
      if (!result.available) {
        return;
      }

      const rawCwd = "/workspace/fixture-repo";
      const sessionStartSpan = findSpan(result.spans, "SessionStart");
      expect(sessionStartSpan?.attributes["gen_ai.client.cwd"]).toBe(rawCwd);
      expect(sessionStartSpan?.attributes["gen_ai.client.workspace"]).toBe(rawCwd);

      // Our canonical events never carry the raw path anywhere, in any field.
      const serialized = JSON.stringify(events);
      expect(serialized.includes(rawCwd)).toBe(false);
      for (const event of events) {
        expect(event.workspace.workspaceId.startsWith("sha256:")).toBe(true);
      }

      expect(divergence.dimension).toBe("privacy");
    });

    it("agrees that prompt text is omitted by default, only length and hash disclosed", async () => {
      const payloads = await loadSession();
      const { events } = mapClaudeCodeSession(payloads);
      const result = await runPythonSession("claude-code", payloads);
      expect(result.available).toBe(true);
      if (!result.available) {
        return;
      }

      const promptSpan = findSpan(result.spans, "UserPromptSubmit");
      expect(typeof promptSpan?.attributes["gen_ai.client.prompt.length"]).toBe("number");
      expect(promptSpan?.attributes["gen_ai.client.prompt.text"]).toBeUndefined();

      const prompt = events.find((event) => event.type === "prompt.submitted");
      expect(prompt?.type === "prompt.submitted" ? prompt.content?.disclosure : undefined).toBe("omitted");
      expect(prompt?.type === "prompt.submitted" ? prompt.content?.text : undefined).toBeUndefined();
      expect(prompt?.type === "prompt.submitted" ? prompt.content?.characterLength : undefined).toBeGreaterThan(
        0,
      );
    });
  },
);

/**
 * The suite above compares the Python reference against `mapClaudeCodeSession`,
 * a comparison-only mapper over the public canonical API. That answers "what can
 * this model express?". The suite below answers the question a consumer actually
 * cares about — "what does the shipped `claude-code` adapter emit for this exact
 * payload?" — by replaying the same fixtures through the real adapter and the
 * real runtime. Where the two answers differ, the difference is named in
 * `adapter-parity-notes.ts` rather than smoothed over.
 */
describe("claude-code parity: the shipped adapter on the same fixtures", () => {
  it("attributes the session and emits the lifecycle it declares support for", async () => {
    const payloads = await loadSession();
    const run = await runThroughRealAdapter("claude-code", payloads);

    // Every event carries the adapter's own provenance, at `exact` confidence
    // because the caller named the provider.
    for (const event of run.events) {
      expect(event.provenance.providerId).toBe("claude-code");
      expect(event.provenance.adapterId).toBe("claude-code");
      expect(event.provenance.detectionConfidence).toBe("exact");
      expect(event.sessionId).toBe("sess-parity-claude-001");
    }
    // Sequences are consecutive across the whole session, i.e. across what would
    // be eight separate hook processes.
    expect(run.events.map((event) => event.sequence)).toEqual(
      run.events.map((_event, index) => index),
    );
    expect(run.events.map((event) => event.type)).toEqual([
      "session.start",
      "prompt.submitted",
      "tool.start",
      "tool.end",
      "compaction.performed",
      "generation.start",
      "generation.end",
    ]);
  });

  it("never lets a raw path or prompt text reach an event (privacy, DIVERGENCE-005)", async () => {
    const divergence = findDivergence("DIVERGENCE-005");
    const payloads = await loadSession();
    const run = await runThroughRealAdapter("claude-code", payloads);

    const serialized = JSON.stringify(run.events);
    expect(serialized).not.toContain("/workspace/fixture-repo");
    expect(serialized).not.toContain("The fixture directory holds synthetic");
    for (const event of run.events) {
      expect(event.workspace.workspaceId.startsWith("sha256:")).toBe(true);
    }

    const prompt = run.events.find((event) => event.type === "prompt.submitted");
    expect(prompt?.type === "prompt.submitted" ? prompt.content?.disclosure : undefined).toBe("omitted");
    expect(prompt?.type === "prompt.submitted" ? prompt.content?.text : undefined).toBeUndefined();
    expect(
      prompt?.type === "prompt.submitted" ? prompt.content?.characterLength : undefined,
    ).toBeGreaterThan(0);
    expect(divergence.dimension).toBe("privacy");
  });

  it("collapses PreCompact/PostCompact into one compaction event (DIVERGENCE-004)", async () => {
    const payloads = await loadSession();
    const run = await runThroughRealAdapter("claude-code", payloads);

    const compactions = run.events.filter((event) => event.type === "compaction.performed");
    expect(compactions).toHaveLength(1);
    // PreCompact is an estimate; it is reported as "not applicable" rather than
    // as a second lifecycle event or an error.
    expect(run.attributions[4]).toBe("not-applicable");
    expect(findDivergence("DIVERGENCE-004").dimension).toBe("lifecycle");
  });

  it("does not carry contextTokensBefore across the PreCompact/PostCompact boundary (ADAPTER-NOTE-002)", async () => {
    const note = findAdapterParityNote("ADAPTER-NOTE-002");
    const payloads = await loadSession();
    const run = await runThroughRealAdapter("claude-code", payloads);

    const compaction = run.events.find((event) => event.type === "compaction.performed");
    expect(compaction?.type === "compaction.performed" ? compaction.contextTokensAfter : undefined).toBe(
      42_000,
    );
    // The model supports it and the comparison mapper produces it; a stateless
    // adapter cannot. If this ever becomes 180000, the note must be retired.
    expect(
      compaction?.type === "compaction.performed" ? compaction.contextTokensBefore : undefined,
    ).toBeUndefined();
    expect(
      mapClaudeCodeSession(payloads).events.find((event) => event.type === "compaction.performed"),
    ).toMatchObject({ contextTokensBefore: 180_000 });
    expect(note.kind).toBe("stateless-adapter");
  });

  it("reports the PostCompact trigger as unknown rather than guessing it (ADAPTER-NOTE-004)", async () => {
    const note = findAdapterParityNote("ADAPTER-NOTE-004");
    const payloads = await loadSession();
    const run = await runThroughRealAdapter("claude-code", payloads);

    const compaction = run.events.find((event) => event.type === "compaction.performed");
    expect(compaction?.type === "compaction.performed" ? compaction.trigger : undefined).toBe("unknown");
    expect(note.kind).toBe("contract-mismatch");
  });

  it("fails closed on the SessionEnd payload instead of inventing a reason (ADAPTER-NOTE-003)", async () => {
    const note = findAdapterParityNote("ADAPTER-NOTE-003");
    const payloads = await loadSession();
    const run = await runThroughRealAdapter("claude-code", payloads);

    // Last payload in the session is SessionEnd; the adapter rejects it.
    expect(run.attributions[run.attributions.length - 1]).toBe("failed");
    expect(run.diagnosticCodes).toContain("invalid-input");
    expect(run.events.some((event) => event.type === "session.end")).toBe(false);
    expect(note.kind).toBe("contract-mismatch");
  });

  it("emits only the usage its declared capabilities promise (ADAPTER-NOTE-001)", async () => {
    const note = findAdapterParityNote("ADAPTER-NOTE-001");
    const payloads = await loadSession();
    const run = await runThroughRealAdapter("claude-code", payloads);

    const generationEnd = run.events.find((event) => event.type === "generation.end");
    const usage = generationEnd?.type === "generation.end" ? generationEnd.usage : undefined;
    expect(usage).toBeDefined();
    // The nested `usage` object is the adapter's declared source, and it is
    // honoured exactly: 500 input + 120 output, folded inclusively.
    expect(usage).toMatchObject({
      temporality: "delta",
      inputTokens: 500,
      outputTokens: 120,
      cacheCreationAccounting: "included-in-input",
    });
    // The fixture's *top-level* cache and reasoning fields are outside that
    // shape. The adapter's capabilities say so up front, which is the whole
    // point of declaring them.
    const { capabilities } = createClaudeCodeAdapter();
    expect(capabilities.reportsReasoningOutput).toBe(false);
    expect(capabilities.reportsProviderTotal).toBe(false);
    expect(usage?.reasoningOutputTokens).toBe(0);
    expect(usage?.providerTotalAgreement).toBe("unreported");

    // The comparison mapper shows the model itself loses nothing, which is what
    // DIVERGENCE-002 is a claim about.
    const mapped = mapClaudeCodeSession(payloads).events.find(
      (event) => event.type === "generation.end",
    );
    expect(mapped?.type === "generation.end" ? mapped.usage?.reasoningOutputTokens : undefined).toBe(15);
    expect(note.kind).toBe("declared-capability");
  });

  it("keeps every canonical event free of the provider's raw payload", async () => {
    const payloads = await loadSession();
    const run = await runThroughRealAdapter("claude-code", payloads);

    for (const event of run.events) {
      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain("tool_response");
      expect(serialized).not.toContain("hook_event_name");
      // Extensions accept only attribute primitives, so a nested payload cannot
      // be smuggled through them.
      for (const value of Object.values(event.extensions)) {
        expect(typeof (Array.isArray(value) ? value[0] : value)).not.toBe("object");
      }
    }
  });
});
