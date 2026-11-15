/**
 * Per-event worktree targeting, subagent identity, and usage keys (ADR 0008),
 * replayed from contract fixtures through the shipped adapters, the real
 * runtime, the filesystem worktree locator, and the span and log mappings.
 *
 * The fixtures name a fictional `/workspace` tree; each test rebases it onto a
 * temporary directory laid out the way git lays out a main checkout
 * (`contract-repo`, `.git/` directory on branch `main`) and a linked worktree
 * (`contract-repo-slot-7`, `.git` file pointing into the main repository's
 * `worktrees/` on branch `har-slot-7`).
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resourceFromAttributes } from "@opentelemetry/resources";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CanonicalEvent } from "../../src/model/events.js";
import { deriveWorkspaceIdentity } from "../../src/privacy/workspace.js";
import type { ProviderAdapter } from "../../src/providers/adapter.js";
import { createClaudeCodeAdapter } from "../../src/providers/claude/index.js";
import { createCodexAdapter } from "../../src/providers/codex/index.js";
import { createCursorAdapter } from "../../src/providers/cursor/index.js";
import { createFilesystemWorktreeLocator } from "../../src/runtime/git-worktree.js";
import { createTestHook, type TestHarness } from "../../src/testing/index.js";
import { canonicalEventsToLogRecords } from "../../src/telemetry/log-records.js";
import { canonicalEventsToReadableSpans } from "../../src/telemetry/semconv.js";

const CONTRACTS_DIR = path.resolve(import.meta.dirname, "..", "..", "fixtures", "contracts");
const resource = resourceFromAttributes({ "service.name": "worktree-target-test" });

let root = "";
let mainCheckout = "";
let slotWorktree = "";

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "otel-hook-target-"));
  mainCheckout = path.join(root, "contract-repo");
  slotWorktree = path.join(root, "contract-repo-slot-7");
  const linkedGitDir = path.join(mainCheckout, ".git", "worktrees", "slot-7");
  await mkdir(linkedGitDir, { recursive: true });
  await mkdir(path.join(slotWorktree, "src"), { recursive: true });
  await writeFile(path.join(mainCheckout, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(path.join(linkedGitDir, "HEAD"), "ref: refs/heads/har-slot-7\n");
  // As `git worktree add` writes it: what makes the slot a linked worktree of the main checkout.
  await writeFile(path.join(linkedGitDir, "commondir"), "../..\n");
  await writeFile(path.join(slotWorktree, ".git"), `gitdir: ${linkedGitDir}\n`);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const loadFixture = async (provider: string, name: string): Promise<unknown> => {
  const raw = await readFile(path.join(CONTRACTS_DIR, provider, name), "utf8");
  // JSON-escape the temp root: on Windows it carries backslashes.
  const escapedRoot = JSON.stringify(`${root}${path.sep}`).slice(1, -1);
  return JSON.parse(raw.replaceAll("/workspace/", escapedRoot)) as unknown;
};

// These tests pin what a target says, not how fast it resolves: the budget's
// own behavior is tested in tests/runtime/worktree-target.test.ts, and the 50ms
// default made a cold Windows runner drop a target mid-assertion.
const harnessFor = (adapter: ProviderAdapter): TestHarness =>
  createTestHook({
    adapters: [adapter],
    worktreeLocator: createFilesystemWorktreeLocator(),
    targetResolutionBudgetMillis: 10_000,
  });

const replay = async (
  adapter: ProviderAdapter,
  provider: string,
  fixture: string,
): Promise<{ readonly harness: TestHarness; readonly events: readonly CanonicalEvent[] }> => {
  const harness = harnessFor(adapter);
  const outcome = await harness.hook.ingest({
    payload: await loadFixture(provider, fixture),
    transport: "hook-stdin",
  });
  expect(outcome.attribution).toBe("attributed");
  return { harness, events: outcome.events };
};

const spanAttributes = (events: readonly CanonicalEvent[], namePrefix: string) => {
  const spans = canonicalEventsToReadableSpans(events, { resource });
  const span = spans.find((candidate) => candidate.name.startsWith(namePrefix));
  if (span === undefined) {
    throw new Error(`no span named ${namePrefix}*: ${spans.map((s) => s.name).join(", ")}`);
  }
  return span.attributes;
};

/**
 * A lone `*.start` edge exports no span — the end edge publishes the complete
 * one, carrying the start's target forward through the correlator — so a
 * start-only callback is asserted on its log record, which shares the mapping.
 */
const startRecordAttributes = (events: readonly CanonicalEvent[]) => {
  const record = canonicalEventsToLogRecords(events, { resource }).records.find(
    (candidate) => candidate.attributes["otelhook.event.type"] === "tool.start",
  );
  if (record === undefined) {
    throw new Error("no tool.start log record");
  }
  return record.attributes;
};

