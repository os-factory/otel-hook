/**
 * `providers.claudeCode.readTranscriptUsage`: the hook runtime sums each turn's
 * model requests from a byte cursor it keeps per session (issue #64).
 *
 * The transcript is the synthetic contract fixture
 * fixtures/contracts/claude-code/transcript-tail-turn.json, written one record per
 * line. Its turn holds two main-thread requests (msg_contract_0001 and
 * msg_contract_0002), plus a sidechain and a `<synthetic>` record that must not
 * be counted.
 */
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, readsClaudeTranscriptUsage, resolveConfig } from "../../../src/config/index.js";
import { parseEnvironmentConfig } from "../../../src/config/environment.js";
import type { CanonicalEvent } from "../../../src/model/events.js";
import {
  createClaudeCodeAdapter,
  createClaudeTranscriptUsageEnricher,
  readClaudeTranscriptRange,
  type ClaudeTranscriptUsageEnricherOptions,
} from "../../../src/providers/index.js";
import { createTestHook } from "../../../src/testing/index.js";
import { policyFlagsToPatch } from "../../../src/cli/context.js";
import { parseCliArgs } from "../../../src/cli/args.js";

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

/** The fixture turn's two requests, summed. */
const TURN_TOTAL = {
  inputTokens: 5 + 1_000 + 200 + (3 + 118_000 + 7_400),
  cachedInputTokens: 1_000 + 118_000,
  cacheCreationInputTokens: 200 + 7_400,
  outputTokens: 20 + 412,
};
/** The last request alone. */
const LAST_REQUEST = {
  inputTokens: 3 + 118_000 + 7_400,
  cachedInputTokens: 118_000,
  cacheCreationInputTokens: 7_400,
  outputTokens: 412,
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const tempTranscript = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), "otel-hook-claude-enricher-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return path.join(dir, "session.jsonl");
};

const turnLines = async (): Promise<string[]> => {
  const { records } = JSON.parse(await readFile(FIXTURE, "utf8")) as { records: Record<string, unknown>[] };
  // Claude Code writes one record per content block, each repeating the
  // request's usage; an earlier streaming snapshot of msg_contract_0002 with a
  // smaller output count must be superseded by its final record, not added.
  const finalRecord = records[3] as { message: { usage: Record<string, unknown> } };
  const snapshot = structuredClone(finalRecord);
  snapshot.message.usage = { ...snapshot.message.usage, output_tokens: 1 };
  const withSnapshot = [...records.slice(0, 3), snapshot, ...records.slice(3)];
  return withSnapshot.map((record) => JSON.stringify(record));
};

const appendTurn = async (file: string, lines: readonly string[]): Promise<void> => {
  await appendFile(file, `${lines.join("\n")}\n`);
};

const SESSION = "ses-enricher-0001";

const session = (transcriptPath: string, options: ClaudeTranscriptUsageEnricherOptions = {}) => {
  const harness = createTestHook({
    adapters: [createClaudeCodeAdapter()],
    payloadEnrichers: [createClaudeTranscriptUsageEnricher(options)],
  });
  const base = { session_id: SESSION, transcript_path: transcriptPath, cwd: "/workspace/contract-repo" };
  const send = async (payload: Record<string, unknown>, suppress = false) =>
    harness.hook.ingest(
      { payload: { ...base, ...payload }, transport: "hook-stdin", providerHint: "claude-code" },
      suppress ? { suppress: true } : undefined,
    );
  const start = (source = "startup") => send({ hook_event_name: "SessionStart", source, model: "claude-synthetic-opus-9" });
  const stop = async (promptId: string, extra: Record<string, unknown> = {}) => {
    const outcome = await send({ hook_event_name: "Stop", prompt_id: promptId, stop_hook_active: false, ...extra });
    return generationEnd(outcome.events);
  };
  return { harness, send, start, stop };
};

const generationEnd = (events: readonly CanonicalEvent[]) => {
  const end = events.find((event) => event.type === "generation.end");
  if (end?.type !== "generation.end") {
    throw new Error(`expected generation.end, got ${events.map((event) => event.type).join(", ")}`);
  }
  return end;
};

