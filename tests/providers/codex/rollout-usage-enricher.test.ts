/**
 * `providers.codex.readRolloutUsage`: Codex 0.163 puts no `usage` on any hook
 * payload, so the hook runtime reads the session's rollout at `Stop` and attaches
 * the thread's running token total.
 *
 * The rollout is fixtures/contracts/codex/rollout-0163-tool-turn.json: a real
 * Codex 0.163 `codex exec` run against the agent lab's scripted mock (see its
 * provenance), written back one record per line. Its one turn made two model
 * requests; the running total after both is 280 in (80 cache reads, 60 cache
 * writes, both inside the 280), 32 out (8 reasoning).
 */
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, readsCodexRolloutUsage, resolveConfig } from "../../../src/config/index.js";
import { parseEnvironmentConfig } from "../../../src/config/environment.js";
import { parseCliArgs } from "../../../src/cli/args.js";
import { policyFlagsToPatch } from "../../../src/cli/context.js";
import type { CanonicalEvent } from "../../../src/model/events.js";
import {
  createCodexAdapter,
  createCodexRolloutUsageEnricher,
  readCodexRolloutUsage,
  type CodexRolloutUsageEnricherOptions,
} from "../../../src/providers/index.js";
import { createTestHook } from "../../../src/testing/index.js";

const FIXTURE = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "fixtures",
  "contracts",
  "codex",
  "rollout-0163-tool-turn.json",
);

const TURN_ONE = {
  inputTokens: 280,
  cachedInputTokens: 80,
  cacheCreationInputTokens: 60,
  cacheCreationAccounting: "included-in-input",
  outputTokens: 32,
  reasoningOutputTokens: 8,
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), "otel-hook-codex-rollout-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

const SESSION = "01a217d4-ddd3-7820-aa07-6a190578204c";

const fixtureRecords = async (): Promise<Record<string, unknown>[]> =>
  (JSON.parse(await readFile(FIXTURE, "utf8")) as { records: Record<string, unknown>[] }).records;

