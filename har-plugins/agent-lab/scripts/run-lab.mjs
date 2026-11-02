#!/usr/bin/env node
/**
 * Provider live lab: run a host agent CLI against a scripted LLM mock, with
 * otel-hook registered as hooks, then assert canonical events and frozen
 * token counters.
 *
 * Usage:
 *   node har-plugins/agent-lab/scripts/run-lab.mjs --provider claude-code
 *   node har-plugins/agent-lab/scripts/run-lab.mjs --provider codex
 *
 * Env:
 *   AGENT_LAB=0        skip (exit 0)
 *   AGENT_LAB_KEEP=1   keep the temp lab directory
 *   AGENT_LAB_PROVIDER override --provider
 */

import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { assertLab } from "./assert.mjs";
import { startLabCollector } from "./collector.mjs";
import { decodeAllExportedLogRecords, decodeAllExportedSpans } from "./otlp-decode.mjs";
import { claudeCodeProvider } from "./providers/claude-code.mjs";
import { codexProvider } from "./providers/codex.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(PLUGIN_ROOT, "..", "..");
const CLI_PATH = path.join(REPO_ROOT, "dist", "cli.js");
const WRAPPER_PATH = path.join(PLUGIN_ROOT, "scripts", "otel-hook-wrapper.mjs");

const registerProvider = (provider) => [
  [provider.id, provider],
  ...provider.aliases.map((alias) => [alias, provider]),
];

const PROVIDERS = Object.freeze(
  Object.fromEntries([...registerProvider(claudeCodeProvider), ...registerProvider(codexProvider)]),
);

const log = (message) => {
  process.stderr.write(`${message}\n`);
};

const quote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;

const flagValue = (name) => {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
};

const which = async (name) => {
  const parts = (process.env.PATH ?? "").split(path.delimiter);
  for (const dir of parts) {
    if (dir.length === 0) {
      continue;
    }
    const candidate = path.join(dir, name);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  return undefined;
};

const run = (argv, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            child.kill("SIGKILL");
          }, options.timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      reject(error);
    });
    child.on("close", (code) => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });

const skip = (reason) => {
  const report = { status: "skip", reason };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return 0;
};

