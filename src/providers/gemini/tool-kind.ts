import type { ToolKind } from "../../model/events.js";

/**
 * Classify a Gemini CLI built-in tool name into a canonical {@link ToolKind}.
 *
 * The names are Gemini's own, taken from the tool declarations at
 * `google-gemini/gemini-cli@3499c84`
 * (`packages/core/src/tools/definitions/base-declarations.ts` and
 * `packages/core/src/tools/tool-names.ts`) rather than transliterated from
 * another agent's vocabulary. Several are near-misses for a name a different CLI
 * uses and would be wrong if guessed: the edit tool is `replace`, not `edit`;
 * content search is `grep_search`, not `grep` or `search_file_content`; the shell
 * is `run_shell_command`, not `shell`; web search is `google_web_search`. There
 * is no `save_memory` tool — the CLI's own prompt says so outright and points at
 * `replace`/`write_file` on `GEMINI.md` instead.
 *
 * Unrecognized names map to `unknown` rather than a guess.
 */
const BUILT_IN_TOOL_KIND: Readonly<Record<string, ToolKind>> = Object.freeze({
  read_file: "read",
  read_many_files: "read",
  list_directory: "read",
  get_internal_docs: "read",
  read_mcp_resource: "read",
  list_mcp_resources: "read",
  write_file: "write",
  replace: "write",
  run_shell_command: "execute",
  glob: "search",
  grep_search: "search",
  web_fetch: "network",
  google_web_search: "network",
  // Gemini's subagent entry point. The CLI has no subagent hook events, so a
  // delegated run is observable only as this tool's BeforeTool/AfterTool pair.
  invoke_agent: "delegate",
  activate_skill: "other",
  ask_user: "other",
  write_todos: "other",
  enter_plan_mode: "other",
  exit_plan_mode: "other",
  update_topic: "other",
  complete_task: "other",
  tracker_create_task: "other",
  tracker_update_task: "other",
  tracker_get_task: "other",
  tracker_list_tasks: "other",
  tracker_add_dependency: "other",
  tracker_visualize: "other",
});

/**
 * MCP tools are named `mcp_<server>_<tool>` — a single underscore separator and
 * an `mcp_` prefix that `generateValidName` enforces. What such a tool does is
 * defined by the connected server, not by the Gemini CLI, so it stays `unknown`.
 * The prefix is checked before the table so that a server whose generated name
 * happens to collide with a built-in is not misclassified.
 */
const MCP_TOOL_PREFIX = "mcp_";

/** Tools the CLI discovers from a project command; likewise server-defined. */
const DISCOVERED_TOOL_PREFIX = "discovered_tool_";

export const classifyGeminiToolKind = (toolName: string): ToolKind => {
  if (toolName.startsWith(MCP_TOOL_PREFIX) || toolName.startsWith(DISCOVERED_TOOL_PREFIX)) {
    return "unknown";
  }
  return BUILT_IN_TOOL_KIND[toolName] ?? "unknown";
};