describe("Claude Code transcript usage: turn totals from a cursor", () => {
  it("SessionStart before the transcript exists, then Stop: the whole first turn, summed", async () => {
    const file = await tempTranscript();
    const { start, stop } = session(file);
    await start();
    await appendTurn(file, await turnLines());
    const end = await stop("p1");
    expect(end.model.modelId).toBe("claude-synthetic-opus-9");
    expect(end.usage).toMatchObject({ temporality: "delta", ...TURN_TOTAL });
    expect(end.usagePartial).toBe(false);
  });

  it("each Stop counts only what was written since the previous one", async () => {
    const file = await tempTranscript();
    const { start, stop } = session(file);
    await start();
    await appendTurn(file, await turnLines());
    await stop("p1");
    // Second turn: the same records again, with fresh request ids.
    const second = (await turnLines()).map((line) => line.replaceAll("msg_contract_", "msg_second_"));
    await appendTurn(file, second);
    const end = await stop("p2");
    expect(end.usage).toMatchObject(TURN_TOTAL);
    expect(end.usagePartial).toBe(false);
    // A stop with nothing new reports no usage rather than a repeat.
    const idle = await stop("p3");
    expect(idle.usage).toBeUndefined();
  });

  it("a resumed session does not count the history it resumed", async () => {
    const file = await tempTranscript();
    await writeFile(file, `${(await turnLines()).join("\n")}\n`);
    const { start, stop } = session(file);
    await start("resume");
    const next = (await turnLines()).map((line) => line.replaceAll("msg_contract_", "msg_resumed_"));
    await appendTurn(file, next.slice(0, 3)); // the user prompt, request 0001, its tool result
    const end = await stop("p1");
    expect(end.usage).toMatchObject({ inputTokens: 5 + 1_000 + 200, outputTokens: 20 });
    expect(end.usagePartial).toBe(false);
  });

  it("a compaction restart keeps the cursor of the turn it interrupted", async () => {
    const file = await tempTranscript();
    const { start, stop } = session(file);
    await start();
    const lines = await turnLines();
    await appendTurn(file, lines.slice(0, 3));
    await start("compact");
    await appendTurn(file, lines.slice(3));
    expect((await stop("p1")).usage).toMatchObject(TURN_TOTAL);
  });

  it("without a cursor, falls back to the last request and says it is partial", async () => {
    const file = await tempTranscript();
    await appendTurn(file, await turnLines());
    const { stop } = session(file);
    const end = await stop("p1");
    expect(end.usage).toMatchObject(LAST_REQUEST);
    expect(end.usagePartial).toBe(true);
    // The fallback moved the cursor to the end, so the next turn is exact again.
    await appendTurn(file, (await turnLines()).map((line) => line.replaceAll("msg_contract_", "msg_next_")));
    const next = await stop("p2");
    expect(next.usage).toMatchObject(TURN_TOTAL);
    expect(next.usagePartial).toBe(false);
  });

  it("a range over the cap falls back to the tail, partial", async () => {
    const file = await tempTranscript();
    const { start, stop } = session(file, { maxRangeBytes: 65_536 });
    await start();
    const filler = JSON.stringify({ type: "user", message: { content: "x".repeat(1_000) } });
    await appendTurn(file, [...Array.from({ length: 100 }, () => filler), ...(await turnLines())]);
    const end = await stop("p1");
    expect(end.usage).toMatchObject(LAST_REQUEST);
    expect(end.usagePartial).toBe(true);
  });

  it("a transcript that shrank falls back to the tail, partial", async () => {
    const file = await tempTranscript();
    const { start, stop } = session(file);
    await writeFile(file, `${(await turnLines()).join("\n")}\n`);
    await start("resume");
    await writeFile(file, `${(await turnLines()).slice(3).join("\n")}\n`);
    const end = await stop("p1");
    expect(end.usagePartial).toBe(true);
    expect(end.usage).toMatchObject(LAST_REQUEST);
  });

  it("leaves a half-written last line for the next stop", async () => {
    const file = await tempTranscript();
    const { start, stop } = session(file);
    await start();
    const lines = await turnLines();
    const finalLine = lines[4] ?? "";
    await appendFile(file, `${lines.slice(0, 4).join("\n")}\n${finalLine.slice(0, 40)}`);
    const first = await stop("p1");
    // Only msg_contract_0001 and the streaming snapshot of 0002 are complete.
    expect(first.usage).toMatchObject({ outputTokens: 20 + 1 });
    await appendFile(file, `${finalLine.slice(40)}\n`);
    const second = await stop("p2");
    expect(second.usage).toMatchObject({ outputTokens: 412 });
  });

  it("StopFailure is summed the same way", async () => {
    const file = await tempTranscript();
    const { start, send } = session(file);
    await start();
    await appendTurn(file, await turnLines());
    const outcome = await send({ hook_event_name: "StopFailure", prompt_id: "p1", error_type: "max_output_tokens" });
    expect(generationEnd(outcome.events).usage).toMatchObject(TURN_TOTAL);
  });

  it("never overrides usage a wrapper attached, and does not count it again", async () => {
    const file = await tempTranscript();
    const { start, stop } = session(file);
    await start();
    await appendTurn(file, await turnLines());
    const own = await stop("p1", { usage: { input_tokens: 1, output_tokens: 2 } });
    expect(own.usage).toMatchObject({ inputTokens: 1, outputTokens: 2 });
    expect(own.usagePartial).toBeUndefined();
    expect((await stop("p2")).usage).toBeUndefined();
  });

  it("a redelivered Stop does not move the cursor", async () => {
    const file = await tempTranscript();
    const { start, send, stop } = session(file);
    await start();
    await appendTurn(file, await turnLines());
    await send({ hook_event_name: "Stop", prompt_id: "p1", stop_hook_active: false }, true);
    expect((await stop("p1")).usage).toMatchObject(TURN_TOTAL);
  });

  it("a missing transcript at Stop attaches nothing and keeps the cursor", async () => {
    const file = await tempTranscript();
    const { start, stop } = session(file);
    await start();
    expect((await stop("p1")).usage).toBeUndefined();
    await appendTurn(file, await turnLines());
    expect((await stop("p2")).usage).toMatchObject(TURN_TOTAL);
  });

  it("without the enricher, otel-hook reads nothing", async () => {
    const file = await tempTranscript();
    await appendTurn(file, await turnLines());
    const harness = createTestHook({ adapters: [createClaudeCodeAdapter()] });
    const outcome = await harness.hook.ingest({
      payload: { hook_event_name: "Stop", session_id: SESSION, transcript_path: file, prompt_id: "p1" },
      transport: "hook-stdin",
      providerHint: "claude-code",
    });
    expect(generationEnd(outcome.events).usage).toBeUndefined();
  });
});

