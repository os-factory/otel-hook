/**
 * Live host-agent sessions and synthetic hook invocations for the concurrency
 * scenarios. Every session runs a real CLI (`claude -p`, `codex exec`) against
 * its own scripted mock; every hook is a real `otel-hook run` process.
 */

import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { run } from "./har.mjs";

const quote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * Exporter flags shared by every hook of a scenario: one collector (like one
 * Mission Control), one state directory (like one machine), the session context
 * directory HAR writes, and a stale launcher profile on the Resource — the
 * attempt / branch / repository a process environment would still carry after
 * its session moved. Session context must override those on every record and on
 * the Resource of every batch; a batch must never show another session's.
 */
export const STALE_RESOURCE = Object.freeze({
  "factory.attempt.id": "stale-env-attempt",
  "vcs.ref.head.name": "stale-env-branch",
  "vcs.repository.url.full": "https://example.invalid/stale-env.git",
});

export const otelHookArgs = ({ provider, collector, stateDir, sessionsDir, configFile, withContext = true }) => [
  "run",
  "--provider",
  provider,
  "--endpoint",
  collector.tracesUrl,
  "--logs",
  "--logs-endpoint",
  collector.logsUrl,
  "--metrics",
  ...(configFile === undefined ? [] : ["--config-file", configFile]),
  "--state-dir",
  stateDir,
  ...(withContext ? ["--session-context-dir", sessionsDir] : []),
  "--log-level",
  "warn",
  "--timeout-ms",
  "15000",
  "--flush-timeout-ms",
  "5000",
  ...Object.entries(STALE_RESOURCE).flatMap(([key, value]) => ["--resource-attr", `${key}=${value}`]),
];

/**
 * Watch a gate directory (see `otel-hook-wrapper.mjs --gate-dir`) and hand
 * every hook arrival to `onArrival` once. Returns `stop()`.
 */
export const watchGate = (gateDir, onArrival) => {
  const seen = new Set();
  let stopped = false;
  let chain = Promise.resolve();
  const tick = async () => {
    if (stopped) return;
    let names = [];
    try {
      names = (await readdir(gateDir)).filter((name) => name.endsWith(".arrived")).sort();
    } catch {
      names = [];
    }
    for (const name of names) {
      if (seen.has(name)) continue;
      seen.add(name);
      try {
        const arrival = JSON.parse(await readFile(path.join(gateDir, name), "utf8"));
        chain = chain.then(() => onArrival(arrival)).catch(() => undefined);
      } catch {
        seen.delete(name);
      }
    }
    if (!stopped) setTimeout(() => void tick(), 20);
  };
  void tick();
  return async () => {
    stopped = true;
    await chain;
  };
};

export const releaseGate = (gateDir, sessionId, eventName) =>
  writeFile(path.join(gateDir, `${sessionId}.${eventName}.release`), "go\n");

/**
 * One live agent session in `workspace` (a HAR slot work dir).
 *
 * @param {object} options
 * @param {object} options.provider  lab provider driver (providers/*.mjs)
 * @param {string} options.workspace
 * @param {string} options.label     unique within the run
 * @param {string} [options.sessionId] Claude Code only: `--session-id`
 * @param {string[]} [options.hold]  hook events the wrapper holds until released
 * @param {(arrival: object) => Promise<void>} [options.onArrival]
 */
