import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { normalizeCursorPayload } from "../../src/providers/cursor/payload.js";
import { findAdapterParityNote } from "./adapter-parity-notes.js";
import { mapCursorSession } from "./harness/canonical-mapping.js";
import { bridgeCursorParitySession, runThroughRealAdapter } from "./harness/real-adapters.js";
import { isPythonReferenceAvailable, runPythonSession, type PythonSpan } from "./harness/python-spans.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "..", "..", "fixtures", "parity", "cursor");

const SESSION_FILES = ["session-start.json", "pre-tool-use-mcp.json", "post-tool-use-mcp.json"] as const;

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
    `[parity] skipping cursor differential suite: pinned opentelemetry-hooks reference unavailable (${
      availability.reason ?? "unknown reason"
    })`,
  );
}

describe.skipIf(!availability.available)(
  "cursor parity: opentelemetry-hooks==0.14.0 vs. canonical model (agreement confirmations)",
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

    it("agrees on converting Cursor's fractional-seconds duration to milliseconds", async () => {
      const payloads = await loadSession();
      const { events } = mapCursorSession(payloads);
      const result = await runPythonSession("cursor", payloads);
      expect(result.available).toBe(true);
      if (!result.available) {
        return;
      }

      const afterMcp = findSpan(result.spans, "AfterMCPExecution") ?? findSpan(result.spans, "PostToolUse");
      expect(afterMcp?.attributes["gen_ai.client.duration_ms"]).toBeCloseTo(84, 5);

      const toolEnd = events.find((event) => event.type === "tool.end");
      expect(toolEnd?.type === "tool.end" ? toolEnd.durationMillis : undefined).toBeCloseTo(84, 5);
    });
  },
);

/**
 * As with the claude-code suite: the assertions above compare the Python
 * reference against a comparison-only mapper, which shows what the canonical
 * model can express. These run the same fixtures through the *shipped* Cursor
 * adapter, via the documented envelope bridge (ADAPTER-NOTE-005).
 */
describe("cursor parity: the shipped adapter on the same fixtures", () => {
  it("needs a documented envelope bridge, because the adapter's payload contract is synthetic (ADAPTER-NOTE-005)", async () => {
    const note = findAdapterParityNote("ADAPTER-NOTE-005");
    const payloads = await loadSession();

    // The raw, real-shaped fixture the Python reference consumes does not
    // validate against this package's Cursor contract at all — that is the note,
    // stated as an assertion rather than a comment.
    for (const payload of payloads) {
      expect(normalizeCursorPayload(payload)).toBeUndefined();
    }
    for (const bridged of bridgeCursorParitySession(payloads)) {
      expect(normalizeCursorPayload(bridged)).toBeDefined();
    }
    expect(note.kind).toBe("envelope-bridge");
  });

  it("maps the bridged session onto a complete tool lifecycle", async () => {
    const payloads = await loadSession();
    const run = await runThroughRealAdapter("cursor", bridgeCursorParitySession(payloads));

    expect(run.attributions).toEqual(["attributed", "attributed", "attributed"]);
    expect(run.diagnosticCodes).toEqual([]);
    expect(run.events.map((event) => event.type)).toEqual([
      "session.start",
      "tool.start",
      "tool.end",
    ]);
    expect(run.events.map((event) => event.sequence)).toEqual([0, 1, 2]);
    for (const event of run.events) {
      expect(event.sessionId).toBe("conv-parity-cursor-001");
      expect(event.provenance.adapterId).toBe("cursor");
    }
  });

  it("agrees with the Python reference on the fractional-seconds duration conversion", async () => {
    const payloads = await loadSession();
    const run = await runThroughRealAdapter("cursor", bridgeCursorParitySession(payloads));

    const toolEnd = run.events.find((event) => event.type === "tool.end");
    // The fixture reports 0.084 seconds; the canonical model is milliseconds.
    expect(toolEnd?.type === "tool.end" ? toolEnd.durationMillis : undefined).toBeCloseTo(84, 5);
    expect(toolEnd?.type === "tool.end" ? toolEnd.outcome : undefined).toBe("ok");
  });

  it("splits the MCP tool name on the end event but keeps the encoded name on the start event", async () => {
    const payloads = await loadSession();
    const run = await runThroughRealAdapter("cursor", bridgeCursorParitySession(payloads));

    const toolStart = run.events.find((event) => event.type === "tool.start");
    const toolEnd = run.events.find((event) => event.type === "tool.end");

    // The bridge maps the fixture's `preToolUse` to `beforeToolUse`, which carries
    // an opaque tool name, so the encoded `mcp__<server>__<tool>` string is what
    // the adapter sees and reports.
    expect(toolStart?.type === "tool.start" ? toolStart.toolName : undefined).toBe(
      "mcp__github__search_issues",
    );
    // `afterMCPExecution` carries server and tool as separate fields, and the
    // adapter composes the canonical `server:tool` name from them — the same
    // split the Python reference performs, expressed as one name.
    expect(toolEnd?.type === "tool.end" ? toolEnd.toolName : undefined).toBe("github:search_issues");
    // The start/end pair therefore shares a tool call id but not a tool name,
    // which is a real correlation hazard for a consumer grouping by name.
    expect(toolStart?.type === "tool.start" ? toolStart.toolCallId : undefined).toBe(
      toolEnd?.type === "tool.end" ? toolEnd.toolCallId : undefined,
    );
    expect(toolEnd?.type === "tool.end" ? toolEnd.extensions["cursor.tool_correlation"] : undefined).toBe(
      "explicit",
    );
  });

  it("omits tool input by default and never exports the raw workspace path", async () => {
    const payloads = await loadSession();
    const run = await runThroughRealAdapter("cursor", bridgeCursorParitySession(payloads));

    const serialized = JSON.stringify(run.events);
    expect(serialized).not.toContain("/workspace/fixture-repo");
    expect(serialized).not.toContain("synthetic fixture issue");

    const toolStart = run.events.find((event) => event.type === "tool.start");
    expect(toolStart?.type === "tool.start" ? toolStart.input?.disclosure : undefined).toBe("omitted");
    expect(toolStart?.type === "tool.start" ? toolStart.input?.text : undefined).toBeUndefined();
    for (const event of run.events) {
      expect(event.workspace.workspaceId.startsWith("sha256:")).toBe(true);
    }
  });
});