const gitRootId = (harness: TestHarness, worktree: string): string =>
  deriveWorkspaceIdentity(harness.privacy, { kind: "git-root", absolutePath: worktree }).workspaceId;

/** Nothing exported may name the temporary tree: paths never leave the machine. */
const expectNoLocalPaths = (events: readonly CanonicalEvent[]): void => {
  const spans = canonicalEventsToReadableSpans(events, { resource });
  const logs = canonicalEventsToLogRecords(events, { resource }).records;
  expect(JSON.stringify(events)).not.toContain(root);
  expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain(root);
  expect(JSON.stringify(logs.map((record) => record.attributes))).not.toContain(root);
};

describe("claude code: tool targets and subagent id", () => {
  it("targets the worktree the edited file lives in, not the session cwd", async () => {
    const { harness, events } = await replay(
      createClaudeCodeAdapter(),
      "claude-code",
      "pre-tool-use-edit-in-worktree.json",
    );
    const attributes = startRecordAttributes(events);
    expect(attributes["otelhook.target.source"]).toBe("tool-path");
    expect(attributes["vcs.ref.head.name"]).toBe("har-slot-7");
    expect(attributes["otelhook.target.workspace.id"]).toBe(gitRootId(harness, slotWorktree));
    // The session's own workspace is still the directory it was started in.
    expect(attributes["otelhook.workspace.id"]).not.toBe(attributes["otelhook.target.workspace.id"]);
    expect(attributes["otelhook.subagent.id"]).toBeUndefined();
    expectNoLocalPaths(events);
  });

  it("falls back to the session cwd for Bash and exports the raw agent_id", async () => {
    const { harness, events } = await replay(
      createClaudeCodeAdapter(),
      "claude-code",
      "post-tool-use-bash-in-subagent.json",
    );
    const attributes = spanAttributes(events, "tool Bash");
    expect(attributes["otelhook.target.source"]).toBe("session-cwd");
    expect(attributes["vcs.ref.head.name"]).toBe("main");
    expect(attributes["otelhook.target.workspace.id"]).toBe(gitRootId(harness, mainCheckout));
    expect(attributes["otelhook.subagent.id"]).toBe("a1b2c3d4e5f60718");
    const [log] = canonicalEventsToLogRecords(events, { resource }).records;
    expect(log?.attributes["otelhook.subagent.id"]).toBe("a1b2c3d4e5f60718");
    expect(log?.attributes["otelhook.target.source"]).toBe("session-cwd");
    expectNoLocalPaths(events);
  });

  it("exports no target when no locator is wired", async () => {
    const harness = createTestHook({ adapters: [createClaudeCodeAdapter()] });
    const outcome = await harness.hook.ingest({
      payload: await loadFixture("claude-code", "pre-tool-use-edit-in-worktree.json"),
      transport: "hook-stdin",
    });
    const attributes = startRecordAttributes(outcome.events);
    expect(attributes["otelhook.target.workspace.id"]).toBeUndefined();
    expect(attributes["vcs.ref.head.name"]).toBeUndefined();
  });
});

describe("codex: tool targets and turn usage keys", () => {
  it("uses the session cwd for a shell call, because Codex does not forward workdir", async () => {
    const { harness, events } = await replay(createCodexAdapter(), "codex", "pre-tool-use-bash.json");
    const attributes = startRecordAttributes(events);
    expect(attributes["otelhook.target.source"]).toBe("session-cwd");
    expect(attributes["vcs.ref.head.name"]).toBe("main");
    expect(attributes["otelhook.target.workspace.id"]).toBe(gitRootId(harness, mainCheckout));
    expectNoLocalPaths(events);
  });

  it("targets the worktree named by apply_patch headers", async () => {
    const { harness, events } = await replay(
      createCodexAdapter(),
      "codex",
      "pre-tool-use-apply-patch-via-shell.json",
    );
    const attributes = startRecordAttributes(events);
    expect(attributes["otelhook.target.source"]).toBe("tool-path");
    expect(attributes["vcs.ref.head.name"]).toBe("har-slot-7");
    expect(attributes["otelhook.target.workspace.id"]).toBe(gitRootId(harness, slotWorktree));
    expectNoLocalPaths(events);
  });

  it("keys a turn's usage by turn_id and says the counters are a running total", async () => {
    const { events } = await replay(createCodexAdapter(), "codex", "stop-turn.json");
    const attributes = spanAttributes(events, "generation");
    expect(attributes["otelhook.generation.id"]).toBe("01a1d1ad-0000-7000-8000-0000000000t1");
    expect(attributes["otelhook.usage.temporality"]).toBe("cumulative");
    expect(attributes["gen_ai.usage.input_tokens"]).toBe(280);
  });
});