export const runAgentSession = async (ctx, options) => {
  const { provider, workspace, label } = options;
  const agentRoot = path.join(ctx.labRoot, "agents", label);
  const homeDir = path.join(agentRoot, "home");
  const configDir = path.join(agentRoot, "agent-config");
  const gateDir = path.join(agentRoot, "gate");
  const hooksJsonl = path.join(agentRoot, "hooks.jsonl");
  for (const dir of [homeDir, configDir, gateDir]) {
    await mkdir(dir, { recursive: true });
  }
  for (const event of options.hold ?? []) {
    await writeFile(path.join(gateDir, `hold.${event}`), "hold\n");
  }
  const scenario = JSON.parse(await readFile(path.join(ctx.pluginRoot, ...provider.scenarioRel), "utf8"));
  const widgetPath = path.join(workspace, scenario.widgetFileName);
  await writeFile(widgetPath, scenario.widgetContents);
  const settingsFile = path.join(workspace, ...provider.settingsRel);
  await mkdir(path.dirname(settingsFile), { recursive: true });

  const mock = await provider.startMock({ scenario, widgetPath, logPath: path.join(agentRoot, "mock-requests.jsonl") });
  const hookCommand = [
    process.execPath,
    quote(ctx.wrapperPath),
    "--mock-url",
    quote(mock.url),
    "--hooks-jsonl",
    quote(hooksJsonl),
    "--gate-dir",
    quote(gateDir),
    "--",
    process.execPath,
    quote(ctx.cliPath),
    ...otelHookArgs({
      provider: provider.otelProviderId,
      collector: ctx.collector,
      stateDir: ctx.stateDir,
      sessionsDir: ctx.sessionsDir,
      configFile: options.configFile,
    }).map(quote),
  ].join(" ");

  const setup = await run(
    [
      process.execPath,
      ctx.cliPath,
      "setup",
      "--provider",
      provider.otelProviderId,
      "--scope",
      "project",
      "--project-dir",
      workspace,
      "--home-dir",
      homeDir,
      "--settings-file",
      settingsFile,
      "--hook-command",
      hookCommand,
      "--timeout-seconds",
      "60",
    ],
    { cwd: ctx.repoRoot, env: process.env, timeoutMs: 30_000 },
  );
  if (setup.code !== 0) {
    await mock.close();
    throw new Error(`otel-hook setup failed for ${label}: ${setup.stderr || setup.stdout}`);
  }
  if (provider.id === "codex") {
    // Codex does not load project hooks from a linked git worktree (a HAR slot
    // work dir) in this lab; register the same hooks at user level instead.
    await writeFile(path.join(configDir, "hooks.json"), await readFile(settingsFile, "utf8"));
  }
  if (typeof provider.prepareHome === "function") {
    await provider.prepareHome({ homeDir, configDir, mockUrl: mock.url, scenario, labRoot: agentRoot });
  }
  const env = provider.isolateEnv({ homeDir, configDir, labRoot: agentRoot, mockUrl: mock.url, hooksJsonl });
  const argv = [
    ctx.bins[provider.id],
    ...provider.agentArgv({ scenario, settingsFile, debugFile: path.join(agentRoot, "agent-debug.log") }),
    ...(options.sessionId === undefined ? [] : ["--session-id", options.sessionId]),
  ];

  const stopGate = watchGate(gateDir, async (arrival) => {
    if (options.onArrival !== undefined) {
      await options.onArrival(arrival, { gateDir });
    }
    if ((options.hold ?? []).includes(arrival.eventName)) {
      await releaseGate(gateDir, arrival.sessionId, arrival.eventName);
    }
  });
  const startedAt = Date.now();
  const agent = await run(argv, { cwd: workspace, env, timeoutMs: 180_000 });
  const endedAt = Date.now();
  await stopGate();
  await mock.close();
  await writeFile(path.join(agentRoot, "agent.stdout"), agent.stdout);
  await writeFile(path.join(agentRoot, "agent.stderr"), agent.stderr);

  let hooks = [];
  try {
    hooks = (await readFile(hooksJsonl, "utf8"))
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
  } catch {
    hooks = [];
  }
  const sessionIds = [...new Set(hooks.map((hook) => hook.session_id).filter((id) => typeof id === "string"))];
  return {
    label,
    provider: provider.id,
    agentTool: provider.agentTool,
    otelProviderId: provider.otelProviderId,
    sessionId: options.sessionId ?? sessionIds[0],
    sessionIds,
    exitCode: agent.code,
    startedAt,
    endedAt,
    millis: endedAt - startedAt,
    hookEvents: hooks.map((hook) => hook.hook_event_name),
    stderrTail: agent.stderr.slice(-1500),
  };
};

/** Did the agent CLI exist? */
export const resolveBin = async (name, envName) => {
  if (process.env[envName]) return process.env[envName];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir.length === 0) continue;
    const candidate = path.join(dir, name);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // next
    }
  }
  return undefined;
};

/**
 * Synthetic hook payloads (no content worth protecting): the events a real
 * session fires, in the providers' documented shapes.
 */
export const syntheticPayload = (provider, kind, { sessionId, cwd, toolUseId }) => {
  const common =
    provider === "codex"
      ? { session_id: sessionId, cwd, transcript_path: path.join(cwd, ".lab-rollout.jsonl"), model: "gpt-5-codex", turn_id: `turn-${toolUseId ?? "0"}` }
      : { session_id: sessionId, cwd, transcript_path: path.join(cwd, ".lab-transcript.jsonl") };
  switch (kind) {
    case "prompt":
      return { ...common, hook_event_name: "UserPromptSubmit", prompt: "synthetic lab prompt" };
    case "tool-start":
      return {
        ...common,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_use_id: toolUseId,
        tool_input: { command: "true" },
      };
    case "tool-end":
      return {
        ...common,
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_use_id: toolUseId,
        tool_input: { command: "true" },
        tool_response: provider === "codex" ? "ok" : { stdout: "", stderr: "", interrupted: false },
      };
    default:
      throw new Error(`unknown synthetic hook ${kind}`);
  }
};

/** One `otel-hook run` process; returns its wall time and exit. */
export const invokeHook = async (ctx, { provider, payload, withContext = true, configFile, collector }) => {
  const result = await run(
    [
      process.execPath,
      ctx.cliPath,
      ...otelHookArgs({
        provider,
        collector: collector ?? ctx.collector,
        stateDir: ctx.stateDir,
        sessionsDir: ctx.sessionsDir,
        configFile,
        withContext,
      }),
    ],
    { cwd: payload.cwd, env: { PATH: process.env.PATH ?? "", HOME: ctx.hookHome }, input: JSON.stringify(payload), timeoutMs: 60_000 },
  );
  return { code: result.code, signal: result.signal, millis: result.millis, stderr: result.stderr };
};

/** Run `tasks` (thunks) with at most `limit` in flight. */
export const pool = async (tasks, limit) => {
  const results = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= tasks.length) return;
      results[index] = await tasks[index]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
};

export const percentile = (values, p) => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[index]);
};
