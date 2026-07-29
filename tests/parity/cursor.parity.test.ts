import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { normalizeCursorPayload } from "../../src/providers/cursor/payload.js";
import { findDivergence } from "./divergence-manifest.js";
import { mapCursorSession } from "./harness/canonical-mapping.js";
import { runThroughRealAdapter } from "./harness/real-adapters.js";
import { isPythonReferenceAvailable, runPythonSession, type PythonSpan } from "./harness/python-spans.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "..", "..", "fixtures", "parity", "cursor");

/**
 * One ordered Cursor session, in the order a host would fire the hooks.
 *
 * Both sides of the comparison now read these exact bytes. There is no envelope
 * bridge on our side any more: the adapter's payload contract is Cursor's real
 * snake_case shape, so the fixture that the Python reference consumes is the
 * fixture the shipped adapter consumes.
 */
const SESSION_FILES = [
  "session-start.json",
  "before-submit-prompt.json",
  "pre-tool-use-mcp.json",
  "post-tool-use-mcp.json",
  "stop.json",
  "session-end.json",
] as const;

const loadSession = async (): Promise<unknown[]> =>
  Promise.all(
    SESSION_FILES.map(
      async (file) => JSON.parse(await readFile(path.join(FIXTURES_DIR, file), "utf8")) as unknown,
    ),
  );

const loadFixture = async (file: string): Promise<unknown> =>
  JSON.parse(await readFile(path.join(FIXTURES_DIR, file), "utf8")) as unknown;

const findSpan = (spans: readonly PythonSpan[], eventName: string): PythonSpan | undefined =>
  spans.find((span) => span.attributes["gen_ai.client.hook.event"] === eventName);

const availability = await isPythonReferenceAvailable();

if (!availability.available) {
  console.warn(
    `[parity] skipping cursor differential suite: pinned opentelemetry-hooks reference unavailable (${
      availability.reason ?? "unknown reason"
    })`,
  );
}

describe.skipIf(!availability.available)(
  "cursor parity: opentelemetry-hooks==0.14.0 vs. canonical model",
  () => {
    it("agrees on splitting an mcp__<server>__<tool> name into server/tool parts", async () => {
      const payloads = await loadSession();
      const { events } = mapCursorSession(payloads);
      const result = await runPythonSession("cursor", payloads);
      expect(result.available).toBe(true);
      if (!result.available) {
        return;
      }

      const preToolUse = findSpan(result.spans, "PreToolUse");
      expect(preToolUse?.attributes["gen_ai.client.mcp_server"]).toBe("github");
      expect(preToolUse?.attributes["gen_ai.client.mcp_tool"]).toBe("search_issues");

      const toolStart = events.find((event) => event.type === "tool.start");
      expect(toolStart?.extensions).toMatchObject({
        "cursor.mcp-server": "github",
        "cursor.mcp-tool": "search_issues",
      });
    });

    it("agrees on postToolUse's duration, which both sides read as milliseconds", async () => {
      const payloads = await loadSession();
      const { events } = mapCursorSession(payloads);
      const result = await runPythonSession("cursor", payloads);
      expect(result.available).toBe(true);
      if (!result.available) {
        return;
      }

      const postToolUse = findSpan(result.spans, "PostToolUse");
      expect(postToolUse?.attributes["gen_ai.client.duration_ms"]).toBeCloseTo(84.5, 5);

      const toolEnd = events.find((event) => event.type === "tool.end");
      expect(toolEnd?.type === "tool.end" ? toolEnd.durationMillis : undefined).toBeCloseTo(84.5, 5);
    });

    it("scales afterMCPExecution's duration by 1000 and drops the shell one (DIVERGENCE-008)", async () => {
      const divergence = findDivergence("DIVERGENCE-008");
      expect(divergence.dimension).toBe("lifecycle");

      const payloads = [
        await loadFixture("session-start.json"),
        await loadFixture("after-mcp-execution.json"),
        await loadFixture("after-shell-execution.json"),
      ];
      const result = await runPythonSession("cursor", payloads);
      expect(result.available).toBe(true);
      if (!result.available) {
        return;
      }

      // Same 84.5 milliseconds the reference read correctly on postToolUse,
      // multiplied by 1000 here because this path treats the key as seconds.
      const afterMcp = findSpan(result.spans, "AfterMCPExecution");
      expect(afterMcp?.attributes["gen_ai.client.duration_ms"]).toBeCloseTo(84_500, 5);

      // And dropped entirely here, because this path reads only `duration_ms`.
      const afterShell = findSpan(result.spans, "AfterShellExecution");
      expect(afterShell).toBeDefined();
      expect(afterShell?.attributes["gen_ai.client.duration_ms"]).toBeUndefined();

      // Ours reads `duration` as milliseconds on both, unscaled.
      const run = await runThroughRealAdapter("cursor", payloads);
      const durations = run.events
        .filter((event) => event.type === "tool.end")
        .map((event) => (event.type === "tool.end" ? event.durationMillis : undefined));
      expect(durations).toEqual([84.5, 169.812]);
    });

    it("drops Cursor's cache-read tokens, leaving input tokens unbroken down (DIVERGENCE-009)", async () => {
      const divergence = findDivergence("DIVERGENCE-009");
      expect(divergence.dimension).toBe("usage");

      const payloads = await loadSession();
      const result = await runPythonSession("cursor", payloads);
      expect(result.available).toBe(true);
      if (!result.available) {
        return;
      }

      const stop = findSpan(result.spans, "Stop");
      expect(stop?.attributes["gen_ai.usage.input_tokens"]).toBe(43_859);
      expect(stop?.attributes["gen_ai.usage.output_tokens"]).toBe(1_076);
      // No cache attribute under any spelling.
      const cacheKeys = Object.keys(stop?.attributes ?? {}).filter((key) => key.includes("cache"));
      expect(cacheKeys).toEqual([]);

      const run = await runThroughRealAdapter("cursor", payloads);
      const generationEnd = run.events.find((event) => event.type === "generation.end");
      expect(generationEnd?.type === "generation.end" ? generationEnd.usage : undefined).toMatchObject(
        { inputTokens: 43_859, cachedInputTokens: 28_384, uncachedInputTokens: 15_475 },
      );
    });

    it("rewrites Cursor's event vocabulary into Claude Code's (DIVERGENCE-007)", async () => {
      const divergence = findDivergence("DIVERGENCE-007");
      expect(divergence.dimension).toBe("lifecycle");

      const payloads = await loadSession();
      const result = await runPythonSession("cursor", payloads);
      expect(result.available).toBe(true);
      if (!result.available) {
        return;
      }

      // Cursor calls it `beforeSubmitPrompt`; the reference reports Claude Code's
      // name for the equivalent hook.
      expect(findSpan(result.spans, "UserPromptSubmit")).toBeDefined();
      expect(findSpan(result.spans, "beforeSubmitPrompt")).toBeUndefined();

      // Ours keeps the provider's own spelling in provenance, and expresses the
      // lifecycle meaning in the provider-neutral canonical type.
      const run = await runThroughRealAdapter("cursor", payloads);
      const prompt = run.events.find((event) => event.type === "prompt.submitted");
      expect(prompt?.provenance.sourceEventName).toBe("beforeSubmitPrompt");
    });
  },
);

