import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CanonicalEvent } from "../../src/model/events.js";
import type { TargetHint } from "../../src/model/target.js";
import { createPrivacyService } from "../../src/privacy/service.js";
import { DEFAULT_CONFIG } from "../../src/config/schema.js";
import { deriveWorkspaceIdentity } from "../../src/privacy/workspace.js";
import { createEventFactory } from "../../src/providers/builder.js";
import { claudeTargetHint } from "../../src/providers/claude/target.js";
import { codexTargetHint, patchHeaderPaths } from "../../src/providers/codex/target.js";
import {
  createFilesystemWorktreeLocator,
  parseGitDirFile,
  parseHeadBranch,
} from "../../src/runtime/git-worktree.js";
import type { LocatedWorktree, WorktreeLocator } from "../../src/runtime/ports.js";
import { resolveEventTargets } from "../../src/runtime/target-resolution.js";
import {
  createDeterministicIdGenerator,
  createFixedClock,
  createRecordingLogger,
  createTestIdentity,
  createTestPrivacyService,
} from "../../src/testing/index.js";

const privacy = createPrivacyService(DEFAULT_CONFIG.privacy);

describe("git file parsing", () => {
  it("reads a branch from a symbolic HEAD and none from a detached one", () => {
    expect(parseHeadBranch("ref: refs/heads/main\n")).toBe("main");
    expect(parseHeadBranch("ref: refs/heads/feat/worktree-target\n")).toBe("feat/worktree-target");
    expect(parseHeadBranch("3f2a9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b\n")).toBeUndefined();
    expect(parseHeadBranch("ref: refs/remotes/origin/main\n")).toBeUndefined();
    expect(parseHeadBranch("ref: refs/heads/bad name\n")).toBeUndefined();
    expect(parseHeadBranch("ref: refs/heads/bad\u0001ctl\n")).toBeUndefined();
  });

  it("resolves a gitdir file against the worktree root", () => {
    expect(parseGitDirFile("gitdir: /repo/.git/worktrees/a\n", "/wt")).toBe("/repo/.git/worktrees/a");
    expect(parseGitDirFile("gitdir: ../repo/.git/worktrees/a\n", "/x/wt")).toBe(
      "/x/repo/.git/worktrees/a",
    );
    expect(parseGitDirFile("not a gitdir\n", "/wt")).toBeUndefined();
  });
});