const lines = (records: readonly unknown[]): string => `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;

/** Index of the first record after the first request's `token_count`. */
const splitAfterFirstTokenCount = (records: readonly Record<string, unknown>[]): number =>
  records.findIndex((record) => (record.payload as { type?: string } | undefined)?.type === "token_count") + 1;

/** A second turn: one request, totals moved on by `step`. */
const secondTurn = (step: { input: number; cached: number; write: number; output: number }): unknown[] => {
  const total = {
    input_tokens: 280 + step.input,
    cached_input_tokens: 80 + step.cached,
    cache_write_input_tokens: 60 + step.write,
    output_tokens: 32 + step.output,
    reasoning_output_tokens: 8,
    total_tokens: 312 + step.input + step.output,
  };
  return [
    { type: "turn_context", payload: { turn_id: "turn-2", model: "gpt-5-codex-mini" } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "<omitted>" }] } },
    { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: total, last_token_usage: total } } },
  ];
};

const session = (rolloutPath: string | undefined, options: CodexRolloutUsageEnricherOptions = {}) => {
  const harness = createTestHook({
    adapters: [createCodexAdapter()],
    payloadEnrichers: [createCodexRolloutUsageEnricher({ settleMillis: 0, ...options })],
  });
  const base = {
    session_id: SESSION,
    cwd: "/workspace/contract-repo",
    ...(rolloutPath === undefined ? {} : { transcript_path: rolloutPath }),
  };
  const send = (payload: Record<string, unknown>) =>
    harness.hook.ingest({ payload: { ...base, ...payload }, transport: "hook-stdin", providerHint: "codex" });
  const start = (source = "startup") => send({ hook_event_name: "SessionStart", source });
  const stop = async (turnId: string, extra: Record<string, unknown> = {}) => {
    const outcome = await send({ hook_event_name: "Stop", turn_id: turnId, stop_hook_active: false, ...extra });
    return { end: generationEnd(outcome.events), observations: outcome.usageObservations };
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

describe("Codex rollout usage: the running total at Stop", () => {
  it("a real 0.163 rollout: Stop gets the thread total, cache writes included, and the model", async () => {
    const dir = await tempDir();
    const file = path.join(dir, `rollout-2026-11-26T13-29-16-${SESSION}.jsonl`);
    const { start, stop } = session(file);
    await start();
    await writeFile(file, lines(await fixtureRecords()));
    const { end, observations } = await stop("turn-1");
    // The Stop payload named no model in this test; the rollout's turn_context did.
    expect(end.model.modelId).toBe("gpt-5-codex");
    expect(end.usage).toMatchObject({ temporality: "cumulative", ...TURN_ONE, providerTotalTokens: 312 });
    expect(end.usage?.uncachedInputTokens).toBe(280 - 80 - 60);
    expect(observations[0]?.delta).toMatchObject({ inputTokens: 280, cacheCreationInputTokens: 60, outputTokens: 32 });
  });

  it("each Stop is diffed against the last: the second turn counts only its own tokens", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "rollout.jsonl");
    const { start, stop } = session(file);
    await start();
    await writeFile(file, lines(await fixtureRecords()));
    await stop("turn-1");
    await appendFile(file, lines(secondTurn({ input: 500, cached: 300, write: 100, output: 40 })));
    const { end, observations } = await stop("turn-2");
    expect(end.model.modelId).toBe("gpt-5-codex-mini");
    expect(observations[0]?.delta).toMatchObject({
      inputTokens: 500,
      cachedInputTokens: 300,
      cacheCreationInputTokens: 100,
      outputTokens: 40,
    });
    expect(observations[0]?.resetDetected).toBe(false);
    // A Stop with no new model request attaches nothing rather than a repeat.
    const idle = await stop("turn-3");
    expect(idle.end.usage).toBeUndefined();
  });

  it("a snapshot the first Stop missed is caught up by the next one, never lost", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "rollout.jsonl");
    const records = await fixtureRecords();
    const cut = splitAfterFirstTokenCount(records);
    const { start, stop } = session(file);
    await start();
    // Only the first request reached disk before this Stop.
    await writeFile(file, lines(records.slice(0, cut)));
    const first = await stop("turn-1");
    expect(first.observations[0]?.delta).toMatchObject({ inputTokens: 100, outputTokens: 24 });
    await appendFile(file, lines(records.slice(cut)));
    await appendFile(file, lines(secondTurn({ input: 10, cached: 0, write: 0, output: 1 })));
    const second = await stop("turn-2");
    // 280 + 10 - 100 in, 32 + 1 - 24 out: the missed request is counted once, late.
    expect(second.observations[0]?.delta).toMatchObject({ inputTokens: 190, outputTokens: 9 });
  });

  it("waits once for a snapshot Codex has not flushed yet", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "rollout.jsonl");
    const records = await fixtureRecords();
    const { start, stop } = session(file, { settleMillis: 200 });
    await start();
    // Everything but the second request's token_usage_record, token_count and task_complete.
    const last = records.length - 3;
    await writeFile(file, lines(records.slice(0, splitAfterFirstTokenCount(records))));
    await stop("turn-0");
    await appendFile(file, lines(records.slice(splitAfterFirstTokenCount(records), last)));
    const pending = stop("turn-1");
    const late = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        appendFile(file, lines(records.slice(last))).then(resolve, reject);
      }, 50);
    });
    const [{ observations }] = await Promise.all([pending, late]);
    expect(observations[0]?.delta).toMatchObject({ inputTokens: 180, outputTokens: 8 });
  });

  it("without a cursor (enabled mid-session), the tail's last total is still exact", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "rollout.jsonl");
    await writeFile(file, lines(await fixtureRecords()));
    const { stop } = session(file);
    const { end } = await stop("turn-1");
    expect(end.usage).toMatchObject(TURN_ONE);
  });

  it("a range over the cap and a rollout that shrank both fall back to the tail", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "rollout.jsonl");
    const { start, stop } = session(file, { maxRangeBytes: 65_536 });
    await start();
    const filler = { type: "response_item", payload: { type: "message", content: "x".repeat(1_000) } };
    await writeFile(file, lines([...Array.from({ length: 100 }, () => filler), ...(await fixtureRecords())]));
    expect((await stop("turn-1")).end.usage).toMatchObject(TURN_ONE);
    await writeFile(file, lines(secondTurn({ input: 1, cached: 0, write: 0, output: 1 })));
    expect((await stop("turn-2")).end.usage).toMatchObject({ inputTokens: 281, outputTokens: 33 });
  });

  it("leaves a half-written last line for the next Stop", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "rollout.jsonl");
    const records = await fixtureRecords();
    const cut = splitAfterFirstTokenCount(records);
    // The second request's token_usage_record, the first line carrying the turn's total.
    const secondRecord = records.length - 3;
    const { start, stop } = session(file);
    await start();
    const partial = JSON.stringify(records[secondRecord]);
    await writeFile(file, lines(records.slice(0, secondRecord)) + partial.slice(0, 60));
    expect(cut).toBeLessThan(secondRecord);
    expect((await stop("turn-1")).end.usage).toMatchObject({ inputTokens: 100 });
    await appendFile(file, `${partial.slice(60)}\n${lines(records.slice(secondRecord + 1))}`);
    expect((await stop("turn-2")).end.usage).toMatchObject({ inputTokens: 280 });
  });

  it("keeps usage Codex (or a wrapper) already put on the Stop", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "rollout.jsonl");
    const { start, stop } = session(file);
    await start();
    await writeFile(file, lines(await fixtureRecords()));
    const own = { input_tokens: 7, output_tokens: 3, total_tokens: 10 };
    const { end } = await stop("turn-1", { usage: own });
    expect(end.usage).toMatchObject({ inputTokens: 7, outputTokens: 3 });
  });

  it("finds the rollout by session id when the payload names none", async () => {
    const root = await tempDir();
    const now = new Date(2026, 10, 26, 13, 30);
    const dayDir = path.join(root, "2026", "11", "25");
    await mkdir(dayDir, { recursive: true });
    await writeFile(path.join(dayDir, `rollout-2026-11-25T23-59-00-${SESSION}.jsonl`), lines(await fixtureRecords()));
    await writeFile(path.join(dayDir, "rollout-2026-11-25T23-59-00-0000-other-session.jsonl"), lines(secondTurn({ input: 1, cached: 0, write: 0, output: 1 })));
    const { stop } = session(undefined, { sessionsRoot: root, now: () => now });
    expect((await stop("turn-1")).end.usage).toMatchObject(TURN_ONE);
    // Without a sessions root, a payload naming no rollout is left alone.
    const bare = session(undefined);
    expect((await bare.stop("turn-1")).end.usage).toBeUndefined();
  });

  it("never reads a relative, non-.jsonl or missing path, and never throws", async () => {
    for (const named of ["relative/rollout.jsonl", "/workspace/rollout.txt", "/nonexistent/otel-hook/rollout.jsonl"]) {
      const { stop } = session(named);
      expect((await stop("turn-1")).end.usage).toBeUndefined();
    }
  });

  it("readCodexRolloutUsage gives a wrapping harness the last total", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "rollout.jsonl");
    await writeFile(file, lines(await fixtureRecords()));
    await expect(readCodexRolloutUsage(file)).resolves.toEqual({
      model: "gpt-5-codex",
      usage: {
        input_tokens: 280,
        cached_input_tokens: 80,
        cache_write_input_tokens: 60,
        output_tokens: 32,
        reasoning_output_tokens: 8,
        total_tokens: 312,
      },
    });
  });
});

describe("Codex rollout usage: opt-in", () => {
  it("is off by default", () => {
    expect(readsCodexRolloutUsage(DEFAULT_CONFIG)).toBe(false);
    const resolved = resolveConfig([]);
    if (resolved.status !== "ok") throw new Error("unreachable");
    expect(readsCodexRolloutUsage(resolved.config)).toBe(false);
  });

  it("is turned on by OTEL_HOOK_CODEX_ROLLOUT_USAGE, a config file, or --codex-rollout-usage", () => {
    const fromEnv = parseEnvironmentConfig({ OTEL_HOOK_CODEX_ROLLOUT_USAGE: "1" });
    expect(fromEnv.patch.providers).toEqual({ codex: { readRolloutUsage: true } });

    const resolved = resolveConfig([
      { source: "file", patch: { providers: { codex: { readRolloutUsage: true } } } },
    ]);
    if (resolved.status !== "ok") throw new Error("unreachable");
    expect(readsCodexRolloutUsage(resolved.config)).toBe(true);

    const parsed = parseCliArgs(["run", "--provider", "codex", "--codex-rollout-usage", "--claude-transcript-usage"]);
    if (parsed.status !== "command" || parsed.command.name !== "run") throw new Error("expected a run command");
    expect(policyFlagsToPatch(parsed.command.policy).providers).toEqual({
      claudeCode: { readTranscriptUsage: true },
      codex: { readRolloutUsage: true },
    });
  });
});