/**
 * Issue #68: a subagent's requests live in its own transcript
 * (`agent_transcript_path`, every record `isSidechain`), so the parent's `Stop`
 * never counts them. `SubagentStop` sums them from a cursor of their own and
 * reports them on the subagent's generation, never on the parent turn.
 */
describe("Claude Code transcript usage: subagent requests", () => {
  const SUBAGENT_FIXTURE = path.resolve(path.dirname(FIXTURE), "subagent-transcript-turn.json");
  const AGENT = "agent-contract-0001";
  /** The fixture's two subagent requests, summed. */
  const SUBAGENT_TOTAL = {
    inputTokens: 7 + 2_000 + 500 + (4 + 2_600 + 300),
    cachedInputTokens: 2_000 + 2_600,
    cacheCreationInputTokens: 500 + 300,
    outputTokens: 30 + 250,
  };
  const SUBAGENT_LAST_REQUEST = {
    inputTokens: 4 + 2_600 + 300,
    cachedInputTokens: 2_600,
    cacheCreationInputTokens: 300,
    outputTokens: 250,
  };

  const subagentLines = async (agentId = AGENT): Promise<string[]> => {
    const { records } = JSON.parse(await readFile(SUBAGENT_FIXTURE, "utf8")) as { records: Record<string, unknown>[] };
    return records.map((record) => JSON.stringify({ ...record, agentId }));
  };

  const agentTranscript = (main: string, agentId = AGENT): string =>
    path.join(path.dirname(main), `agent-${agentId}.jsonl`);

  const subagentGeneration = (events: readonly CanonicalEvent[], agentId = AGENT) => {
    const end = events.find((event) => event.type === "generation.end" && event.subagentId === agentId);
    return end?.type === "generation.end" ? end : undefined;
  };

  const subagentEnd = (events: readonly CanonicalEvent[]) => {
    const end = events.find((event) => event.type === "subagent.end");
    if (end?.type !== "subagent.end") {
      throw new Error(`expected subagent.end, got ${events.map((event) => event.type).join(", ")}`);
    }
    return end;
  };

  const subagentStop = (agentTranscriptPath: string, agentId = AGENT, extra: Record<string, unknown> = {}) => ({
    hook_event_name: "SubagentStop",
    agent_id: agentId,
    agent_type: "Explore",
    agent_transcript_path: agentTranscriptPath,
    stop_hook_active: false,
    ...extra,
  });

  it("reports the subagent's requests on its own generation and leaves the parent turn unchanged", async () => {
    const file = await tempTranscript();
    const agentFile = agentTranscript(file);
    const { start, send, stop } = session(file);
    await start();
    await send({ hook_event_name: "SubagentStart", agent_id: AGENT, agent_type: "Explore" });
    await appendTurn(agentFile, await subagentLines());
    const outcome = await send(subagentStop(agentFile));

    const generation = subagentGeneration(outcome.events);
    expect(generation?.model.modelId).toBe("claude-synthetic-haiku-9");
    expect(generation?.usage).toMatchObject({ temporality: "delta", ...SUBAGENT_TOTAL });
    expect(generation?.usagePartial).toBe(false);
    const generationStart = outcome.events.find((event) => event.type === "generation.start");
    expect(generationStart?.subagentId).toBe(AGENT);
    // Not restated on the subagent span: one record carries the subagent's tokens.
    expect(subagentEnd(outcome.events).usage).toBeUndefined();

    // The parent's turn, written meanwhile, is counted exactly as without a subagent.
    await appendTurn(file, await turnLines());
    const parent = await stop("p1");
    expect(parent.subagentId).toBeUndefined();
    expect(parent.model.modelId).toBe("claude-synthetic-opus-9");
    expect(parent.usage).toMatchObject(TURN_TOTAL);
    expect(parent.usagePartial).toBe(false);
  });

  it("a subagent's model never renames the session's own generations", async () => {
    const file = await tempTranscript();
    const agentFile = agentTranscript(file);
    const { start, send, stop } = session(file);
    await start();
    await appendTurn(agentFile, await subagentLines());
    await send(subagentStop(agentFile));
    // A turn with no transcript records falls back to the session's model.
    const parent = await stop("p1");
    expect(parent.model.modelId).toBe("claude-synthetic-opus-9");
  });

  it("a redelivered SubagentStop counts nothing again; a continued one counts only what is new", async () => {
    const file = await tempTranscript();
    const agentFile = agentTranscript(file);
    const { start, send } = session(file);
    await start();
    const lines = await subagentLines();
    await appendTurn(agentFile, lines.slice(0, 2));
    const first = await send(subagentStop(agentFile));
    expect(subagentGeneration(first.events)?.usage).toMatchObject({ outputTokens: 30 });

    const redelivered = await send(subagentStop(agentFile), true);
    expect(subagentGeneration(redelivered.events)?.usage).toBeUndefined();

    // A hook-continued stop of the same subagent: only the requests since the last one.
    await appendTurn(agentFile, lines.slice(2));
    const continued = await send(subagentStop(agentFile, AGENT, { stop_hook_active: true }));
    expect(subagentGeneration(continued.events)?.usage).toMatchObject(SUBAGENT_LAST_REQUEST);
    expect(subagentGeneration(continued.events)?.usagePartial).toBe(false);

    const idle = await send(subagentStop(agentFile, AGENT, { stop_hook_active: true }));
    expect(subagentGeneration(idle.events)).toBeUndefined();
    expect(subagentEnd(idle.events).usage).toBeUndefined();
  });

  it("keeps one cursor per subagent, apart from the session's", async () => {
    const file = await tempTranscript();
    const firstAgent = agentTranscript(file, "agent-contract-0001");
    const secondAgent = agentTranscript(file, "agent-contract-0002");
    const { start, send, stop } = session(file);
    await start();
    await appendTurn(firstAgent, await subagentLines("agent-contract-0001"));
    await appendTurn(secondAgent, await subagentLines("agent-contract-0002"));
    await appendTurn(file, await turnLines());
    const first = await send(subagentStop(firstAgent, "agent-contract-0001"));
    const second = await send(subagentStop(secondAgent, "agent-contract-0002"));
    expect(subagentGeneration(first.events, "agent-contract-0001")?.usage).toMatchObject(SUBAGENT_TOTAL);
    expect(subagentGeneration(second.events, "agent-contract-0002")?.usage).toMatchObject(SUBAGENT_TOTAL);
    expect((await stop("p1")).usage).toMatchObject(TURN_TOTAL);
  });

  it("skips records of another agent in the same file", async () => {
    const file = await tempTranscript();
    const agentFile = agentTranscript(file);
    const { start, send } = session(file);
    await start();
    await appendTurn(agentFile, [
      ...(await subagentLines()),
      ...(await subagentLines("agent-contract-other")).map((line) => line.replaceAll("msg_contract_sub_", "msg_other_")),
    ]);
    const outcome = await send(subagentStop(agentFile));
    expect(subagentGeneration(outcome.events)?.usage).toMatchObject(SUBAGENT_TOTAL);
  });

  it("a subagent transcript over the cap falls back to its last request, partial", async () => {
    const file = await tempTranscript();
    const agentFile = agentTranscript(file);
    const { start, send } = session(file, { maxRangeBytes: 65_536 });
    await start();
    const filler = JSON.stringify({ type: "user", isSidechain: true, message: { content: "x".repeat(1_000) } });
    await appendTurn(agentFile, [...Array.from({ length: 100 }, () => filler), ...(await subagentLines())]);
    const outcome = await send(subagentStop(agentFile));
    expect(subagentGeneration(outcome.events)?.usage).toMatchObject(SUBAGENT_LAST_REQUEST);
    expect(subagentGeneration(outcome.events)?.usagePartial).toBe(true);
  });

  it("without agent_transcript_path, or with an unusable one, attaches nothing", async () => {
    const file = await tempTranscript();
    const { start, send } = session(file);
    await start();
    const withoutPath: Record<string, unknown> = subagentStop("/unused.jsonl");
    delete withoutPath.agent_transcript_path;
    const bare = await send(withoutPath);
    expect(subagentGeneration(bare.events)).toBeUndefined();
    expect(subagentEnd(bare.events).usage).toBeUndefined();
    const relative = await send(subagentStop("relative/agent.jsonl", "agent-contract-0002"));
    expect(subagentGeneration(relative.events, "agent-contract-0002")).toBeUndefined();
  });

  it("usage a wrapper attached to SubagentStop is reported on the subagent's generation too", async () => {
    const file = await tempTranscript();
    const agentFile = agentTranscript(file);
    const { start, send } = session(file);
    await start();
    await appendTurn(agentFile, await subagentLines());
    const outcome = await send(subagentStop(agentFile, AGENT, { usage: { input_tokens: 1, output_tokens: 2 } }));
    expect(subagentGeneration(outcome.events)?.usage).toMatchObject({ inputTokens: 1, outputTokens: 2 });
    expect(subagentEnd(outcome.events).usage).toBeUndefined();
    // The wrapper's figure covered the file so far: the next stop does not count it again.
    const next = await send(subagentStop(agentFile, AGENT, { stop_hook_active: true }));
    expect(subagentGeneration(next.events)).toBeUndefined();
  });
});

