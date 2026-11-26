/**
 * Routing by the session workspace's own remote, end to end through the built
 * CLI: one `otel-hook run --provider codex` process per callback, as an agent's
 * hook command runs it, against local OTLP receivers.
 *
 * Mirrors a session that starts in a slot worktree before any session context
 * exists (start, first prompt, first tool call), and gets its context only when
 * the agent binds the slot. A destination scoped to the checkout's `origin` must
 * receive those first records too; one scoped to another repository none.
 * Repository URLs are invented; payloads come from `tests/fixtures/codex/hooks/`.
 */
import { execFileSync } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { decodeAllExportedLogRecords } from "../helpers/otlp.js";
import { ensureBuiltCli, makeStateDir, REPO_ROOT, runCliProcess, startCollector, type Collector } from "./harness.js";

const REPO_A = "https://example.test/synthetic-org/routed-repo.git";
const REPO_B = "https://example.test/synthetic-org/other-repo.git";
const SESSION = "codex-workspace-routing-e2e";

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

const withCollector = async (): Promise<Collector> => {
  const collector = await startCollector();
  cleanups.push(() => collector.close());
  return collector;
};

const fixture = async (name: string): Promise<Record<string, unknown>> =>
  JSON.parse(
    await readFile(path.join(REPO_ROOT, "tests", "fixtures", "codex", "hooks", `${name}.json`), "utf8"),
  ) as Record<string, unknown>;

const eventTypes = (collector: Collector): string[] =>
  decodeAllExportedLogRecords(
    collector.requests.filter((request) => request.path === "/v1/logs").map((request) => request.body),
  )
    .map((record) => String(record.attributes["otelhook.event.type"]))
    .sort();

describe("otel-hook run: routing by the session workspace's own remote", () => {
  it.skipIf(!gitAvailable)(
    "gets a slot worktree session's records from before its context to the destination scoped to its origin",
    async () => {
      const state = await makeStateDir();
      cleanups.push(() => state.remove());
      const root = await realpath(state.dir);
      const checkout = path.join(root, "checkout");
      const slot = path.join(root, "worktrees", "checkout-slot-1");
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
      await mkdir(checkout, { recursive: true });
      git(checkout, "init", "-q", "-b", "main");
      git(checkout, "remote", "add", "origin", REPO_A);
      git(checkout, "commit", "-q", "--allow-empty", "-m", "init");
      git(checkout, "worktree", "add", "-q", "-b", "slot-1", slot);

      const local = await withCollector();
      const hostedA = await withCollector();
      const hostedB = await withCollector();
      const contextDir = path.join(root, "sessions");
      const config = path.join(root, "otel-hook.json");
      const destination = (name: string, collector: Collector, repositories?: readonly string[]) => ({
        name,
        tracesEndpoint: collector.url,
        logsEndpoint: collector.logsUrl,
        signals: ["traces", "logs"],
        ...(repositories === undefined ? {} : { scopes: [{ repositories }] }),
      });
      await writeFile(
        config,
        JSON.stringify({
          exporter: {
            destinations: [
              destination("local", local),
              destination("hosted-a", hostedA, [REPO_A.replace(/\.git$/, "")]),
              destination("hosted-b", hostedB, [REPO_B]),
            ],
            logs: { enabled: true, includeContent: true },
          },
          privacy: { contentMode: "raw", allowRawContent: true },
          sessionContext: { dir: contextDir },
        }),
        "utf8",
      );

      const ids = { session_id: SESSION, cwd: slot };
      const run = async (payload: Record<string, unknown>): Promise<void> => {
        const result = await runCliProcess(
          [
            "run",
            "--provider",
            "codex",
            "--codex-rollout-usage",
            "--config-file",
            config,
            "--state-dir",
            path.join(root, "state"),
            "--timeout-ms",
            "1500",
            "--flush-timeout-ms",
            "5000",
          ],
          JSON.stringify(payload),
          { env: { HOME: root }, timeoutMillis: 60_000 },
        );
        expect(result.code).toBe(0);
      };

      // Before the slot is bound to the session: no context file at all.
      await run({ ...(await fixture("session-start")), ...ids });
      await run({ ...(await fixture("user-prompt-submit")), ...ids, prompt: "synthetic routed prompt" });
      await run({ ...(await fixture("pre-tool-use-shell")), ...ids });
      // The agent bound the slot: from here on the context stamps the repository.
      await mkdir(path.join(contextDir, "codex"), { recursive: true });
      await writeFile(
        path.join(contextDir, "codex", `${SESSION}.json`),
        JSON.stringify({
          version: 1,
          agentTool: "codex",
          sessionId: SESSION,
          segments: [
            {
              from: new Date(0).toISOString(),
              to: null,
              reason: "join",
              attributes: { "vcs.repository.url.full": REPO_A },
            },
          ],
        }),
        "utf8",
      );
      await run({ ...(await fixture("post-tool-use-success")), ...ids });

      const expected = ["prompt.submitted", "session.start", "tool.end", "tool.start"];
      expect(eventTypes(local)).toEqual(expected);
      expect(eventTypes(hostedA)).toEqual(expected);
      expect(hostedA.text()).toContain("synthetic routed prompt");
      expect(hostedB.requests).toHaveLength(0);
      // Routing only: the records sent before the context name no repository, anywhere.
      for (const collector of [local, hostedA]) {
        const unstamped = decodeAllExportedLogRecords(
          collector.requests.filter((request) => request.path === "/v1/logs").map((request) => request.body),
        ).filter((record) => record.attributes["vcs.repository.url.full"] === undefined);
        expect(unstamped.map((record) => String(record.attributes["otelhook.event.type"])).sort()).toEqual([
          "prompt.submitted",
          "session.start",
          "tool.start",
        ]);
      }
    },
    120_000,
  );
});
