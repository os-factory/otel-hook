import type { ToolKind } from "../../model/index.js";

/**
 * Best-effort classification of Claude Code's built-in tool names.
 *
 * Unrecognized names (including every `mcp__*` tool, whose behavior is
 * defined by the connected MCP server rather than Claude Code itself) map to
 * `unknown` rather than a guess.
 */
const BUILT_IN_TOOL_KIND: Readonly<Record<string, ToolKind>> = Object.freeze({
  Bash: "execute",
  BashOutput: "execute",
  KillShell: "execute",
  Read: "read",
  NotebookRead: "read",
  Write: "write",
  Edit: "write",
  MultiEdit: "write",
  NotebookEdit: "write",
  Glob: "search",
  Grep: "search",
  WebFetch: "network",
  WebSearch: "network",
  Task: "delegate",
  TodoWrite: "other",
  ExitPlanMode: "other",
  AskUserQuestion: "other",
  SlashCommand: "other",
});

export const inferToolKind = (toolName: string): ToolKind => {
  if (toolName.startsWith("mcp__")) {
    return "unknown";
  }
  return BUILT_IN_TOOL_KIND[toolName] ?? "unknown";
};
