import * as path from "node:path";

const FORBIDDEN_BASENAMES = new Set(["-", "stdout", "stderr", "con", "conin$", "conout$", "nul"]);

/**
 * Paths that would write onto the host agent's stdout/stderr protocol streams.
 *
 * The JSONL sink must never become a way to corrupt a hook response (ADR 0004).
 */
export const isForbiddenJsonlPath = (filePath: string): boolean => {
  const trimmed = filePath.trim();
  if (trimmed.length === 0) {
    return true;
  }
  const normalized = path.normalize(trimmed);
  const posix = normalized.replace(/\\/g, "/").toLowerCase();
  if (
    posix === "/dev/stdout" ||
    posix === "/dev/stderr" ||
    posix === "/dev/fd/1" ||
    posix === "/dev/fd/2" ||
    posix === "\\\\.\\con" ||
    posix === "\\\\.\\conout$"
  ) {
    return true;
  }
  return FORBIDDEN_BASENAMES.has(path.basename(normalized).toLowerCase());
};
