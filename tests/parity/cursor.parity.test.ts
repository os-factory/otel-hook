import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { mapCursorSession } from "./harness/canonical-mapping.js";
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
