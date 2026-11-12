import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  ensureBuiltCli,
  makeStateDir,
  runCliProcess,
  startCollector,
  type Collector,
} from "./harness.js";
import { decodeAllExportedLogRecords, decodeAllExportedSpans } from "../helpers/otlp.js";

/**
 * ADR 0008 through the built CLI, against a worktree made by `git` itself: two
 * hook processes (a Claude Code `PreToolUse` and its `PostToolUse`) fired from a
 * session started in the main checkout, editing a file in a linked worktree. The
 * one exported tool span must name the worktree's branch and salted id — and no
 * byte of the temporary directory's path may be on the wire.
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

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const git = (cwd: string, ...args: string[]): void => {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  });
};

describe.skipIf(!gitAvailable)("otel-hook run: per-event worktree target", () => {
  it("exports the edited file's worktree on the tool span, never its path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "otel-hook-e2e-target-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const checkout = path.join(root, "checkout");
    const slot = path.join(root, "checkout-slot-3");
    await mkdir(checkout);
    git(checkout, "init", "-q", "-b", "main");
    git(checkout, "commit", "-q", "--allow-empty", "-m", "init");
    git(checkout, "worktree", "add", "-q", "-b", "har-agent-3", slot);

    const collector: Collector = await startCollector();
    cleanups.push(() => collector.close());
    const state = await makeStateDir();
    cleanups.push(() => state.remove());

    const base = {
      session_id: "ses-e2e-target",
      transcript_path: path.join(checkout, ".claude", "transcript.jsonl"),
      cwd: checkout,
      tool_name: "Edit",
      tool_use_id: "toolu_e2e_target_1",
      tool_input: { file_path: path.join(slot, "src", "billing.ts"), old_string: "a", new_string: "b" },
    };
    const args = [
      "run",
      "--provider",
      "claude-code",
      "--endpoint",
      collector.url,
      "--logs",
      "--state-dir",
      state.dir,
    ];
    const pre = await runCliProcess(args, JSON.stringify({ ...base, hook_event_name: "PreToolUse" }));
    const post = await runCliProcess(
      args,
      JSON.stringify({ ...base, hook_event_name: "PostToolUse", tool_response: { success: true } }),
    );
    expect(pre.code).toBe(0);
    expect(post.code).toBe(0);

    const spans = decodeAllExportedSpans(
      collector.requests.filter((request) => request.path === "/v1/traces").map((request) => request.body),
    ).filter((span) => span.name === "tool Edit");
    expect(spans).toHaveLength(1);
    const [span] = spans;
    expect(span?.attributes["vcs.ref.head.name"]).toBe("har-agent-3");
    expect(span?.attributes["otelhook.target.source"]).toBe("tool-path");
    expect(String(span?.attributes["otelhook.target.workspace.id"])).toMatch(/^[a-z0-9]+:[A-Za-z0-9_-]+$/);
    expect(span?.attributes["otelhook.target.workspace.id"]).not.toBe(
      span?.attributes["otelhook.workspace.id"],
    );

    const records = decodeAllExportedLogRecords(
      collector.requests.filter((request) => request.path === "/v1/logs").map((request) => request.body),
    );
    expect(records.some((record) => record.attributes["vcs.ref.head.name"] === "har-agent-3")).toBe(true);

    // Raw protobuf bodies as text: a path would appear verbatim if it were sent.
    expect(collector.text()).not.toContain(root);
  }, 60_000);
});
