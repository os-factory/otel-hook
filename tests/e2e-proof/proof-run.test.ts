import { execFileSync } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import * as path from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

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
});
