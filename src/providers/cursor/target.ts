import type { TargetHint } from "../../model/target.js";
import type { CursorPayload } from "./payload.js";

/**
 * Where a Cursor tool callback pointed, as a target hint (ADR 0008).
 *
 * - **`tool-path`** — `afterFileEdit.file_path` and `beforeReadFile.file_path`
 *   (the reference: "Absolute path to the file being read").
 * - **`shell-cwd`** — the `cwd` Cursor reports on `beforeShellExecution` (the
 *   reference lists it there and not on `afterShellExecution`; read on the
 *   latter only if a payload carries it).
 * - **`session-cwd`** — the workspace root, when the workspace has exactly one.
 *   A multi-root workspace has no single session directory, so it gives none.
 *
 * The CLI captures report `cwd: ""` for a call rooted at the workspace; an
 * empty `cwd` is therefore "no shell directory stated", and falls back to the
 * workspace root rather than being read as the filesystem root.
 */

const singleWorkspaceRoot = (payload: CursorPayload): string | undefined => {
  const roots = (payload.workspace_roots ?? []).filter((root) => root.length > 0);
  return roots.length === 1 ? roots[0] : undefined;
};

const sessionHint = (root: string | undefined): TargetHint | undefined =>
  root === undefined ? undefined : { source: "session-cwd", paths: [root] };

export const cursorTargetHint = (payload: CursorPayload): TargetHint | undefined => {
  const root = singleWorkspaceRoot(payload);
  const base = root === undefined ? {} : { baseDirectory: root };
  switch (payload.hook_event_name) {
    case "afterFileEdit":
    case "beforeReadFile":
      return payload.file_path.length === 0
        ? sessionHint(root)
        : { source: "tool-path", paths: [payload.file_path], ...base };
    case "beforeShellExecution":
    case "afterShellExecution":
      return payload.cwd !== undefined && payload.cwd.length > 0
        ? { source: "shell-cwd", paths: [payload.cwd], ...base }
        : sessionHint(root);
    case "preToolUse":
    case "postToolUse":
    case "postToolUseFailure":
    case "beforeMCPExecution":
    case "afterMCPExecution":
      return sessionHint(root);
    default:
      return undefined;
  }
};