describe("cursor: tool targets and generation usage keys", () => {
  it("targets the edited file's worktree on both edges of afterFileEdit", async () => {
    const { harness, events } = await replay(
      createCursorAdapter(),
      "cursor",
      "after-file-edit-in-worktree.json",
    );
    const attributes = spanAttributes(events, "tool edit_file");
    expect(attributes["otelhook.target.source"]).toBe("tool-path");
    expect(attributes["vcs.ref.head.name"]).toBe("har-slot-7");
    expect(attributes["otelhook.target.workspace.id"]).toBe(gitRootId(harness, slotWorktree));
    expectNoLocalPaths(events);
  });

  it("targets the shell's reported cwd on beforeShellExecution", async () => {
    const { events } = await replay(createCursorAdapter(), "cursor", "before-shell-execution-cwd.json");
    const attributes = startRecordAttributes(events);
    expect(attributes["otelhook.target.source"]).toBe("shell-cwd");
    expect(attributes["vcs.ref.head.name"]).toBe("har-slot-7");
    expectNoLocalPaths(events);
  });

  it("targets the read file on beforeReadFile without exporting its content", async () => {
    const { events } = await replay(createCursorAdapter(), "cursor", "before-read-file.json");
    const attributes = spanAttributes(events, "tool read_file");
    expect(attributes["otelhook.target.source"]).toBe("tool-path");
    expect(attributes["vcs.ref.head.name"]).toBe("har-slot-7");
    expect(JSON.stringify(events)).not.toContain("Synthetic readme body");
    expectNoLocalPaths(events);
  });

  it("keys a generation's usage by generation_id as a delta", async () => {
    const { events } = await replay(createCursorAdapter(), "cursor", "stop-generation-usage.json");
    const attributes = spanAttributes(events, "generation");
    expect(attributes["otelhook.generation.id"]).toBe("gen-contract-cursor-0001");
    expect(attributes["otelhook.usage.temporality"]).toBe("delta");
    expect(attributes["gen_ai.usage.input_tokens"]).toBe(43859);
  });
});

/**
 * A session started in a linked worktree (`git worktree add`) is placed there
 * from its first event: its start and each prompt carry the session cwd as a
 * `session-cwd` target, so a consumer need not wait for a tool call.
 */
describe.each([
  {
    provider: "claude-code",
    adapter: createClaudeCodeAdapter,
    start: "session-start-in-worktree.json",
    prompt: "user-prompt-submit-in-worktree.json",
  },
  {
    provider: "codex",
    adapter: createCodexAdapter,
    start: "session-start-in-worktree.json",
    prompt: "user-prompt-submit-in-worktree.json",
  },
  {
    provider: "cursor",
    adapter: createCursorAdapter,
    start: "session-start-in-worktree.json",
    prompt: "before-submit-prompt-in-worktree.json",
  },
])("$provider: the session's own worktree", ({ provider, adapter, start, prompt }) => {
  const expectSessionTarget = (harness: TestHarness, attributes: Record<string, unknown>): void => {
    expect(attributes["otelhook.target.source"]).toBe("session-cwd");
    expect(attributes["vcs.ref.head.name"]).toBe("har-slot-7");
    expect(attributes["otelhook.target.workspace.id"]).toBe(gitRootId(harness, slotWorktree));
    expect(attributes["otelhook.target.repository.id"]).toBe(gitRootId(harness, mainCheckout));
    expect(attributes["otelhook.target.worktree.kind"]).toBe("linked");
  };

  it("names it on the session start", async () => {
    const { harness, events } = await replay(adapter(), provider, start);
    const record = canonicalEventsToLogRecords(events, { resource }).records.find(
      (candidate) => candidate.attributes["otelhook.event.type"] === "session.start",
    );
    expectSessionTarget(harness, record?.attributes ?? {});
    expectNoLocalPaths(events);
  });

  it("names it on each prompt, without exporting the prompt", async () => {
    const { harness, events } = await replay(adapter(), provider, prompt);
    expectSessionTarget(harness, spanAttributes(events, "prompt"));
    const record = canonicalEventsToLogRecords(events, { resource }).records.find(
      (candidate) => candidate.attributes["otelhook.event.type"] === "prompt.submitted",
    );
    expectSessionTarget(harness, record?.attributes ?? {});
    const exported = JSON.stringify([
      canonicalEventsToReadableSpans(events, { resource }).map((span) => span.attributes),
      canonicalEventsToLogRecords(events, { resource }).records,
    ]);
    expect(exported).not.toContain("summarize the billing module");
    expectNoLocalPaths(events);
  });
});