/**
 * The assertions above compare the Python reference against a comparison-only
 * mapper, which shows what the canonical model can express. These run the same
 * fixtures through the *shipped* adapter, with nothing in between.
 */
describe("cursor parity: the shipped adapter on the same fixtures", () => {
  it("validates the raw fixture bytes directly, with no envelope bridge", async () => {
    const payloads = await loadSession();
    for (const payload of payloads) {
      // This is the assertion that retired ADAPTER-NOTE-005: the payload the
      // Python reference consumes is the payload our contract accepts.
      expect(normalizeCursorPayload(payload)).toBeDefined();
    }
  });

  it("maps the session onto one full lifecycle, with the tool pair correlated", async () => {
    const payloads = await loadSession();
    const run = await runThroughRealAdapter("cursor", payloads);

    expect(run.diagnosticCodes).toEqual([]);
    expect(run.events.map((event) => event.type)).toEqual([
      "session.start",
      "prompt.submitted",
      "generation.start",
      "tool.start",
      "tool.end",
      "generation.end",
      "session.end",
    ]);
    expect(run.events.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    for (const event of run.events) {
      expect(event.sessionId).toBe("3f7c1d2e-0000-4a00-8000-000000000001");
      expect(event.provenance.adapterId).toBe("cursor");
    }

    const toolStart = run.events.find((event) => event.type === "tool.start");
    const toolEnd = run.events.find((event) => event.type === "tool.end");
    // Cursor's `tool_use_id` correlates the pair, and the adapter keeps Cursor's
    // encoded `mcp__<server>__<tool>` name on both edges rather than rewriting
    // one of them — a pair that shares an id but not a name is a real hazard for
    // a consumer grouping by name.
    expect(toolStart?.type === "tool.start" ? toolStart.toolCallId : undefined).toBe(
      "tool_3f7c1d2e00004a0080000000000000b1",
    );
    expect(toolEnd?.type === "tool.end" ? toolEnd.toolCallId : undefined).toBe(
      toolStart?.type === "tool.start" ? toolStart.toolCallId : undefined,
    );
    expect(toolStart?.type === "tool.start" ? toolStart.toolName : undefined).toBe(
      "mcp__github__search_issues",
    );
    expect(toolEnd?.type === "tool.end" ? toolEnd.toolName : undefined).toBe(
      "mcp__github__search_issues",
    );
  });

  it("attributes every payload in the session to the same conversation", async () => {
    const payloads = await loadSession();
    const run = await runThroughRealAdapter("cursor", payloads);
    expect(run.attributions).toEqual(Array.from({ length: SESSION_FILES.length }, () => "attributed"));
  });

  it("omits content by default and never exports the workspace path or the account address", async () => {
    const payloads = await loadSession();
    const run = await runThroughRealAdapter("cursor", payloads);

    const serialized = JSON.stringify(run.events);
    expect(serialized).not.toContain("/workspace/fixture-repo");
    expect(serialized).not.toContain("synthetic fixture issue");
    expect(serialized).not.toContain("list the open fixture issues");
    expect(serialized).not.toContain("agent-transcripts");

    const toolStart = run.events.find((event) => event.type === "tool.start");
    expect(toolStart?.type === "tool.start" ? toolStart.input?.disclosure : undefined).toBe("omitted");
    expect(toolStart?.type === "tool.start" ? toolStart.input?.text : undefined).toBeUndefined();
    for (const event of run.events) {
      expect(event.workspace.workspaceId.startsWith("sha256:")).toBe(true);
    }
  });
});
