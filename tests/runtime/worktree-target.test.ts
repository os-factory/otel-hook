import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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
  parseCommonDirFile,
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
    expect(parseGitDirFile("gitdir: /repo/.git/worktrees/a\n", "/wt")).toBe(
      path.resolve("/repo/.git/worktrees/a"),
    );
    expect(parseGitDirFile("gitdir: ../repo/.git/worktrees/a\n", "/x/wt")).toBe(
      path.resolve("/x/wt", "../repo/.git/worktrees/a"),
    );
    expect(parseGitDirFile("gitdir:" + " ".repeat(50_000) + "\n", "/wt")).toBeUndefined();
    expect(parseGitDirFile("not a gitdir\n", "/wt")).toBeUndefined();
  });

  it("resolves a commondir file against the git dir", () => {
    expect(parseCommonDirFile("../..\n", "/repo/.git/worktrees/a")).toBe(path.resolve("/repo/.git"));
    expect(parseCommonDirFile("/srv/bare.git\n", "/x")).toBe(path.resolve("/srv/bare.git"));
    expect(parseCommonDirFile("\n", "/x")).toBeUndefined();
    expect(parseCommonDirFile("a\u0000b\n", "/x")).toBeUndefined();
  });
});

describe("filesystem worktree locator", () => {
  let root = "";
  let main = "";
  let linked = "";
  let detached = "";
  let broken = "";
  let orphan = "";
  let bareLinked = "";
  let submodule = "";
  let inner = "";

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
    // `git worktree add` writes a commondir into every linked worktree's git dir.
    await writeFile(path.join(main, ".git", "worktrees", "slot", "commondir"), "../..\n");
    await writeFile(path.join(main, ".git", "worktrees", "detached", "commondir"), "../..\n");

    // A linked worktree whose git dir survived its main checkout's `.git`.
    orphan = path.join(root, "orphan");
    const orphanGitDir = path.join(root, "orphan-gitdir");
    await mkdir(orphan, { recursive: true });
    await mkdir(orphanGitDir, { recursive: true });
    await writeFile(path.join(orphan, ".git"), `gitdir: ${orphanGitDir}\n`);
    await writeFile(path.join(orphanGitDir, "HEAD"), "ref: refs/heads/orphaned\n");
    await writeFile(path.join(orphanGitDir, "commondir"), "../gone/.git\n");

    // A linked worktree of a bare repository: its common dir has no checkout.
    bareLinked = path.join(root, "bare-wt");
    const bareGitDir = path.join(root, "bare.git", "worktrees", "wt");
    await mkdir(bareLinked, { recursive: true });
    await mkdir(bareGitDir, { recursive: true });
    await writeFile(path.join(bareLinked, ".git"), `gitdir: ${bareGitDir}\n`);
    await writeFile(path.join(bareGitDir, "HEAD"), "ref: refs/heads/wt\n");
    await writeFile(path.join(bareGitDir, "commondir"), "../..\n");

    // A submodule: a `.git` file into the superproject's `.git/modules`, no commondir.
    submodule = path.join(main, "vendor", "lib");
    await mkdir(path.join(main, ".git", "modules", "lib"), { recursive: true });
    await mkdir(submodule, { recursive: true });
    await writeFile(path.join(submodule, ".git"), "gitdir: ../../.git/modules/lib\n");
    await writeFile(path.join(main, ".git", "modules", "lib", "HEAD"), "ref: refs/heads/lib-main\n");

    // A repository nested inside another's working tree.
    inner = path.join(main, "vendor", "inner");
    await mkdir(path.join(inner, ".git"), { recursive: true });
    await writeFile(path.join(inner, ".git", "HEAD"), "ref: refs/heads/inner-main\n");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("finds the main worktree for a nested, not-yet-existing file", async () => {
    const located = await createFilesystemWorktreeLocator().locate(
      path.join(main, "src", "deep", "new-file.ts"),
    );
    expect(located).toEqual({ root: main, branch: "main", kind: "main", mainRoot: main });
  });

  it("finds a linked worktree through its .git file, not the repository it belongs to", async () => {
    const located = await createFilesystemWorktreeLocator().locate(path.join(linked, "src", "a.ts"));
    expect(located).toEqual({ root: linked, branch: "slot-branch", kind: "linked", mainRoot: main });
  });

  it("names no main worktree for a linked worktree whose main checkout is gone", async () => {
    expect(await createFilesystemWorktreeLocator().locate(orphan)).toEqual({
      root: orphan,
      branch: "orphaned",
      kind: "linked",
    });
  });

  it("names no main worktree for a linked worktree of a bare repository", async () => {
    expect(await createFilesystemWorktreeLocator().locate(bareLinked)).toEqual({
      root: bareLinked,
      branch: "wt",
      kind: "linked",
    });
  });

  it("reports a submodule as its own main worktree, not a linked worktree of the superproject", async () => {
    expect(await createFilesystemWorktreeLocator().locate(path.join(submodule, "x.ts"))).toEqual({
      root: submodule,
      branch: "lib-main",
      kind: "main",
      mainRoot: submodule,
    });
  });

  it("lets the innermost repository win", async () => {
    expect(await createFilesystemWorktreeLocator().locate(path.join(inner, "x.ts"))).toEqual({
      root: inner,
      branch: "inner-main",
      kind: "main",
      mainRoot: inner,
    });
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "keeps a linked worktree linked when its commondir is unreadable",
    async () => {
      const commonDirFile = path.join(main, ".git", "worktrees", "slot", "commondir");
      await chmod(commonDirFile, 0o000);
      try {
        expect(await createFilesystemWorktreeLocator().locate(linked)).toEqual({
          root: linked,
          branch: "slot-branch",
          kind: "linked",
        });
      } finally {
        await chmod(commonDirFile, 0o644);
      }
    },
  );

  it("reports a detached HEAD as a worktree without a branch", async () => {
    expect(await createFilesystemWorktreeLocator().locate(detached)).toEqual({
      root: detached,
      kind: "linked",
      mainRoot: main,
    });
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

  it.skipIf(!gitAvailable)("agrees with git on real worktrees, a bare repository, and a submodule", async () => {
    // Real paths: git records them resolved, and macOS's temp dir is a symlink.
    const realRoot = await realpath(await mkdtemp(path.join(tmpdir(), "otel-hook-realgit-")));
    try {
      const repo = path.join(realRoot, "checkout");
      const worktree = path.join(realRoot, "checkout-slot-1");
      const library = path.join(realRoot, "library");
      const bare = path.join(realRoot, "bare.git");
      const bareWorktree = path.join(realRoot, "bare-slot");
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
      await mkdir(library);
      git(library, "init", "-q", "-b", "lib-main");
      git(library, "commit", "-q", "--allow-empty", "-m", "init");
      git(repo, "init", "-q", "-b", "trunk");
      git(repo, "commit", "-q", "--allow-empty", "-m", "init");
      git(repo, "worktree", "add", "-q", "-b", "agent-1", worktree);
      git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", library, "vendor/library");
      git(realRoot, "clone", "-q", "--bare", repo, bare);
      git(bare, "worktree", "add", "-q", "-b", "bare-agent", bareWorktree);

      const locator = createFilesystemWorktreeLocator();
      expect(await locator.locate(path.join(worktree, "src", "x.ts"))).toEqual({
        root: worktree,
        branch: "agent-1",
        kind: "linked",
        mainRoot: repo,
      });
      expect(await locator.locate(path.join(repo, "README.md"))).toEqual({
        root: repo,
        branch: "trunk",
        kind: "main",
        mainRoot: repo,
      });
      const submodule = path.join(repo, "vendor", "library");
      // Branch left out: whether a fresh submodule is on one depends on git's version.
      expect(await locator.locate(path.join(submodule, "x.ts"))).toMatchObject({
        root: submodule,
        kind: "main",
        mainRoot: submodule,
      });
      expect(await locator.locate(bareWorktree)).toEqual({
        root: bareWorktree,
        branch: "bare-agent",
        kind: "linked",
      });
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

  // Table keys and roots are POSIX-style for readability; the core resolves
  // hint paths with the platform's `path`, so the fake does the same.
  const fakeLocator = (table: Record<string, LocatedWorktree>, delayMillis = 0): WorktreeLocator => {
    const native = Object.entries(table).map(
      ([prefix, worktree]) =>
        [
          path.resolve(prefix),
          {
            ...worktree,
            root: path.resolve(worktree.root),
            ...(worktree.mainRoot === undefined ? {} : { mainRoot: path.resolve(worktree.mainRoot) }),
          },
        ] as const,
    );
    return {
      locate: async (absolutePath) => {
        if (delayMillis > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMillis));
        }
        return native.find(([prefix]) => absolutePath.startsWith(prefix))?.[1];
      },
    };
  };

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
      workspaceId: deriveWorkspaceIdentity(privacy, { kind: "git-root", absolutePath: path.resolve("/w/slot") })
        .workspaceId,
      vcsBranchName: "har-slot",
      source: "tool-path",
    });
    // Only tool events are ever touched.
    expect(events[1]).not.toHaveProperty("target");
  });

  it("names the repository by its main worktree's git-root id, shared by its linked worktrees", async () => {
    const gitRootId = (root: string) =>
      deriveWorkspaceIdentity(privacy, { kind: "git-root", absolutePath: path.resolve(root) }).workspaceId;
    const locator = fakeLocator({
      "/w/repo": { root: "/w/repo", branch: "main", kind: "main", mainRoot: "/w/repo" },
      "/w/slot": { root: "/w/slot", branch: "s", kind: "linked", mainRoot: "/w/repo" },
      "/w/orphan": { root: "/w/orphan", kind: "linked" },
    });
    const main = targetOf((await resolve({ source: "tool-path", paths: ["/w/repo/a.ts"] }, locator)).events);
    const linked = targetOf((await resolve({ source: "tool-path", paths: ["/w/slot/a.ts"] }, locator)).events);
    const orphan = targetOf(
      (await resolve({ source: "tool-path", paths: ["/w/orphan/a.ts"] }, locator)).events,
    );

    expect(main).toMatchObject({
      workspaceId: gitRootId("/w/repo"),
      repositoryId: gitRootId("/w/repo"),
      worktreeKind: "main",
    });
    expect(linked).toMatchObject({
      workspaceId: gitRootId("/w/slot"),
      repositoryId: gitRootId("/w/repo"),
      worktreeKind: "linked",
    });
    // No main worktree to name: the kind is still known, the repository is not guessed.
    expect(orphan).toEqual({
      workspaceId: gitRootId("/w/orphan"),
      source: "tool-path",
      worktreeKind: "linked",
    });
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