describe("filesystem worktree locator", () => {
  let root = "";
  let main = "";
  let linked = "";
  let detached = "";
  let broken = "";

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "otel-hook-locator-"));
    main = path.join(root, "repo");
    linked = path.join(root, "repo-slot");
    detached = path.join(root, "repo-detached");
    broken = path.join(root, "repo-broken");
    await mkdir(path.join(main, ".git", "worktrees", "slot"), { recursive: true });
    await mkdir(path.join(main, ".git", "worktrees", "detached"), { recursive: true });
    await mkdir(path.join(main, "src", "deep"), { recursive: true });
    await mkdir(path.join(linked, "src"), { recursive: true });
    await mkdir(detached, { recursive: true });
    await mkdir(path.join(broken, "src"), { recursive: true });
    await writeFile(path.join(main, ".git", "HEAD"), "ref: refs/heads/main\n");
    await writeFile(path.join(main, ".git", "worktrees", "slot", "HEAD"), "ref: refs/heads/slot-branch\n");
    await writeFile(
      path.join(main, ".git", "worktrees", "detached", "HEAD"),
      "0123456789abcdef0123456789abcdef01234567\n",
    );
    // Relative gitdir, as `git worktree add --relative-paths` writes it.
    await writeFile(path.join(linked, ".git"), "gitdir: ../repo/.git/worktrees/slot\n");
    await writeFile(path.join(detached, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "detached")}\n`);
    await writeFile(path.join(broken, ".git"), "gitdir: /nonexistent/otel-hook/gitdir\n");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("finds the main worktree for a nested, not-yet-existing file", async () => {
    const located = await createFilesystemWorktreeLocator().locate(
      path.join(main, "src", "deep", "new-file.ts"),
    );
    expect(located).toEqual({ root: main, branch: "main" });
  });

  it("finds a linked worktree through its .git file, not the repository it belongs to", async () => {
    const located = await createFilesystemWorktreeLocator().locate(path.join(linked, "src", "a.ts"));
    expect(located).toEqual({ root: linked, branch: "slot-branch" });
  });

  it("reports a detached HEAD as a worktree without a branch", async () => {
    expect(await createFilesystemWorktreeLocator().locate(detached)).toEqual({ root: detached });
  });

  it("does not skip a broken worktree to reach an enclosing one", async () => {
    expect(await createFilesystemWorktreeLocator().locate(path.join(broken, "src"))).toBeUndefined();
  });

  it("answers undefined outside any repository and for relative input", async () => {
    const locator = createFilesystemWorktreeLocator();
    expect(await locator.locate(path.join(root, "elsewhere", "file.txt"))).toBeUndefined();
    expect(await locator.locate("relative/file.ts")).toBeUndefined();
    expect(await locator.locate("/bad\u0000path")).toBeUndefined();
  });

  it("caches a probe for its TTL, then sees a switched branch", async () => {
    let now = 0;
    const locator = createFilesystemWorktreeLocator({ monotonicMillis: () => now, cacheTtlMillis: 100 });
    const head = path.join(main, ".git", "HEAD");
    expect((await locator.locate(main))?.branch).toBe("main");
    await writeFile(head, "ref: refs/heads/switched\n");
    now = 50;
    expect((await locator.locate(main))?.branch).toBe("main");
    now = 200;
    expect((await locator.locate(main))?.branch).toBe("switched");
    await writeFile(head, "ref: refs/heads/main\n");
  });

  const gitAvailable = (() => {
    try {
      execFileSync("git", ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!gitAvailable)("agrees with git itself on a real `git worktree add`", async () => {
    const realRoot = await mkdtemp(path.join(tmpdir(), "otel-hook-realgit-"));
    try {
      const repo = path.join(realRoot, "checkout");
      const worktree = path.join(realRoot, "checkout-slot-1");
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
      await mkdir(repo);
      git(repo, "init", "-q", "-b", "trunk");
      git(repo, "commit", "-q", "--allow-empty", "-m", "init");
      git(repo, "worktree", "add", "-q", "-b", "har-agent-1", worktree);
      const locator = createFilesystemWorktreeLocator();
      expect(await locator.locate(path.join(worktree, "src", "x.ts"))).toEqual({
        root: worktree,
        branch: "har-agent-1",
      });
      expect(await locator.locate(path.join(repo, "README.md"))).toEqual({ root: repo, branch: "trunk" });
    } finally {
      await rm(realRoot, { recursive: true, force: true });
    }
  });
});

describe("resolveEventTargets", () => {
  const identity = createTestIdentity();
  const context = {
    privacy: createTestPrivacyService(),
    clock: createFixedClock(),
    ids: createDeterministicIdGenerator({ namespace: "t" }),
    logger: createRecordingLogger("debug"),
    limits: DEFAULT_CONFIG.privacy.limits,
  };

  const toolEvents = (hint: TargetHint | undefined) => {
    const factory = createEventFactory({ identity, sequenceBase: 0, context });
    factory.build({
      type: "tool.start",
      toolCallId: "call-1",
      toolName: "Edit",
      toolKind: "write",
      ...(hint === undefined ? {} : { targetHint: hint }),
    });
    factory.build({ type: "session.start", sessionKind: "unknown" });
    return { events: factory.events(), hints: factory.targetHints() };
  };

  const fakeLocator = (table: Record<string, LocatedWorktree>, delayMillis = 0): WorktreeLocator => ({
    locate: async (absolutePath) => {
      if (delayMillis > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMillis));
      }
      const prefix = Object.keys(table).find((candidate) => absolutePath.startsWith(candidate));
      return prefix === undefined ? undefined : table[prefix];
    },
  });

  const resolve = (
    hint: TargetHint | undefined,
    locator: WorktreeLocator,
    budgetMillis = 1_000,
  ): Promise<{ readonly events: readonly CanonicalEvent[]; readonly timedOut: boolean }> => {
    const { events, hints } = toolEvents(hint);
    return resolveEventTargets({ events, hints, locator, privacy, budgetMillis });
  };

  const targetOf = (events: readonly CanonicalEvent[]) => {
    const [first] = events;
    return first?.type === "tool.start" ? first.target : undefined;
  };

  it("derives the target exactly like a git-root workspace identity", async () => {
    const { events } = await resolve(
      { source: "tool-path", paths: ["src/a.ts"], baseDirectory: "/w/slot" },
      fakeLocator({ "/w/slot": { root: "/w/slot", branch: "har-slot" } }),
    );
    expect(targetOf(events)).toEqual({
      workspaceId: deriveWorkspaceIdentity(privacy, { kind: "git-root", absolutePath: "/w/slot" })
        .workspaceId,
      vcsBranchName: "har-slot",
      source: "tool-path",
    });
    // Only tool events are ever touched.
    expect(events[1]).not.toHaveProperty("target");
  });

  it("gives no target when paths land in two worktrees", async () => {
    const { events } = await resolve(
      { source: "tool-path", paths: ["/w/a/x.ts", "/w/b/y.ts"] },
      fakeLocator({ "/w/a": { root: "/w/a" }, "/w/b": { root: "/w/b" } }),
    );
    expect(targetOf(events)).toBeUndefined();
  });

  it("gives no target when any path is outside a worktree", async () => {
    const { events } = await resolve(
      { source: "tool-path", paths: ["/w/a/x.ts", "/tmp/y.ts"] },
      fakeLocator({ "/w/a": { root: "/w/a" } }),
    );
    expect(targetOf(events)).toBeUndefined();
  });

  it("refuses a relative path with no base rather than resolving it against the process cwd", async () => {
    const { events } = await resolve(
      { source: "tool-path", paths: ["src/a.ts"] },
      fakeLocator({ "/": { root: "/anything" } }),
    );
    expect(targetOf(events)).toBeUndefined();
  });

  it("returns the batch without targets when the budget expires", async () => {
    const result = await resolve(
      { source: "session-cwd", paths: ["/w/a"] },
      fakeLocator({ "/w/a": { root: "/w/a" } }, 200),
      10,
    );
    expect(result.timedOut).toBe(true);
    expect(targetOf(result.events)).toBeUndefined();
  });

  it("contains a locator that throws", async () => {
    const { events } = await resolve(
      { source: "session-cwd", paths: ["/w/a"] },
      { locate: () => Promise.reject(new Error("boom")) },
    );
    expect(targetOf(events)).toBeUndefined();
  });
});

describe("event factory: target hints and subagent id", () => {
  const identity = createTestIdentity();
  const context = {
    privacy: createTestPrivacyService(),
    clock: createFixedClock(),
    ids: createDeterministicIdGenerator({ namespace: "t" }),
    logger: createRecordingLogger("debug"),
    limits: DEFAULT_CONFIG.privacy.limits,
  };

  it("keeps hints off the event and never lets a draft set a target itself", () => {
    const factory = createEventFactory({ identity, sequenceBase: 0, context, subagentId: "agent-123" });
    const forged = {
      type: "tool.end",
      toolCallId: "c",
      toolName: "Edit",
      outcome: "ok",
      target: { workspaceId: "sha256:forgedforged", source: "tool-path" },
      targetHint: { source: "tool-path", paths: ["/w/a.ts"] },
    } as unknown as Parameters<typeof factory.build>[0];
    const event = factory.build(forged);
    expect(event).not.toHaveProperty("target");
    expect(JSON.stringify(event)).not.toContain("/w/a.ts");
    expect(event.subagentId).toBe("agent-123");
    expect([...factory.targetHints().values()]).toEqual([{ source: "tool-path", paths: ["/w/a.ts"] }]);
  });

  it("drops a subagent id that is not identifier-shaped", () => {
    const factory = createEventFactory({
      identity,
      sequenceBase: 0,
      context,
      subagentId: "/home/someone/agent",
    });
    const event = factory.build({ type: "session.start", sessionKind: "unknown" });
    expect(event).not.toHaveProperty("subagentId");
  });

  it("ignores a hint on a non-tool event", () => {
    const factory = createEventFactory({ identity, sequenceBase: 0, context });
    factory.build({
      type: "session.start",
      sessionKind: "unknown",
      targetHint: { source: "session-cwd", paths: ["/w"] },
    });
    expect(factory.targetHints().size).toBe(0);
  });
});

describe("adapter hint extraction", () => {
  it("claude: reads only documented path fields of built-in tools", () => {
    expect(claudeTargetHint("Edit", { file_path: "/w/a.ts" }, "/s")).toEqual({
      source: "tool-path",
      paths: ["/w/a.ts"],
      baseDirectory: "/s",
    });
    expect(claudeTargetHint("NotebookEdit", { notebook_path: "/w/n.ipynb" }, undefined)?.source).toBe(
      "tool-path",
    );
    expect(claudeTargetHint("Grep", { pattern: "x" }, "/s")).toEqual({ source: "session-cwd", paths: ["/s"] });
    expect(claudeTargetHint("mcp__fs__read", { path: "/w/a.ts" }, "/s")?.source).toBe("session-cwd");
    expect(claudeTargetHint("__proto__", { file_path: "/w/a.ts" }, undefined)).toBeUndefined();
  });

  it("codex: parses apply_patch headers, de-duplicated and bounded", () => {
    expect(
      patchHeaderPaths(
        "*** Begin Patch\n*** Update File: a.ts\n*** Move to: b.ts\n*** Delete File: a.ts\n*** End Patch",
      ),
    ).toEqual(["a.ts", "b.ts"]);
    const many = Array.from({ length: 9 }, (_, i) => `*** Add File: f${String(i)}.ts`).join("\n");
    expect(patchHeaderPaths(many)).toBeUndefined();
    expect(patchHeaderPaths("no headers here")).toBeUndefined();
  });

  it("codex: prefers patch paths, then workdir, then the session cwd", () => {
    expect(codexTargetHint("apply_patch", { patch: "*** Add File: x.ts\n" }, "/s")).toEqual({
      source: "tool-path",
      paths: ["x.ts"],
      baseDirectory: "/s",
    });
    expect(codexTargetHint("shell", { command: ["ls"], workdir: "/w" }, "/s")).toEqual({
      source: "shell-cwd",
      paths: ["/w"],
      baseDirectory: "/s",
    });
    expect(codexTargetHint("Bash", { command: "ls" }, "/s")).toEqual({ source: "session-cwd", paths: ["/s"] });
    // An apply_patch with no nameable file is not downgraded to weaker evidence.
    expect(codexTargetHint("apply_patch", { patch: "garbage" }, "/s")).toBeUndefined();
    // Not an apply_patch invocation just because the text mentions one.
    expect(codexTargetHint("Bash", { command: "echo '*** Add File: x.ts'" }, "/s")?.source).toBe(
      "session-cwd",
    );
  });


});
