/**
 * HAR driver for the concurrency scenarios: real `har` commands against
 * throwaway repositories, always under a sandbox HOME inside the lab directory.
 *
 * HAR is the only writer of session context files
 * (`$HOME/.har/sessions/<agent-tool>/<session-id>.json`). It learns which agent
 * session runs a command from the session env var every agent gives the
 * commands it runs (`CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`); the lab sets
 * exactly that variable, which is all HAR reads, so a `har env launch` run here
 * writes the same file as one an agent's shell tool would run.
 *
 * Nothing here touches the real HOME: telemetry is switched off first, so no
 * Mission Control is contacted or started, and worktrees land under the sandbox.
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";

/** The env var each agent sets, for every command it runs, to its session id. */
export const AGENT_SESSION_ENV = Object.freeze({
  claude_code: "CLAUDE_CODE_SESSION_ID",
  codex: "CODEX_THREAD_ID",
  cursor: "CURSOR_CONVERSATION_ID",
});

export const run = (argv, options = {}) =>
  new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: options.env,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer =
      options.timeoutMs === undefined ? undefined : setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
    child.on("error", (error) => {
      if (timer !== undefined) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (timer !== undefined) clearTimeout(timer);
      resolve({ code: code ?? 1, signal, stdout, stderr, millis: performance.now() - started });
    });
    if (options.input !== undefined) {
      child.stdin.end(options.input);
    }
  });

/** The `har` to run: `AGENT_LAB_HAR` (a command, or a `.js` entry run with node), else `har` on PATH. */
export const harCommand = () => {
  const configured = process.env.AGENT_LAB_HAR?.trim();
  if (configured === undefined || configured.length === 0) {
    return ["har"];
  }
  return /\.(c|m)?js$/.test(configured) ? [process.execPath, configured] : [configured];
};

const GIT_IDENTITY = ["-c", "user.email=lab@otel-hook.test", "-c", "user.name=otel-hook lab"];

/**
 * @param {{ labRoot: string, log: (line: string) => void }} options
 */
export const createHarDriver = async ({ labRoot, log }) => {
  const home = path.join(labRoot, "home");
  const reposDir = path.join(labRoot, "repos");
  await mkdir(home, { recursive: true });
  await mkdir(reposDir, { recursive: true });
  const har = harCommand();
  const sessionsDir = path.join(home, ".har", "sessions");

  // A minimal environment: never the caller's own agent session variables (the
  // lab itself may run inside Claude Code or Codex), never its OTEL_* or HAR_*.
  const baseEnv = {
    PATH: process.env.PATH ?? "",
    LANG: process.env.LANG ?? "C.UTF-8",
    USER: process.env.USER ?? "lab",
    TERM: "dumb",
    HOME: home,
    CI: "1",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const envFor = (agent) =>
    agent === undefined ? { ...baseEnv } : { ...baseEnv, [AGENT_SESSION_ENV[agent.agentTool]]: agent.sessionId };

  const harRun = async (args, { cwd, agent, allowFail = false } = {}) => {
    const result = await run([...har, ...args], { cwd, env: envFor(agent), timeoutMs: 120_000 });
    if (result.code !== 0 && !allowFail) {
      throw new Error(`har ${args.join(" ")} failed (${String(result.code)}):\n${result.stderr.slice(-2000)}\n${result.stdout.slice(-2000)}`);
    }
    return result;
  };

  const version = (await harRun(["--version"])).stdout.trim();
  await harRun(["telemetry", "off"], { cwd: labRoot, allowFail: true });
  log(`==> har ${version} (sandbox HOME ${home})`);

  const git = (args, cwd) => run(["git", ...GIT_IDENTITY, ...args], { cwd, env: baseEnv, timeoutMs: 30_000 });

  /** A throwaway repository with a `cli` profile harness. */
  const initRepo = async (name, url) => {
    const dir = path.join(reposDir, name);
    await mkdir(dir, { recursive: true });
    await git(["init", "-q", "-b", "main"], dir);
    await git(["remote", "add", "origin", url], dir);
    await writeFile(path.join(dir, "package.json"), `${JSON.stringify({ name, version: "0.0.0", private: true })}\n`);
    await git(["add", "-A"], dir);
    await git(["commit", "-qm", "init"], dir);
    await harRun(
      ["env", "init", "--profile", "cli", "--yes", "--no-cursor-rule", "--no-agents", "--commit-gate", "never"],
      { cwd: dir },
    );
    await git(["add", "-A"], dir);
    await git(["commit", "-qm", "har"], dir);
    return { name, dir, url };
  };

  const readSlot = async (repo, slot) =>
    JSON.parse(await readFile(path.join(repo.dir, ".har", "slots", `agent-${String(slot)}.json`), "utf8"));

  /** `har env launch <slot>` run by `agent` (or by no agent). */
  const launch = async (repo, slot, { agent, workId, title } = {}) => {
    const args = ["env", "launch", String(slot)];
    if (workId !== undefined) {
      args.push("--work-id", workId, "--work-title", title ?? workId);
    }
    const result = await harRun(args, { cwd: repo.dir, agent });
    const entry = await readSlot(repo, slot);
    return {
      repo: repo.name,
      slot,
      workDir: entry.workDir,
      branch: entry.branch,
      attemptId: entry.attemptId,
      workUnitId: entry.workUnitId,
      millis: Math.round(result.millis),
    };
  };

  /** `har env work-bind <slot> --work-id <id>` from the slot's work dir. */
  const workBind = async (repo, slotInfo, { agent, workId }) => {
    const result = await harRun(["env", "work-bind", String(slotInfo.slot), "--work-id", workId, "--repo", repo.dir], {
      cwd: slotInfo.workDir,
      agent,
    });
    return { millis: Math.round(result.millis), entry: await readSlot(repo, slotInfo.slot) };
  };

  const teardown = async (repo, slot, { agent } = {}) => {
    const result = await harRun(["env", "teardown", String(slot)], { cwd: repo.dir, agent, allowFail: true });
    return { code: result.code, millis: Math.round(result.millis) };
  };

  /** The context file HAR wrote for one session, or undefined. */
  const readContext = async (agentTool, sessionId) => {
    try {
      return JSON.parse(await readFile(path.join(sessionsDir, agentTool, `${sessionId}.json`), "utf8"));
    } catch {
      return undefined;
    }
  };

  return { home, sessionsDir, version, harRun, initRepo, launch, workBind, teardown, readContext, envFor };
};
