import type { TargetHint } from "../../model/target.js";
import { MAX_TARGET_HINT_PATHS } from "../../model/target.js";

/**
 * Where a Codex tool call pointed, as a target hint (ADR 0008).
 *
 * ## What the payload actually carries
 *
 * Observed against Codex CLI 0.163.0 driving a mock Responses server (the agent
 * lab, `har-plugins/agent-lab`), with the model's `exec_command` call setting
 * `workdir` to a directory *different* from the session's:
 *
 * - `PreToolUse`/`PostToolUse` for a shell call report `tool_name: "Bash"` and
 *   `tool_input: { command: "<string>" }` — the `workdir` the model asked for is
 *   **not** forwarded, and the envelope `cwd` stays the session's directory.
 * - An `apply_patch` invocation through the shell arrives the same way, as a
 *   `Bash` call whose command starts with `apply_patch`.
 *
 * So, in order:
 *
 * 1. **`tool-path`** — patch headers (`*** Add File:`, `*** Update File:`,
 *    `*** Delete File:`, `*** Move to:`) from an `apply_patch` tool's input, or
 *    from a shell command that invokes `apply_patch` (Codex intercepts exactly
 *    that form). Header paths are relative to the patch's working directory.
 * 2. **`shell-cwd`** — `tool_input.workdir`, which is the shell tool's own
 *    argument name and what older Codex builds forwarded verbatim (the
 *    `command: [argv]` shape). Read when present; current builds omit it.
 * 3. **`session-cwd`** — the envelope `cwd`, for everything else.
 */

const PATCH_HEADER = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/** The shell command as one string: Codex sends a string today, an argv array before. */
const commandText = (input: Record<string, unknown> | undefined): string | undefined => {
  const command = input?.command ?? input?.cmd;
  if (typeof command === "string") {
    return command;
  }
  if (Array.isArray(command) && command.every((part) => typeof part === "string")) {
    return command.join(" ");
  }
  return undefined;
};

/** Every distinct file a patch names, or `undefined` when it names none or too many. */
export const patchHeaderPaths = (patch: string): readonly string[] | undefined => {
  const paths = new Set<string>();
  for (const line of patch.split(/\r?\n/)) {
    const match = PATCH_HEADER.exec(line.trimEnd());
    const named = match?.[1]?.trim();
    if (named !== undefined && named.length > 0) {
      paths.add(named);
    }
  }
  // Too many files to check within bounds is not a reason to check some of
  // them: a target must hold for the whole call.
  return paths.size === 0 || paths.size > MAX_TARGET_HINT_PATHS ? undefined : [...paths];
};

const patchTextOf = (toolName: string, input: unknown): string | undefined => {
  if (typeof input === "string") {
    return /^apply[_-]?patch$/i.test(toolName) ? input : undefined;
  }
  const record = asRecord(input);
  if (/^apply[_-]?patch$/i.test(toolName)) {
    return (
      nonEmptyString(record?.patch) ?? nonEmptyString(record?.input) ?? commandText(record)
    );
  }
  const command = commandText(record);
  return command !== undefined && /^\s*apply_patch\b/.test(command) ? command : undefined;
};

export const codexTargetHint = (
  toolName: string,
  toolInput: unknown,
  cwd: string | undefined,
): TargetHint | undefined => {
  const record = asRecord(toolInput);
  const workdir = nonEmptyString(record?.workdir);
  const base = workdir ?? cwd;

  const patch = patchTextOf(toolName, toolInput);
  if (patch !== undefined) {
    const paths = patchHeaderPaths(patch);
    // A patch whose files cannot all be named is not evidence of anything
    // weaker either: the call did touch files, just not ones we can see.
    return paths === undefined
      ? undefined
      : { source: "tool-path", paths, ...(base === undefined ? {} : { baseDirectory: base }) };
  }
  if (workdir !== undefined) {
    return {
      source: "shell-cwd",
      paths: [workdir],
      ...(cwd === undefined ? {} : { baseDirectory: cwd }),
    };
  }
  return cwd === undefined ? undefined : { source: "session-cwd", paths: [cwd] };
};