describe("readClaudeTranscriptRange", () => {
  it("sums distinct main-thread requests and reports where it stopped", async () => {
    const file = await tempTranscript();
    const lines = await turnLines();
    await appendTurn(file, lines);
    const range = await readClaudeTranscriptRange(file, 0);
    expect(range).toMatchObject({
      status: "found",
      model: "claude-synthetic-opus-9",
      requestCount: 2,
      usage: { input_tokens: 8, output_tokens: 432, cache_read_input_tokens: 119_000, cache_creation_input_tokens: 7_600 },
    });
    if (range.status !== "found") throw new Error("unreachable");
    expect(range.endOffset).toBe(Buffer.byteLength(`${lines.join("\n")}\n`));
    expect(JSON.stringify(range)).not.toContain("Synthetic placeholder");
  });

  it("reads a subagent's sidechain records only when asked to, for that agent", async () => {
    const file = await tempTranscript();
    const { records } = JSON.parse(
      await readFile(path.resolve(path.dirname(FIXTURE), "subagent-transcript-turn.json"), "utf8"),
    ) as { records: unknown[] };
    await appendTurn(file, records.map((record) => JSON.stringify(record)));
    expect(await readClaudeTranscriptRange(file, 0)).toMatchObject({ status: "found", requestCount: 0 });
    expect(await readClaudeTranscriptRange(file, 0, { agentId: "agent-contract-0001" })).toMatchObject({
      status: "found",
      model: "claude-synthetic-haiku-9",
      requestCount: 2,
      usage: { input_tokens: 11, output_tokens: 280, cache_read_input_tokens: 4_600, cache_creation_input_tokens: 800 },
    });
    expect(await readClaudeTranscriptRange(file, 0, { agentId: "agent-contract-other" })).toMatchObject({
      status: "found",
      requestCount: 0,
    });
  });

  it("reports truncation, the cap, bad offsets, and missing files", async () => {
    const file = await tempTranscript();
    await appendTurn(file, await turnLines());
    expect(await readClaudeTranscriptRange(file, 10_000_000)).toEqual({ status: "unavailable", reason: "truncated" });
    expect(await readClaudeTranscriptRange(file, -1)).toEqual({ status: "unavailable", reason: "invalid-path" });
    expect(await readClaudeTranscriptRange(`${file}.missing.jsonl`, 0)).toEqual({
      status: "unavailable",
      reason: "unreadable",
    });
    const filler = JSON.stringify({ type: "user", message: { content: "x".repeat(1_000) } });
    await appendTurn(file, Array.from({ length: 100 }, () => filler));
    expect(await readClaudeTranscriptRange(file, 0, { maxRangeBytes: 65_536 })).toEqual({
      status: "unavailable",
      reason: "over-cap",
    });
  });
});

