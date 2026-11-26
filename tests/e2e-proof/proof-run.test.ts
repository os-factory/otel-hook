import { execFileSync } from "node:child_process";
import { appendFile, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { attachClaudeTranscriptTurn } from "../../src/providers/index.js";
import { CLI_PATH, ensureBuiltCli } from "../e2e/harness.js";
import { detailsOf, makeTempDir, runChecker, runNode, startReceiverProcess, statusOf } from "./harness.js";

/**
 * A miniature proof run, offline: the built CLI handles one synthetic Claude Code
 * session (start, prompt, one Read tool call, stop with usage, end) in a git
 * checkout, with the launcher's profile in `OTEL_RESOURCE_ATTRIBUTES` the way a
 * HAR 2.0 slot would set it, exporting both signals over OTLP/protobuf to the
 * disk receiver, whose first logs request is rejected with a 503. The evidence
 * checker must then pass every mechanical row against the capture, including
 * spool replay, and find no byte of the checkout's path on the wire.
 *
 * The real runs (a live agent, HAR, Langfuse) follow docs/e2e-proof.md; this test
 * keeps the receiver, the exporter and the checker agreeing on the wire format.
 */

const gitAvailable = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

beforeAll(async () => {
  await ensureBuiltCli();
}, 300_000);

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const LAUNCHER_SESSION = "har-proof-run-session-0001";
const PROVIDER_SESSION = "ses-proof-run-provider-0001";
const WORK_UNIT = "otel-hook-56-synthetic";
const PROMPT_SECRET = "proof-run-prompt-secret-do-not-export";

describe.skipIf(!gitAvailable)("e2e proof: receiver capture → evidence checker", () => {
  it("passes the mechanical matrix rows for a synthetic Claude Code session", async () => {
    const temp = await makeTempDir("otel-hook-proof-run-");
    cleanups.push(() => temp.remove());
    const root = await realpath(temp.dir);
    const checkout = path.join(root, "sandbox");
    await mkdir(checkout);
    execFileSync("git", ["init", "-q", "-b", "proof/synthetic"], { cwd: checkout, stdio: "ignore" });

    const captureDir = path.join(root, "capture");
    const receiver = await startReceiverProcess(["--capture-dir", captureDir, "--fail-first", "1", "--fail-signal", "logs"]);
    cleanups.push(async () => {
      if (receiver.child.exitCode === null) {
        await receiver.stop();
      }
    });

    const base = { session_id: PROVIDER_SESSION, transcript_path: path.join(checkout, "transcript.jsonl"), cwd: checkout };
    const widget = path.join(checkout, "widget.txt");
    const events = [
      { ...base, hook_event_name: "SessionStart", source: "startup", model: "claude-synthetic" },
      { ...base, hook_event_name: "UserPromptSubmit", prompt_id: "prompt-1", prompt: PROMPT_SECRET },
      { ...base, hook_event_name: "PreToolUse", prompt_id: "prompt-1", tool_use_id: "toolu_proof_1", tool_name: "Read", tool_input: { file_path: widget } },
      { ...base, hook_event_name: "PostToolUse", prompt_id: "prompt-1", tool_use_id: "toolu_proof_1", tool_name: "Read", tool_input: { file_path: widget }, tool_response: { ok: true } },
      {
        ...base,
        hook_event_name: "Stop",
        prompt_id: "prompt-1",
        last_assistant_message: "READY",
        usage: { input_tokens: 120, output_tokens: 8, cache_read_input_tokens: 80, cache_creation_input_tokens: 0 },
      },
      { ...base, hook_event_name: "SessionEnd", end_reason: "other" },
    ];
    const resourceAttributes = [
      `session.id=${LAUNCHER_SESSION}`,
      `factory.work_unit.id=${WORK_UNIT}`,
      "factory.work_unit.source=github",
      "factory.producer.name=har",
      "vcs.repository.url.full=https://example.invalid/sandbox.git",
      "vcs.ref.head.name=proof/synthetic",
    ].join(",");

    for (const event of events) {
      const result = await runNode(
        [
          CLI_PATH,
          "run",
          "--provider",
          "claude-code",
          "--endpoint",
          receiver.tracesUrl,
          "--logs",
          "--logs-endpoint",
          receiver.logsUrl,
          "--state-dir",
          path.join(root, "state"),
        ],
        { stdin: JSON.stringify(event), env: { OTEL_RESOURCE_ATTRIBUTES: resourceAttributes } },
      );
      expect(result.code).toBe(0);
    }
    await receiver.stop();

    const { code, result, stdout } = await runChecker([
      captureDir,
      "--provider",
      "claude-code",
      "--session-id",
      LAUNCHER_SESSION,
      "--work-unit-id",
      WORK_UNIT,
      "--expect-tool",
      "Read",
      // Claude Code's input count excludes cache reads; otel-hook's includes them.
      "--expect-usage",
      "input=200,output=8,cache_read=80",
      "--forbid",
      root,
      "--forbid",
      PROMPT_SECRET,
    ]);

    expect({ code, failed: result?.checks.filter((entry) => entry.status === "fail") }).toEqual({ code: 0, failed: [] });
    for (const id of ["session-span", "profile-attributes", "tool-spans", "token-usage", "logs-signal", "privacy"]) {
      expect({ id, status: statusOf(result, id) }).toEqual({ id, status: "pass" });
    }
    // The injected 503 hit a non-empty logs batch, and the spool delivered it later.
    expect(statusOf(result, "spool-replay")).toBe("pass");
    expect(detailsOf(result, "spool-replay")).toContain("every rejected record arrived later");
    expect(stdout).not.toContain(root);
  }, 120_000);

  /**
   * Issue #64: Claude Code's `Stop` carries neither a model nor tokens. With the
   * harness contract on — the wrapper attaches the transcript's last assistant
   * message with `attachClaudeTranscriptTurn` — the exported generation must name
   * the exact model and carry all four token buckets, and `token-usage` must pass.
   * The transcript is the synthetic contract fixture, one record per line.
   */
  it("exports the model and token usage a wrapper attaches from the transcript", async () => {
    const temp = await makeTempDir("otel-hook-proof-transcript-");
    cleanups.push(() => temp.remove());
    const root = await realpath(temp.dir);
    const checkout = path.join(root, "sandbox");
    await mkdir(checkout);
    execFileSync("git", ["init", "-q", "-b", "proof/synthetic"], { cwd: checkout, stdio: "ignore" });

    const fixture = path.resolve(import.meta.dirname, "..", "..", "fixtures", "contracts", "claude-code", "transcript-tail-turn.json");
    const { records } = JSON.parse(await readFile(fixture, "utf8")) as { records: unknown[] };
    const transcriptPath = path.join(root, "transcript.jsonl");
    await writeFile(transcriptPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);

    const captureDir = path.join(root, "capture");
    const receiver = await startReceiverProcess(["--capture-dir", captureDir]);
    cleanups.push(async () => {
      if (receiver.child.exitCode === null) {
        await receiver.stop();
      }
    });

    const base = { session_id: "ses-proof-transcript-0001", transcript_path: transcriptPath, cwd: checkout };
    const events = [
      { ...base, hook_event_name: "SessionStart", source: "startup", model: "claude-synthetic-opus-9" },
      { ...base, hook_event_name: "UserPromptSubmit", prompt_id: "prompt-1", prompt: PROMPT_SECRET },
      { ...base, hook_event_name: "Stop", prompt_id: "prompt-1", stop_hook_active: false, last_assistant_message: "READY" },
      { ...base, hook_event_name: "SessionEnd", reason: "other" },
    ];
    for (const event of events) {
      const payload = await attachClaudeTranscriptTurn(event);
      const result = await runNode(
        [CLI_PATH, "run", "--provider", "claude-code", "--endpoint", receiver.tracesUrl, "--state-dir", path.join(root, "state")],
        { stdin: JSON.stringify(payload), env: { OTEL_RESOURCE_ATTRIBUTES: `session.id=${LAUNCHER_SESSION}` } },
      );
      expect(result.code).toBe(0);
    }
    await receiver.stop();

    const { result } = await runChecker([
      captureDir,
      "--provider",
      "claude-code",
      "--session-id",
      LAUNCHER_SESSION,
      // Canonical input includes cache reads and writes: 3 + 118,000 + 7,400.
      "--expect-usage",
      "input=125403,output=412,cache_read=118000,cache_creation=7400",
      "--forbid",
      PROMPT_SECRET,
    ]);
    expect({ id: "token-usage", status: statusOf(result, "token-usage"), details: detailsOf(result, "token-usage") }).toMatchObject({
      status: "pass",
    });
    expect(statusOf(result, "privacy")).toBe("pass");

    const spans: { name: string; attributes: Record<string, unknown> }[] = [];
    for (const name of (await readdir(captureDir)).filter((entry) => /^\d+-traces\.json$/.test(entry))) {
      const meta = JSON.parse(await readFile(path.join(captureDir, name), "utf8")) as {
        decoded: { spans: { name: string; attributes: Record<string, unknown> }[] } | null;
      };
      spans.push(...(meta.decoded?.spans ?? []));
    }
    const generation = spans.find((span) => span.attributes["gen_ai.operation.name"] === "chat");
    expect(generation?.name).toBe("generation claude-synthetic-opus-9");
    expect(generation?.attributes).toMatchObject({
      "gen_ai.request.model": "claude-synthetic-opus-9",
      "gen_ai.response.model": "claude-synthetic-opus-9",
      "gen_ai.usage.output_tokens": 412,
      "gen_ai.usage.cache_read.input_tokens": 118000,
      "gen_ai.usage.cache_creation.input_tokens": 7400,
      "otelhook.usage.partial": true,
    });
  }, 120_000);

  /**
   * The same session with `--claude-transcript-usage` and no wrapper: otel-hook
   * itself records the transcript's end at SessionStart and sums every request of
   * the turn at Stop, so the generation carries the exact turn total.
   */
  it("sums the turn itself with --claude-transcript-usage", async () => {
    const temp = await makeTempDir("otel-hook-proof-transcript-flag-");
    cleanups.push(() => temp.remove());
    const root = await realpath(temp.dir);
    const checkout = path.join(root, "sandbox");
    await mkdir(checkout);
    execFileSync("git", ["init", "-q", "-b", "proof/synthetic"], { cwd: checkout, stdio: "ignore" });

    const fixture = path.resolve(import.meta.dirname, "..", "..", "fixtures", "contracts", "claude-code", "transcript-tail-turn.json");
    const { records } = JSON.parse(await readFile(fixture, "utf8")) as { records: unknown[] };
    const transcriptPath = path.join(root, "transcript.jsonl");

    const captureDir = path.join(root, "capture");
    const receiver = await startReceiverProcess(["--capture-dir", captureDir]);
    cleanups.push(async () => {
      if (receiver.child.exitCode === null) {
        await receiver.stop();
      }
    });

    const base = { session_id: "ses-proof-transcript-0002", transcript_path: transcriptPath, cwd: checkout };
    const run = async (event: Record<string, unknown>): Promise<void> => {
      const result = await runNode(
        [
          CLI_PATH,
          "run",
          "--provider",
          "claude-code",
          "--claude-transcript-usage",
          "--endpoint",
          receiver.tracesUrl,
          "--state-dir",
          path.join(root, "state"),
        ],
        { stdin: JSON.stringify(event), env: { OTEL_RESOURCE_ATTRIBUTES: `session.id=${LAUNCHER_SESSION}` } },
      );
      expect(result.code).toBe(0);
    };
    // The transcript does not exist yet at startup; the turn is written before Stop.
    await run({ ...base, hook_event_name: "SessionStart", source: "startup", model: "claude-synthetic-opus-9" });
    await appendFile(transcriptPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    await run({ ...base, hook_event_name: "Stop", prompt_id: "prompt-1", stop_hook_active: false, last_assistant_message: "READY" });
    await run({ ...base, hook_event_name: "SessionEnd", reason: "other" });
    await receiver.stop();

    // Both requests of the turn: 0001 (5 + 1,000 + 200 in, 20 out) and 0002.
    const { result } = await runChecker([
      captureDir,
      "--provider",
      "claude-code",
      "--session-id",
      LAUNCHER_SESSION,
      "--expect-usage",
      "input=126608,output=432,cache_read=119000,cache_creation=7600",
    ]);
    expect({ status: statusOf(result, "token-usage"), details: detailsOf(result, "token-usage") }).toMatchObject({
      status: "pass",
    });
    expect(statusOf(result, "privacy")).toBe("pass");

    const spans: { name: string; attributes: Record<string, unknown> }[] = [];
    for (const name of (await readdir(captureDir)).filter((entry) => /^\d+-traces\.json$/.test(entry))) {
      const meta = JSON.parse(await readFile(path.join(captureDir, name), "utf8")) as {
        decoded: { spans: { name: string; attributes: Record<string, unknown> }[] } | null;
      };
      spans.push(...(meta.decoded?.spans ?? []));
    }
    const generation = spans.find((span) => span.attributes["gen_ai.operation.name"] === "chat");
    expect(generation?.name).toBe("generation claude-synthetic-opus-9");
    expect(generation?.attributes).toMatchObject({
      "gen_ai.response.model": "claude-synthetic-opus-9",
      "gen_ai.usage.output_tokens": 432,
      "otelhook.usage.partial": false,
    });
  }, 120_000);
  /**
   * Issue #68: a turn that spawns a subagent. The subagent's requests are in its
   * own transcript, which `SubagentStop` names; with `--claude-transcript-usage`
   * otel-hook sums them onto the subagent's own generation (its own model), the
   * parent turn keeps exactly its own requests, and the session total on spans
   * and on the token-usage metric is the sum of both, counted once.
   */
  it("counts a subagent's tokens once, on the subagent's generation, with --claude-transcript-usage", async () => {
    const temp = await makeTempDir("otel-hook-proof-transcript-subagent-");
    cleanups.push(() => temp.remove());
    const root = await realpath(temp.dir);
    const checkout = path.join(root, "sandbox");
    await mkdir(checkout);
    execFileSync("git", ["init", "-q", "-b", "proof/synthetic"], { cwd: checkout, stdio: "ignore" });

    const contracts = path.resolve(import.meta.dirname, "..", "..", "fixtures", "contracts", "claude-code");
    const lines = async (name: string): Promise<string> => {
      const { records } = JSON.parse(await readFile(path.join(contracts, name), "utf8")) as { records: unknown[] };
      return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
    };
    const transcriptPath = path.join(root, "transcript.jsonl");
    const agentTranscriptPath = path.join(root, "subagents", "agent-contract-0001.jsonl");
    await mkdir(path.dirname(agentTranscriptPath));

    const captureDir = path.join(root, "capture");
    const receiver = await startReceiverProcess(["--capture-dir", captureDir]);
    cleanups.push(async () => {
      if (receiver.child.exitCode === null) {
        await receiver.stop();
      }
    });

    const base = { session_id: "ses-proof-transcript-0003", transcript_path: transcriptPath, cwd: checkout };
    const run = async (event: Record<string, unknown>): Promise<void> => {
      const result = await runNode(
        [
          CLI_PATH,
          "run",
          "--provider",
          "claude-code",
          "--claude-transcript-usage",
          "--endpoint",
          receiver.tracesUrl,
          "--metrics",
          "--metrics-endpoint",
          receiver.tracesUrl.replace(/\/v1\/traces$/, "/v1/metrics"),
          "--state-dir",
          path.join(root, "state"),
        ],
        { stdin: JSON.stringify(event), env: { OTEL_RESOURCE_ATTRIBUTES: `session.id=${LAUNCHER_SESSION}` } },
      );
      expect(result.code).toBe(0);
    };
    await run({ ...base, hook_event_name: "SessionStart", source: "startup", model: "claude-synthetic-opus-9" });
    await run({ ...base, hook_event_name: "SubagentStart", agent_id: "agent-contract-0001", agent_type: "Explore" });
    await appendFile(agentTranscriptPath, await lines("subagent-transcript-turn.json"));
    await run({
      ...base,
      hook_event_name: "SubagentStop",
      agent_id: "agent-contract-0001",
      agent_type: "Explore",
      agent_transcript_path: agentTranscriptPath,
      stop_hook_active: false,
    });
    await appendFile(transcriptPath, await lines("transcript-tail-turn.json"));
    await run({ ...base, hook_event_name: "Stop", prompt_id: "prompt-1", stop_hook_active: false, last_assistant_message: "READY" });
    await run({ ...base, hook_event_name: "SessionEnd", reason: "other" });
    await receiver.stop();

    // Parent turn: input=126608, output=432, cache_read=119000, cache_creation=7600.
    // Subagent: input=7+2000+500+4+2600+300=5411, output=280, cache_read=4600, cache_creation=800.
    const { result } = await runChecker([
      captureDir,
      "--provider",
      "claude-code",
      "--session-id",
      LAUNCHER_SESSION,
      "--expect-usage",
      "input=132019,output=712,cache_read=123600,cache_creation=8400",
      "--expect-metric",
      "gen_ai.client.token.usage",
    ]);
    expect({ status: statusOf(result, "token-usage"), details: detailsOf(result, "token-usage") }).toMatchObject({
      status: "pass",
    });
    expect({ status: statusOf(result, "metrics"), details: detailsOf(result, "metrics") }).toMatchObject({
      status: "pass",
    });
    expect(detailsOf(result, "metrics")).toContain("metric token totals match the agent-reported totals");
    expect(statusOf(result, "privacy")).toBe("pass");

    const spans: { name: string; attributes: Record<string, unknown> }[] = [];
    for (const name of (await readdir(captureDir)).filter((entry) => /^\d+-traces\.json$/.test(entry))) {
      const meta = JSON.parse(await readFile(path.join(captureDir, name), "utf8")) as {
        decoded: { spans: { name: string; attributes: Record<string, unknown> }[] } | null;
      };
      spans.push(...(meta.decoded?.spans ?? []));
    }
    const generations = spans.filter((span) => span.attributes["gen_ai.operation.name"] === "chat");
    const subagent = generations.find((span) => span.attributes["otelhook.subagent.id"] === "agent-contract-0001");
    const parent = generations.find((span) => span.attributes["otelhook.subagent.id"] === undefined);
    expect(subagent?.name).toBe("generation claude-synthetic-haiku-9");
    expect(subagent?.attributes).toMatchObject({
      "gen_ai.response.model": "claude-synthetic-haiku-9",
      "gen_ai.usage.output_tokens": 280,
      "otelhook.usage.partial": false,
    });
    expect(parent?.name).toBe("generation claude-synthetic-opus-9");
    expect(parent?.attributes).toMatchObject({ "gen_ai.usage.output_tokens": 432, "otelhook.usage.partial": false });
    const subagentSpan = spans.find((span) => span.name === "subagent");
    expect(subagentSpan?.attributes["gen_ai.usage.output_tokens"]).toBeUndefined();
  }, 120_000);
});
