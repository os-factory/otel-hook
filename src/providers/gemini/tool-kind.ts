import type { ToolKind } from "../../model/events.js";

/**
 * Classify a Gemini CLI built-in tool name into a canonical {@link ToolKind}.
 *
 * Order matters: patterns are checked top to bottom and the first match wins.
 * MCP tools (`mcp__<server>__<tool>`) and anything else unrecognized fall back
 * to `unknown` rather than guessing.
 */
const TOOL_KIND_PATTERNS: ReadonlyArray<readonly [RegExp, ToolKind]> = [
  [/^(read_file|read_many_files|list_directory|glob)$/i, "read"],
  [/^(write_file|edit|replace|save_memory)$/i, "write"],
  [/^(run_shell_command|execute_command|shell)$/i, "execute"],
  [/^(search_file_content|grep|glob_search|find)$/i, "search"],
  [/^(web_fetch|google_web_search|web_search)$/i, "network"],
];

export const classifyGeminiToolKind = (toolName: string): ToolKind => {
  for (const [pattern, kind] of TOOL_KIND_PATTERNS) {
    if (pattern.test(toolName)) {
      return kind;
    }
  }
  return "unknown";
};