describe("the readTranscriptUsage setting", () => {
  it("is off by default", () => {
    expect(readsClaudeTranscriptUsage(DEFAULT_CONFIG)).toBe(false);
    const resolved = resolveConfig([]);
    if (resolved.status !== "ok") throw new Error("unreachable");
    expect(readsClaudeTranscriptUsage(resolved.config)).toBe(false);
  });

  it("is turned on by OTEL_HOOK_CLAUDE_TRANSCRIPT_USAGE, a config file, or --claude-transcript-usage", () => {
    const fromEnv = parseEnvironmentConfig({ OTEL_HOOK_CLAUDE_TRANSCRIPT_USAGE: "1" });
    expect(fromEnv.patch.providers).toEqual({ claudeCode: { readTranscriptUsage: true } });

    const resolved = resolveConfig([
      { source: "file", patch: { providers: { claudeCode: { readTranscriptUsage: true } } } },
    ]);
    if (resolved.status !== "ok") throw new Error("unreachable");
    expect(readsClaudeTranscriptUsage(resolved.config)).toBe(true);

    const parsed = parseCliArgs(["run", "--provider", "claude-code", "--claude-transcript-usage"]);
    if (parsed.status !== "command" || parsed.command.name !== "run") throw new Error("expected a run command");
    expect(policyFlagsToPatch(parsed.command.policy).providers).toEqual({ claudeCode: { readTranscriptUsage: true } });
  });
});
