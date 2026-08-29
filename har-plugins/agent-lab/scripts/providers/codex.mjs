/**
 * Codex CLI driver for the agent live lab.
 *
 * Exports the same shape as the Claude Code driver: startMock, isolateEnv,
 * agentArgv, settingsRel, otelProviderId, plus optional prepareHome /
 * prepareWorkspace for CODEX_HOME and a disposable git workspace.
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { startMockServer } from "../mock-openai-responses.mjs";

const run = (argv, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if ((code ?? 1) !== 0) {
        reject(new Error(`${argv.join(" ")} failed (${String(code)}): ${stderr}`));
        return;
      }
      resolve();
    });
  });

export const codexProvider = {
  id: "codex",
  aliases: [],
  bin: "codex",
  binEnv: "CODEX_BIN",
  otelProviderId: "codex",
  settingsRel: [".codex", "hooks.json"],
  mirrorProjectHooksToConfigDir: false,
  scenarioRel: ["scripts", "scenarios", "codex-read-then-ready.json"],
  usageContract:
    "Codex stamps session-lifetime cumulative totals on usage-bearing hooks; otel-hook diffs them against the previous snapshot in the same session",
  startMock: (options) => startMockServer(options),
  isolateEnv: ({ homeDir, configDir, labRoot, mockUrl, hooksJsonl }) => ({
    PATH: process.env.PATH ?? "",
    USER: process.env.USER ?? "lab",
    LANG: process.env.LANG ?? "C.UTF-8",
    TERM: process.env.TERM ?? "dumb",
    TMPDIR: labRoot,
    HOME: homeDir,
    CODEX_HOME: configDir,
    OPENAI_API_KEY: "sk-lab-mock-do-not-use",
    CODEX_API_KEY: "sk-lab-mock-do-not-use",
    OPENAI_BASE_URL: `${mockUrl}/v1`,
    OTEL_HOOK_LAB_MOCK_URL: mockUrl,
    OTEL_HOOK_LAB_HOOKS_JSONL: hooksJsonl,
    NO_PROXY: "*",
    no_proxy: "*",
    CI: "1",
  }),
  prepareHome: async ({ configDir, mockUrl, scenario }) => {
    await mkdir(configDir, { recursive: true });
    const config = [
      `model = ${JSON.stringify(scenario.model)}`,
      `model_provider = "lab"`,
      `approval_policy = "never"`,
      `sandbox_mode = "danger-full-access"`,
      "",
      "[features]",
      "hooks = true",
      "",
      "[model_providers.lab]",
      `name = "otel-hook agent lab"`,
      `base_url = ${JSON.stringify(`${mockUrl}/v1`)}`,
      `env_key = "OPENAI_API_KEY"`,
      `wire_api = "responses"`,
      "requires_openai_auth = false",
      "",
    ].join("\n");
    await writeFile(path.join(configDir, "config.toml"), config);
  },
  prepareWorkspace: async ({ workspace }) => {
    await run(["git", "init"], { cwd: workspace, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
    await run(["git", "config", "user.email", "lab@otel-hook.test"], { cwd: workspace, env: process.env });
    await run(["git", "config", "user.name", "otel-hook lab"], { cwd: workspace, env: process.env });
  },
  agentArgv: ({ scenario }) => [
    "exec",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "--dangerously-bypass-hook-trust",
    "--json",
    "-m",
    scenario.model,
    scenario.prompt,
  ],
};
