import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSystemClock } from "../../src/runtime/clock.js";
import { createFilesystemStateStore } from "../../src/state/filesystem-store.js";

/**
 * A hook process that waits for a session lock a peer holds has nothing else on
 * its event loop. Claude Code fires `SubagentStart` and `PostToolUse(Agent)` for
 * one session at the same instant; with an unref'd poll timer the waiting
 * process exited with "Detected unsettled top-level await" (exit 13) and its
 * event was lost. Runs the built library in a real child process, because only
 * a fresh process has the empty event loop that showed the bug.
 */
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const STATE_MODULE = pathToFileURL(path.join(REPO_ROOT, "dist", "state.js")).href;
const RUNTIME_MODULE = pathToFileURL(path.join(REPO_ROOT, "dist", "runtime.js")).href;

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(tmpdir(), "otel-hook-lock-wait-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

const lockFile = (sessionId: string): string =>
  path.join(rootDir, "claude-code", "install-1", "locks", `${sessionId}.lock`);

const runWaiter = (sessionId: string): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const script = `
      import { createFilesystemStateStore } from ${JSON.stringify(STATE_MODULE)};
      import { createSystemClock } from ${JSON.stringify(RUNTIME_MODULE)};
      const store = createFilesystemStateStore({
        rootDir: ${JSON.stringify(rootDir)}, providerId: "claude-code", installationId: "install-1",
        clock: createSystemClock(), lockTimeoutMillis: 5000, lockPollIntervalMillis: 20,
      });
      await store.withSessionLock(${JSON.stringify(sessionId)}, async () => { process.stdout.write("acquired"); });
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

describe("a process waiting on a held session lock", () => {
  it("stays alive until the peer releases, then runs its critical section", async () => {
    const sessionId = "ses_concurrent_subagent";
    await mkdir(path.dirname(lockFile(sessionId)), { recursive: true });
    await writeFile(lockFile(sessionId), JSON.stringify({ pid: 1, acquiredAt: Date.now() }));

    const waiter = runWaiter(sessionId);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await rm(lockFile(sessionId), { force: true });
    const result = await waiter;

    expect(result.stderr).not.toContain("unsettled top-level await");
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("acquired");
  });
});

describe("a lock file a peer has created but not stamped yet", () => {
  it("is not reclaimed as stale while it is fresh", async () => {
    const sessionId = "ses_unstamped";
    await mkdir(path.dirname(lockFile(sessionId)), { recursive: true });
    // `open(..., "wx")` done, stamp not written yet: an empty file.
    await writeFile(lockFile(sessionId), "");
    const store = createFilesystemStateStore({
      rootDir,
      providerId: "claude-code",
      installationId: "install-1",
      clock: createSystemClock(),
      lockTimeoutMillis: 150,
      lockPollIntervalMillis: 10,
      lockStaleMillis: 10_000,
    });
    let entered = false;
    await expect(
      store.withSessionLock(sessionId, () => {
        entered = true;
        return Promise.resolve();
      }),
    ).rejects.toThrow();
    expect(entered).toBe(false);
  });

  it("is reclaimed once the file itself is older than the stale bound", async () => {
    const sessionId = "ses_unstamped_old";
    await mkdir(path.dirname(lockFile(sessionId)), { recursive: true });
    await writeFile(lockFile(sessionId), "");
    const old = new Date(Date.now() - 60_000);
    await utimes(lockFile(sessionId), old, old);
    const store = createFilesystemStateStore({
      rootDir,
      providerId: "claude-code",
      installationId: "install-1",
      clock: createSystemClock(),
      lockTimeoutMillis: 500,
      lockPollIntervalMillis: 10,
      lockStaleMillis: 1_000,
    });
    let entered = false;
    await store.withSessionLock(sessionId, () => {
      entered = true;
      return Promise.resolve();
    });
    expect(entered).toBe(true);
  });
});
