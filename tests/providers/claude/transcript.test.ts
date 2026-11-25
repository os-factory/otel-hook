/**
 * The harness half of Claude Code's usage contract (issue #64): reading the last
 * assistant message of a transcript, and attaching its `{ model, usage }` to a
 * `Stop` payload for the adapter to map.
 *
 * The adapter itself never reads a transcript (ADR 0003); these helpers are what a
 * wrapper calls. Every degraded input — missing, huge, malformed, not a file —
 * must come back as a value, never as a throw, because the caller is a hook.
 *
 * The transcript is the synthetic contract fixture
 * fixtures/contracts/claude-code/transcript-tail-turn.json, written out one record
 * per line the way Claude Code stores it.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CanonicalEvent } from "../../../src/model/events.js";
import {
  attachClaudeTranscriptTurn,
  createClaudeCodeAdapter,
  readClaudeTranscriptTurn,
} from "../../../src/providers/index.js";
import { createTestHook } from "../../../src/testing/index.js";

const FIXTURE = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "fixtures",
  "contracts",
  "claude-code",
  "transcript-tail-turn.json",
);

const FINAL_USAGE = {
  input_tokens: 3,
  output_tokens: 412,
  cache_read_input_tokens: 118_000,
  cache_creation_input_tokens: 7_400,
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), "otel-hook-claude-transcript-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

const fixtureLines = async (): Promise<string[]> => {
  const { records } = JSON.parse(await readFile(FIXTURE, "utf8")) as { records: unknown[] };
  return records.map((record) => JSON.stringify(record));
};

const writeTranscript = async (lines: readonly string[], name = "session.jsonl"): Promise<string> => {
  const file = path.join(await tempDir(), name);
  await writeFile(file, `${lines.join("\n")}\n`);
  return file;
};

describe("readClaudeTranscriptTurn", () => {
  it("returns the last top-level assistant message's model and usage", async () => {
    const turn = await readClaudeTranscriptTurn(await writeTranscript(await fixtureLines()));
    expect(turn.status).toBe("found");
    if (turn.status !== "found") throw new Error("unreachable");
    // Not the trailing sidechain (claude-synthetic-haiku-9) or <synthetic> record,
    // and not the earlier tool_use request's usage summed in.
    expect(turn.model).toBe("claude-synthetic-opus-9");
    expect(turn.usage).toMatchObject(FINAL_USAGE);
    expect(turn.usage?.cache_creation).toEqual({ ephemeral_5m_input_tokens: 1_400, ephemeral_1h_input_tokens: 6_000 });
  });

  it("returns only the model and the counters, never content", async () => {
    const turn = await readClaudeTranscriptTurn(await writeTranscript(await fixtureLines()));
    const serialized = JSON.stringify(turn);
    expect(serialized).not.toContain("Synthetic placeholder");
    expect(serialized).not.toContain("contract-repo");
    expect(serialized).not.toContain("msg_contract");
  });

  it("skips malformed and truncated lines instead of failing", async () => {
    const lines = await fixtureLines();
    const file = await writeTranscript([
      ...lines,
      "not json at all",
      '{"type":"assistant","message":{"model":"claude-cut-off","usage":{"input_tok',
    ]);
    const turn = await readClaudeTranscriptTurn(file);
    expect(turn).toMatchObject({ status: "found", model: "claude-synthetic-opus-9" });
  });

  it("reports a transcript with no usable assistant message", async () => {
    const file = await writeTranscript(["garbage", '{"type":"user","message":{"content":"hi"}}', "{"]);
    expect(await readClaudeTranscriptTurn(file)).toEqual({ status: "unavailable", reason: "no-assistant-message" });
    expect(await readClaudeTranscriptTurn(await writeTranscript([]))).toEqual({
      status: "unavailable",
      reason: "no-assistant-message",
    });
  });

  it("reports a missing file without throwing", async () => {
    const missing = path.join(await tempDir(), "absent.jsonl");
    expect(await readClaudeTranscriptTurn(missing)).toEqual({ status: "unavailable", reason: "unreadable" });
  });

  it("refuses relative, non-.jsonl, and NUL-bearing paths before touching the filesystem", async () => {
    expect(await readClaudeTranscriptTurn("relative/session.jsonl")).toEqual({
      status: "unavailable",
      reason: "invalid-path",
    });
    expect(await readClaudeTranscriptTurn(path.join(await tempDir(), "notes.txt"))).toEqual({
      status: "unavailable",
      reason: "invalid-path",
    });
    expect(await readClaudeTranscriptTurn("/tmp/a\0b.jsonl")).toEqual({ status: "unavailable", reason: "invalid-path" });
    expect(await readClaudeTranscriptTurn("")).toEqual({ status: "unavailable", reason: "invalid-path" });
  });

  it("refuses a directory", async () => {
    const dir = path.join(await tempDir(), "looks-like.jsonl");
    await mkdir(dir);
    expect(await readClaudeTranscriptTurn(dir)).toEqual({ status: "unavailable", reason: "not-a-file" });
  });

  it.skipIf(process.platform === "win32")("refuses a FIFO rather than blocking on it", async () => {
    const fifo = path.join(await tempDir(), "pipe.jsonl");
    try {
      execFileSync("mkfifo", [fifo]);
    } catch {
      return; // no mkfifo on this host
    }
    expect(await readClaudeTranscriptTurn(fifo)).toEqual({ status: "unavailable", reason: "not-a-file" });
  });

  it("reads only the tail of a huge transcript", async () => {
    const lines = await fixtureLines();
    // ~4 MiB of user records ahead of the turn: far over the 1 MiB default tail.
    const filler = JSON.stringify({ type: "user", message: { content: "x".repeat(1_000) } });
    const file = await writeTranscript([...Array.from({ length: 4_000 }, () => filler), ...lines]);
    const started = Date.now();
    const turn = await readClaudeTranscriptTurn(file);
    expect(turn).toMatchObject({ status: "found", model: "claude-synthetic-opus-9" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("does not look past its tail bound for an older assistant message", async () => {
    const lines = await fixtureLines();
    const filler = JSON.stringify({ type: "user", message: { content: "x".repeat(1_000) } });
    // The assistant records sit ahead of ~200 KiB of filler; a 64 KiB tail cannot reach them.
    const file = await writeTranscript([...lines, ...Array.from({ length: 200 }, () => filler)]);
    expect(await readClaudeTranscriptTurn(file, { maxTailBytes: 65_536 })).toEqual({
      status: "unavailable",
      reason: "no-assistant-message",
    });
    // The default tail does reach them.
    expect((await readClaudeTranscriptTurn(file)).status).toBe("found");
  });

  it("ignores the partial first line of a tail that starts mid-record", async () => {
    // One assistant record, padded so the 64 KiB tail starts inside it. Its
    // closing fragment must not be parsed as a record of its own.
    const padded = JSON.stringify({
      type: "assistant",
      message: { model: "claude-padded", usage: { input_tokens: 1, output_tokens: 1 }, content: "y".repeat(100_000) },
    });
    const file = await writeTranscript([padded]);
    expect(await readClaudeTranscriptTurn(file, { maxTailBytes: 65_536 })).toEqual({
      status: "unavailable",
      reason: "no-assistant-message",
    });
  });
});

describe("attachClaudeTranscriptTurn", () => {
  const stop = (transcriptPath: string, extra: Record<string, unknown> = {}) => ({
    hook_event_name: "Stop",
    session_id: "ses-transcript-attach-0001",
    transcript_path: transcriptPath,
    cwd: "/workspace/contract-repo",
    prompt_id: "prompt-attach-0001",
    stop_hook_active: false,
    ...extra,
  });

  it("attaches model and usage to a Stop that carries neither", async () => {
    const file = await writeTranscript(await fixtureLines());
    const enriched = (await attachClaudeTranscriptTurn(stop(file))) as Record<string, unknown>;
    expect(enriched.model).toBe("claude-synthetic-opus-9");
    expect(enriched.usage).toMatchObject(FINAL_USAGE);
    expect(enriched.session_id).toBe("ses-transcript-attach-0001");
  });

  it("attaches to StopFailure too", async () => {
    const file = await writeTranscript(await fixtureLines());
    const enriched = (await attachClaudeTranscriptTurn({
      ...stop(file),
      hook_event_name: "StopFailure",
      error_type: "max_output_tokens",
    })) as Record<string, unknown>;
    expect(enriched.model).toBe("claude-synthetic-opus-9");
  });

  it("never overwrites a field the payload already carries", async () => {
    const file = await writeTranscript(await fixtureLines());
    const own = { input_tokens: 1, output_tokens: 2 };
    const enriched = (await attachClaudeTranscriptTurn(stop(file, { usage: own }))) as Record<string, unknown>;
    expect(enriched.usage).toEqual(own);
    expect(enriched.model).toBe("claude-synthetic-opus-9");

    const both = stop(file, { usage: own, model: "harness-model" });
    expect(await attachClaudeTranscriptTurn(both)).toBe(both);
  });

  it("leaves other events, missing transcripts, and non-objects untouched", async () => {
    const file = await writeTranscript(await fixtureLines());
    const prompt = { ...stop(file), hook_event_name: "UserPromptSubmit", prompt: "hi" };
    expect(await attachClaudeTranscriptTurn(prompt)).toBe(prompt);

    const missing = stop(path.join(await tempDir(), "absent.jsonl"));
    expect(await attachClaudeTranscriptTurn(missing)).toBe(missing);

    const noPath = { hook_event_name: "Stop", session_id: "ses-no-path" };
    expect(await attachClaudeTranscriptTurn(noPath)).toBe(noPath);

    expect(await attachClaudeTranscriptTurn("not a payload")).toBe("not a payload");
    expect(await attachClaudeTranscriptTurn(null)).toBeNull();
  });
});

describe("Claude Code generations: model from the session, usage from the harness", () => {
  const SESSION = "ses-model-memory-0001";
  const base = { session_id: SESSION, transcript_path: "/workspace/contract-repo/session.jsonl", cwd: "/workspace/contract-repo" };
  const sessionStart = (model?: string) => ({
    ...base,
    hook_event_name: "SessionStart",
    source: "startup",
    ...(model === undefined ? {} : { model }),
  });
  const stopFor = (promptId: string, extra: Record<string, unknown> = {}) => ({
    ...base,
    hook_event_name: "Stop",
    prompt_id: promptId,
    stop_hook_active: false,
    ...extra,
  });

  const session = () => {
    const harness = createTestHook({ adapters: [createClaudeCodeAdapter()] });
    const ingest = async (payload: unknown): Promise<readonly CanonicalEvent[]> =>
      (await harness.hook.ingest({ payload, transport: "hook-stdin", providerHint: "claude-code" })).events;
    return { harness, ingest };
  };

  const modelsOf = (events: readonly CanonicalEvent[]) => {
    const start = events.find((event) => event.type === "generation.start");
    const end = events.find((event) => event.type === "generation.end");
    if (start?.type !== "generation.start" || end?.type !== "generation.end") {
      throw new Error(`expected a generation, got ${events.map((event) => event.type).join(", ")}`);
    }
    return { request: start.model.modelId, response: end.model.modelId, end };
  };

  it("SessionStart then Stop: the generation carries the session's model", async () => {
    const { ingest } = session();
    await ingest(sessionStart("claude-synthetic-opus-9"));
    expect(modelsOf(await ingest(stopFor("p1")))).toMatchObject({
      request: "claude-synthetic-opus-9",
      response: "claude-synthetic-opus-9",
    });
  });

  it("keeps `unknown` only when no payload in the session ever named a model", async () => {
    const { ingest } = session();
    await ingest(sessionStart());
    expect(modelsOf(await ingest(stopFor("p1")))).toMatchObject({ request: "unknown", response: "unknown" });
  });

  it("follows a model change reported by a later SessionStart", async () => {
    const { ingest } = session();
    await ingest(sessionStart("claude-synthetic-opus-9"));
    expect(modelsOf(await ingest(stopFor("p1"))).response).toBe("claude-synthetic-opus-9");
    await ingest({ ...sessionStart("claude-synthetic-sonnet-9"), source: "resume" });
    expect(modelsOf(await ingest(stopFor("p2"))).response).toBe("claude-synthetic-sonnet-9");
  });

  it("a model attached to a Stop answers that turn and becomes the session's model", async () => {
    const { ingest } = session();
    await ingest(sessionStart("claude-synthetic-opus-9"));
    // `/model` switched mid-session: the session still says opus, the turn says sonnet.
    expect(modelsOf(await ingest(stopFor("p1", { model: "claude-synthetic-sonnet-9" })))).toMatchObject({
      request: "claude-synthetic-opus-9",
      response: "claude-synthetic-sonnet-9",
    });
    // The next turn, with nothing attached, is remembered as sonnet.
    expect(modelsOf(await ingest(stopFor("p2")))).toMatchObject({
      request: "claude-synthetic-sonnet-9",
      response: "claude-synthetic-sonnet-9",
    });
  });

  it("a subagent's model never renames the session's generations", async () => {
    const { ingest } = session();
    await ingest(sessionStart("claude-synthetic-opus-9"));
    // A generation reported from inside a subagent, with its own model attached.
    await ingest(stopFor("p1", { agent_id: "agent-synthetic-0001", agent_type: "Explore", model: "claude-synthetic-haiku-9" }));
    expect(modelsOf(await ingest(stopFor("p2"))).response).toBe("claude-synthetic-opus-9");
  });

  it("an unusable attached model is dropped, not fatal", async () => {
    const { ingest } = session();
    await ingest(sessionStart("claude-synthetic-opus-9"));
    expect(modelsOf(await ingest(stopFor("p1", { model: "m".repeat(300) }))).response).toBe("claude-synthetic-opus-9");
    expect(modelsOf(await ingest(stopFor("p2", { model: 42 }))).response).toBe("claude-synthetic-opus-9");
  });

  it("a transcript-attached Stop exports the exact model and all four token buckets", async () => {
    const file = await writeTranscript(await fixtureLines());
    const { ingest } = session();
    await ingest(sessionStart("claude-synthetic-opus-9"));
    const payload = await attachClaudeTranscriptTurn({ ...stopFor("p1"), transcript_path: file });
    const { response, end } = modelsOf(await ingest(payload));
    expect(response).toBe("claude-synthetic-opus-9");
    expect(end.usage).toMatchObject({
      temporality: "delta",
      // Canonical input is inclusive: fresh + cache read + cache creation.
      inputTokens: 3 + 118_000 + 7_400,
      cachedInputTokens: 118_000,
      cacheCreationInputTokens: 7_400,
      outputTokens: 412,
    });
  });

  it("an unreadable store costs the model name, never the generation", async () => {
    const { harness, ingest } = session();
    await ingest(sessionStart("claude-synthetic-opus-9"));
    // The sequence read and the session-model read both fail.
    harness.stateStore.failNext(2);
    const outcome = await harness.hook.ingest({ payload: stopFor("p1"), transport: "hook-stdin", providerHint: "claude-code" });
    expect(modelsOf(outcome.events).response).toBe("unknown");
    expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain("state-store-failure");
  });

  it("a redelivered SessionStart does not rewrite the remembered model", async () => {
    const { harness, ingest } = session();
    await ingest(sessionStart("claude-synthetic-opus-9"));
    await harness.hook.ingest(
      { payload: sessionStart("claude-synthetic-sonnet-9"), transport: "hook-stdin", providerHint: "claude-code" },
      { suppress: true },
    );
    expect(modelsOf(await ingest(stopFor("p1"))).response).toBe("claude-synthetic-opus-9");
  });
});
