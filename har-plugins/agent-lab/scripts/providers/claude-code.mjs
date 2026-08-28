/**
 * Claude Code driver for the agent live lab.
 *
 * Codex / Gemini drivers should export the same shape: startMock, isolateEnv,
 * agentArgv, settingsRel, otelProviderId.
 */

import { startMockServer } from "../mock-anthropic.mjs";

export const claudeCodeProvider = {
  id: "claude-code",
  aliases: ["claude"],
  bin: "claude",
  binEnv: "CLAUDE_BIN",
  otelProviderId: "claude-code",
  settingsRel: [".claude", "settings.json"],
  scenarioRel: ["scripts", "scenarios", "claude-read-then-ready.json"],
  usageContract:
    "Claude Code 2.1.x does not put token counters on hook stdin; the wrapper attaches mock last-usage onto Stop",
  startMock: (options) => startMockServer(options),
  isolateEnv: ({ homeDir, configDir, labRoot, mockUrl, hooksJsonl }) => ({
    PATH: process.env.PATH ?? "",
    USER: process.env.USER ?? "lab",
    LANG: process.env.LANG ?? "C.UTF-8",
    TERM: process.env.TERM ?? "dumb",
    TMPDIR: labRoot,
    HOME: homeDir,
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_BASE_URL: mockUrl,
    ANTHROPIC_API_KEY: "sk-ant-lab-mock-do-not-use",
    ANTHROPIC_AUTH_TOKEN: "sk-ant-lab-mock-do-not-use",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_AUTOUPDATER: "1",
    OTEL_HOOK_LAB_MOCK_URL: mockUrl,
    OTEL_HOOK_LAB_HOOKS_JSONL: hooksJsonl,
    NO_PROXY: "*",
    no_proxy: "*",
  }),
  agentArgv: ({ scenario, settingsFile, debugFile }) => [
    "-p",
    scenario.prompt,
    "--output-format",
    "json",
    "--dangerously-skip-permissions",
    "--allowedTools",
    scenario.toolName,
    "--strict-mcp-config",
    "--no-session-persistence",
    "--setting-sources",
    "project",
    "--settings",
    settingsFile,
    "--model",
    scenario.model,
    "--debug-file",
    debugFile,
  ],
};
