import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
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
 * session started in the main checkout, editing a file in a linked worktree, then
 * one in the main checkout. Each tool span must name its worktree's branch, salted
 * id, and kind, and both must name the same repository — and no byte of the
 * temporary directory's path may be on the wire.
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
    // Real path: git records a linked worktree's common dir resolved, and macOS's
    // temp dir is reached through a symlink.
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "otel-hook-e2e-target-")));
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
    const edit = async (toolUseId: string, filePath: string): Promise<void> => {
      const base = {
        session_id: "ses-e2e-target",
        transcript_path: path.join(checkout, ".claude", "transcript.jsonl"),
        cwd: checkout,
        tool_name: "Edit",
        tool_use_id: toolUseId,
        tool_input: { file_path: filePath, old_string: "a", new_string: "b" },
      };
      const pre = await runCliProcess(args, JSON.stringify({ ...base, hook_event_name: "PreToolUse" }));
      const post = await runCliProcess(
        args,
        JSON.stringify({ ...base, hook_event_name: "PostToolUse", tool_response: { success: true } }),
      );
      expect(pre.code).toBe(0);
      expect(post.code).toBe(0);
    };
    await edit("toolu_e2e_target_1", path.join(slot, "src", "billing.ts"));
    await edit("toolu_e2e_target_2", path.join(checkout, "src", "billing.ts"));

    const spans = decodeAllExportedSpans(
      collector.requests.filter((request) => request.path === "/v1/traces").map((request) => request.body),
    ).filter((span) => span.name === "tool Edit");
    expect(spans).toHaveLength(2);
    const linked = spans.find((span) => span.attributes["gen_ai.tool.call.id"] === "toolu_e2e_target_1");
    const main = spans.find((span) => span.attributes["gen_ai.tool.call.id"] === "toolu_e2e_target_2");
    expect(linked?.attributes["vcs.ref.head.name"]).toBe("har-agent-3");
    expect(linked?.attributes["otelhook.target.source"]).toBe("tool-path");
    expect(String(linked?.attributes["otelhook.target.workspace.id"])).toMatch(/^[a-z0-9]+:[A-Za-z0-9_-]+$/);
    expect(linked?.attributes["otelhook.target.workspace.id"]).not.toBe(
      linked?.attributes["otelhook.workspace.id"],
    );
    expect(linked?.attributes["otelhook.target.worktree.kind"]).toBe("linked");
    expect(main?.attributes["vcs.ref.head.name"]).toBe("main");
    expect(main?.attributes["otelhook.target.worktree.kind"]).toBe("main");
    // One repository: the main checkout names it by its own workspace id, and the
    // linked worktree points at that same id without the consumer reading `.git`.
    expect(main?.attributes["otelhook.target.repository.id"]).toBe(
      main?.attributes["otelhook.target.workspace.id"],
    );
    expect(linked?.attributes["otelhook.target.repository.id"]).toBe(
      main?.attributes["otelhook.target.workspace.id"],
    );

    const records = decodeAllExportedLogRecords(
      collector.requests.filter((request) => request.path === "/v1/logs").map((request) => request.body),
    );
    expect(records.some((record) => record.attributes["vcs.ref.head.name"] === "har-agent-3")).toBe(true);

    // Raw protobuf bodies as text: a path would appear verbatim if it were sent.
    expect(collector.text()).not.toContain(root);
  }, 60_000);
});
