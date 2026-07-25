import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { streamCodexTranscript, type CodexTranscriptObservation } from "../../../src/providers/codex/transcript.js";
import { transcriptFixturePath } from "./helpers.js";

const collect = async (
  path_: string,
  options?: Parameters<typeof streamCodexTranscript>[1],
): Promise<CodexTranscriptObservation[]> => {
  const observations: CodexTranscriptObservation[] = [];
  for await (const observation of streamCodexTranscript(path_, options)) {
    observations.push(observation);
  }
  return observations;
};

describe("codex transcript parser: rollout JSONL", () => {
  it("recognizes session_meta, turn_context, token_count, and response_item lines", async () => {
    const observations = await collect(transcriptFixturePath("rollout-basic.jsonl"));
    const kinds = observations.map((observation) => observation.kind);

    expect(kinds).toContain("session_meta");
    expect(kinds).toContain("turn_context");
    expect(kinds).toContain("token_count");
    expect(kinds).toContain("response_item");
  });

  it("extracts total_token_usage and last_token_usage from a token_count event", async () => {
    const observations = await collect(transcriptFixturePath("rollout-basic.jsonl"));
    const tokenCounts = observations.filter((observation) => observation.kind === "token_count");
    expect(tokenCounts.length).toBeGreaterThan(0);
    const first = tokenCounts[0];
    if (first?.kind !== "token_count") {
      throw new Error("expected a token_count observation");
    }
    expect(first.totalTokenUsage?.input_tokens).toBe(1000);
    expect(first.lastTokenUsage?.output_tokens).toBe(150);
  });

  it("never deduplicates token_count observations by their token values", async () => {
    const observations = await collect(transcriptFixturePath("rollout-basic.jsonl"));
    const tokenCounts = observations.filter((observation) => observation.kind === "token_count");
    // The fixture repeats an identical token_count line verbatim; both must survive.
    expect(tokenCounts).toHaveLength(3);
  });

  it("deduplicates response_item lines by their own id", async () => {
    const observations = await collect(transcriptFixturePath("rollout-basic.jsonl"));
    const responseItems = observations.filter((observation) => observation.kind === "response_item");
    // The fixture repeats item-0001 verbatim; only the first occurrence survives.
    const ids = responseItems.map((observation) =>
      observation.kind === "response_item" && typeof observation.payload === "object" && observation.payload !== null
        ? (observation.payload as { id?: unknown }).id
        : undefined,
    );
    expect(ids.filter((id) => id === "item-0001")).toHaveLength(1);
  });
});

describe("codex transcript parser: exec --json stream", () => {
  it("recognizes thread/turn/item exec events", async () => {
    const observations = await collect(transcriptFixturePath("exec-stream.jsonl"));
    const execEvents = observations.filter((observation) => observation.kind === "exec_event");
    const eventTypes = execEvents.map((observation) =>
      observation.kind === "exec_event" ? observation.eventType : undefined,
    );
    expect(eventTypes).toContain("thread.started");
    expect(eventTypes).toContain("turn.completed");
    expect(eventTypes).toContain("item.completed");
  });

  it("deduplicates repeated item.completed lines for the same item id", async () => {
    const observations = await collect(transcriptFixturePath("exec-stream.jsonl"));
    const completedForItem2 = observations.filter(
      (observation) =>
        observation.kind === "exec_event" &&
        observation.eventType === "item.completed" &&
        (observation.payload as { item?: { id?: unknown } }).item?.id === "item_2",
    );
    expect(completedForItem2).toHaveLength(1);
  });
});

describe("codex transcript parser: malformed and bounded input", () => {
  it("reports malformed lines without aborting the stream", async () => {
    const observations = await collect(transcriptFixturePath("rollout-malformed.jsonl"));
    const malformed = observations.filter((observation) => observation.kind === "malformed");
    expect(malformed.length).toBeGreaterThanOrEqual(2);
    // Well-formed lines around the bad ones still come through.
    expect(observations.some((observation) => observation.kind === "session_meta")).toBe(true);
    expect(observations.some((observation) => observation.kind === "token_count")).toBe(true);
  });

  it("stops and reports truncation after too many malformed lines", async () => {
    const observations = await collect(transcriptFixturePath("rollout-malformed.jsonl"), {
      maxMalformedLines: 1,
    });
    const truncated = observations.find((observation) => observation.kind === "truncated");
    expect(truncated).toBeDefined();
    expect(truncated?.kind === "truncated" && truncated.reason).toBe("max-malformed-lines");
  });

  it("stops after maxLines and reports truncation", async () => {
    const observations = await collect(transcriptFixturePath("rollout-basic.jsonl"), { maxLines: 2 });
    expect(observations).toHaveLength(3);
    expect(observations[2]?.kind).toBe("truncated");
    expect(observations[2]?.kind === "truncated" && observations[2].reason).toBe("max-lines");
  });

  it("treats an oversized line as malformed rather than reading it whole", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codex-transcript-"));
    const file = path.join(dir, "huge.jsonl");
    const hugeLine = JSON.stringify({ type: "response_item", payload: { id: "x", text: "a".repeat(2_000_000) } });
    writeFileSync(file, `${hugeLine}\n{"type":"session_meta","payload":{"id":"s"}}\n`);

    const observations = await collect(file, { maxLineBytes: 1024 });
    expect(observations[0]?.kind).toBe("malformed");
    expect(observations[0]?.kind === "malformed" && observations[0].reason).toBe("line-too-long");
    expect(observations[1]?.kind).toBe("session_meta");
  });

  it("never reads more of the file than the bound allows (streaming, not buffering)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codex-transcript-"));
    const file = path.join(dir, "many-lines.jsonl");
    const lines = Array.from({ length: 500 }, (_, index) =>
      JSON.stringify({ type: "turn_context", payload: { id: `turn-${index}` } }),
    );
    writeFileSync(file, `${lines.join("\n")}\n`);

    const observations = await collect(file, { maxLines: 10 });
    expect(observations.filter((observation) => observation.kind === "turn_context")).toHaveLength(10);
    expect(observations.at(-1)?.kind).toBe("truncated");
  });

  it("ignores blank lines without counting them against the line bound", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codex-transcript-"));
    const file = path.join(dir, "blank-lines.jsonl");
    writeFileSync(
      file,
      '\n\n{"type":"session_meta","payload":{"id":"s"}}\n\n{"type":"turn_context","payload":{"id":"t"}}\n',
    );

    const observations = await collect(file);
    expect(observations.map((observation) => observation.kind)).toEqual(["session_meta", "turn_context"]);
  });
});
