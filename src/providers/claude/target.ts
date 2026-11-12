import type { TargetHint } from "../../model/target.js";

/**
 * Where a Claude Code tool call pointed, as a target hint (ADR 0008).
 *
 * Claude Code's file tools name their file in `tool_input`; that is the
 * strongest evidence a hook payload carries, and is reported as `tool-path`.
 * The hook's `cwd` is the *session's* directory, not the tool's — Claude Code's
 * `Bash` reports no working directory of its own — so it is used only as the
 * `session-cwd` fallback for a call that names no path.
 *
 * Only built-in tools whose input field is documented as a path are read. An
 * MCP tool's `path` argument means whatever its server says it means, and is
 * not evidence of a local file.
 */
const PATH_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  Read: ["file_path"],
  Write: ["file_path"],
  Edit: ["file_path"],
  MultiEdit: ["file_path"],
  NotebookEdit: ["notebook_path"],
  NotebookRead: ["notebook_path"],
  // Optional on both: absent means "search the session's directory".
  Glob: ["path"],
  Grep: ["path"],
});

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export const claudeTargetHint = (
  toolName: string,
  toolInput: unknown,
  cwd: string | undefined,
): TargetHint | undefined => {
  // `hasOwn`: a tool name is payload data, and `__proto__` is a string like any other.
  const fields = Object.hasOwn(PATH_FIELDS, toolName) ? PATH_FIELDS[toolName] : undefined;
  const input = asRecord(toolInput);
  if (fields !== undefined && input !== undefined) {
    for (const field of fields) {
      const candidate = input[field];
      if (typeof candidate === "string" && candidate.length > 0) {
        return {
          source: "tool-path",
          paths: [candidate],
          ...(cwd === undefined ? {} : { baseDirectory: cwd }),
        };
      }
    }
  }
  return cwd === undefined ? undefined : { source: "session-cwd", paths: [cwd] };
};