const main = async () => {
  if (process.env.AGENT_LAB === "0" || process.env.CLAUDE_LIVE_LAB === "0") {
    return skip("AGENT_LAB=0");
  }

  const requested = flagValue("--provider") ?? process.env.AGENT_LAB_PROVIDER ?? "claude-code";
  const provider = PROVIDERS[requested];
  if (provider === undefined) {
    const known = [...new Set(Object.values(PROVIDERS).map((entry) => entry.id))].join(", ");
    throw new Error(`unknown lab provider "${requested}" (have: ${known}; gemini is not wired yet)`);
  }

  const agentBin = process.env[provider.binEnv] ?? (await which(provider.bin));
  if (agentBin === undefined) {
    return skip(`${provider.bin} CLI not on PATH`);
  }

  try {
    await access(CLI_PATH);
  } catch {
    log("==> building otel-hook CLI");
    const built = await run(["npm", "run", "build"], { cwd: REPO_ROOT, env: process.env, timeoutMs: 120_000 });
    if (built.code !== 0) {
      process.stderr.write(built.stderr);
      throw new Error("npm run build failed");
    }
  }

  const scenario = JSON.parse(await readFile(path.join(PLUGIN_ROOT, ...provider.scenarioRel), "utf8"));
  const labRoot = await mkdtemp(path.join(tmpdir(), `otel-hook-agent-lab-${provider.id}-`));
  const homeDir = path.join(labRoot, "home");
  const configDir = path.join(labRoot, "agent-config");
  const workspace = path.join(labRoot, "workspace");
  const stateDir = path.join(labRoot, "state");
  const widgetPath = path.join(workspace, scenario.widgetFileName);
  const settingsFile = path.join(workspace, ...provider.settingsRel);
  const hooksJsonl = path.join(labRoot, "hooks.jsonl");
  const mockLog = path.join(labRoot, "mock-requests.jsonl");
  const reportPath = path.join(labRoot, "report.json");

  await mkdir(homeDir, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await mkdir(path.dirname(settingsFile), { recursive: true });
  await writeFile(widgetPath, scenario.widgetContents);
  if (typeof provider.prepareWorkspace === "function") {
    await provider.prepareWorkspace({ workspace, scenario, labRoot });
  }

  const collector = await startLabCollector();
  const mock = await provider.startMock({ scenario, widgetPath, logPath: mockLog });
  log(`==> ${provider.id} mock at ${mock.url}`);
  log(`==> OTLP collector traces ${collector.tracesUrl}`);

  const hookCommand = [
    process.execPath,
    quote(WRAPPER_PATH),
    "--mock-url",
    quote(mock.url),
    "--hooks-jsonl",
    quote(hooksJsonl),
    "--",
    process.execPath,
    quote(CLI_PATH),
    "run",
    "--provider",
    provider.otelProviderId,
    "--endpoint",
    quote(collector.tracesUrl),
    "--logs",
    "--logs-endpoint",
    quote(collector.logsUrl),
    "--state-dir",
    quote(stateDir),
    "--log-level",
    "warn",
    "--timeout-ms",
    "15000",
    "--flush-timeout-ms",
    "5000",
  ].join(" ");

  log("==> otel-hook setup");
  const setup = await run(
    [
      process.execPath,
      CLI_PATH,
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
      "30",
    ],
    { cwd: REPO_ROOT, env: process.env, timeoutMs: 30_000 },
  );
  await writeFile(path.join(labRoot, "setup.stdout"), setup.stdout);
  await writeFile(path.join(labRoot, "setup.stderr"), setup.stderr);
  if (setup.code !== 0) {
    throw new Error(`otel-hook setup failed:\n${setup.stderr || setup.stdout}`);
  }
  if (provider.mirrorProjectHooksToConfigDir === true) {
    const mirrored = path.join(configDir, "hooks.json");
    await writeFile(mirrored, await readFile(settingsFile, "utf8"));
  }

  const agentEnv = provider.isolateEnv({
    homeDir,
    configDir,
    labRoot,
    mockUrl: mock.url,
    hooksJsonl,
  });
  if (typeof provider.prepareHome === "function") {
    await provider.prepareHome({ homeDir, configDir, mockUrl: mock.url, scenario, labRoot });
  }

  log(`==> ${provider.bin} (print, hooks on, mocked API)`);
  const agent = await run(
    [
      agentBin,
      ...provider.agentArgv({
        scenario,
        settingsFile,
        debugFile: path.join(labRoot, "agent-debug.log"),
      }),
    ],
    { cwd: workspace, env: agentEnv, timeoutMs: 120_000 },
  );
  await writeFile(path.join(labRoot, "agent.stdout"), agent.stdout);
  await writeFile(path.join(labRoot, "agent.stderr"), agent.stderr);

  let hooksText = "";
  try {
    hooksText = await readFile(hooksJsonl, "utf8");
  } catch {
    hooksText = "";
  }

  let agentResult;
  try {
    agentResult = JSON.parse(agent.stdout);
  } catch {
    const completed = agent.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return undefined;
        }
      })
      .filter((row) => row?.type === "turn.completed")
      .at(-1);
    agentResult = completed;
  }

  const spans = decodeAllExportedSpans(collector.bodiesFor("/v1/traces"));
  const logs = decodeAllExportedLogRecords(collector.bodiesFor("/v1/logs"));
  const assertion = assertLab({
    scenario,
    provider,
    hooksJsonl: hooksText,
    spans,
    logs,
    wireText: collector.latin1(),
    agentStdout: agent.stdout,
    agentResult,
    agentExitCode: agent.code,
  });
  const report = {
    status: assertion.ok ? "pass" : "fail",
    provider: provider.id,
    labRoot,
    mockUrl: mock.url,
    mockRequests: mock.requests,
    collectorRequests: collector.requests.map((request) => ({ path: request.path, bytes: request.body.length })),
    setup: { code: setup.code, stdout: setup.stdout },
    agent: { code: agent.code, stderrTail: agent.stderr.slice(-4000) },
    assertion,
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  await mock.close();
  await collector.close();

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  log(`==> lab directory ${labRoot}`);
  log(`==> report ${reportPath}`);

  if (process.env.AGENT_LAB_KEEP !== "1" && process.env.CLAUDE_LIVE_LAB_KEEP !== "1" && assertion.ok) {
    await rm(labRoot, { recursive: true, force: true });
  }

  return assertion.ok ? 0 : 1;
};

try {
  process.exit(await main());
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
}
