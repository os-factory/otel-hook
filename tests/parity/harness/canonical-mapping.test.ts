import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { mapClaudeCodeSession, mapCursorSession } from "./canonical-mapping.js";

const FIXTURES_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "fixtures", "parity");

const loadSequence = async (dir: string, files: readonly string[]): Promise<unknown[]> =>
  Promise.all(
    files.map(async (file) => JSON.parse(await readFile(path.join(FIXTURES_ROOT, dir, file), "utf8")) as unknown),
  );

describe("canonical mapping harness (comparison-only, not a shipped adapter)", () => {
  it("maps the full claude-code session fixture sequence to a valid canonical event stream", async () => {
    const payloads = await loadSequence("claude-code", [
      "session-start.json",
      "user-prompt-submit.json",
      "pre-tool-use.json",
      "post-tool-use.json",
      "pre-compact.json",
      "post-compact.json",
      "stop.json",
      "session-end.json",
    ]);

    const { events, droppedExtensionKeys } = mapClaudeCodeSession(payloads);

    expect(droppedExtensionKeys).toEqual([]);
    expect(events.map((event) => event.type)).toEqual([
      "session.start",
      "prompt.submitted",
      "tool.start",
      "tool.end",
      "compaction.performed",
      "generation.end",
      "session.end",
    ]);

    const compaction = events.find((event) => event.type === "compaction.performed");
    expect(compaction).toMatchObject({
      contextTokensBefore: 180_000,
      contextTokensAfter: 42_000,
    });

    const generationEnd = events.find((event) => event.type === "generation.end");
    expect(generationEnd?.type === "generation.end" && generationEnd.usage).toMatchObject({
      inputTokens: 500,
      outputTokens: 120,
      cachedInputTokens: 300,
      cacheCreationInputTokens: 20,
      cacheCreationAccounting: "disjoint-from-input",
      totalTokens: 640,
      providerTotalTokens: 620,
      providerTotalAgreement: "disagrees",
    });

    const prompt = events.find((event) => event.type === "prompt.submitted");
    expect(prompt?.type === "prompt.submitted" ? prompt.content?.disclosure : undefined).toBe("omitted");
    expect(prompt?.type === "prompt.submitted" ? prompt.content?.text : undefined).toBeUndefined();

    for (const event of events) {
      expect(event.workspace.workspaceId.startsWith("sha256:")).toBe(true);
      expect(event.workspace.keySource).toBe("explicit");
    }
  });

  it("maps the cursor session fixture sequence, splitting MCP-encoded tool names into extensions", async () => {
    const payloads = await loadSequence("cursor", [
      "session-start.json",
      "pre-tool-use-mcp.json",
      "post-tool-use-mcp.json",
    ]);

    const { events, droppedExtensionKeys } = mapCursorSession(payloads);

    expect(droppedExtensionKeys).toEqual([]);
    expect(events.map((event) => event.type)).toEqual(["session.start", "tool.start", "tool.end"]);

    const toolStart = events.find((event) => event.type === "tool.start");
    expect(toolStart?.extensions).toMatchObject({
      "cursor.mcp-server": "github",
      "cursor.mcp-tool": "search_issues",
    });

    const toolEnd = events.find((event) => event.type === "tool.end");
    expect(toolEnd?.type === "tool.end" ? toolEnd.durationMillis : undefined).toBeCloseTo(84, 5);
  });
});
