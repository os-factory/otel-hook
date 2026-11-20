import * as path from "node:path";

/**
 * Paths that would write onto a host-agent protocol stream, or that Windows
 * treats as a device rather than a file.
 *
 * Judged with both `path.posix` and `path.win32`, so the same string is refused
 * on Linux, macOS, and Windows. A config copied between machines must not start
 * writing the hook response (ADR 0004) or blocking on `CON` / `PRN`.
 */
const POSIX_STREAMS = new Set([
  "/dev/stdout",
  "/dev/stderr",
  "/dev/fd/1",
  "/dev/fd/2",
  "/proc/self/fd/1",
  "/proc/self/fd/2",
]);

const STREAM_BASENAMES = new Set(["-", "stdout", "stderr"]);

/**
 * Windows reserved device names, plus the console device aliases.
 *
 * The stem is the name before the first `.` and without a trailing `:`, which
 * is how Windows decides that `CON.jsonl` and `CON:` are the console.
 */
const WINDOWS_RESERVED_DEVICE =
  /^(con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])$/u;

const WINDOWS_DEVICE_NAMESPACE = new Set([
  String.raw`\\.\con`,
  String.raw`\\.\conin$`,
  String.raw`\\.\conout$`,
  String.raw`\\.\nul`,
]);

const windowsDeviceStem = (basename: string): string => {
  let name = basename.toLowerCase().replace(/[. ]+$/u, "");
  if (name.endsWith(":")) {
    name = name.slice(0, -1);
  }
  const dot = name.indexOf(".");
  if (dot >= 0) {
    name = name.slice(0, dot);
  }
  if (name.endsWith(":")) {
    name = name.slice(0, -1);
  }
  return name;
};

const stripTrailingSlashes = (value: string): string => value.replace(/[/\\]+$/u, "");

const isPosixStreamPath = (filePath: string): boolean => {
  const normalized = stripTrailingSlashes(path.posix.normalize(filePath.replaceAll("\\", "/")));
  if (POSIX_STREAMS.has(normalized.toLowerCase())) {
    return true;
  }
  return STREAM_BASENAMES.has(path.posix.basename(normalized).toLowerCase());
};

const isWindowsStreamPath = (filePath: string): boolean => {
  const normalized = path.win32.normalize(filePath);
  if (WINDOWS_DEVICE_NAMESPACE.has(normalized.toLowerCase())) {
    return true;
  }
  const base = path.win32.basename(stripTrailingSlashes(normalized));
  if (STREAM_BASENAMES.has(base.toLowerCase())) {
    return true;
  }
  return WINDOWS_RESERVED_DEVICE.test(windowsDeviceStem(base));
};

/**
 * True when a JSONL path must not be opened.
 *
 * Empty paths, NUL bytes, POSIX stdout/stderr (including `/dev/fd` and
 * `/proc/self/fd`), names `stdout` / `stderr` / `-`, and Windows reserved
 * devices (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, with or
 * without an extension) are refused on every host.
 */
export const isForbiddenJsonlPath = (filePath: string): boolean => {
  const trimmed = filePath.trim();
  if (trimmed.length === 0 || trimmed.includes("\0")) {
    return true;
  }
  if (isPosixStreamPath(trimmed) || isWindowsStreamPath(trimmed)) {
    return true;
  }
  // A relative path such as `dev/fd/1` from `/` resolves to a protocol stream
  // even though its basename is only `1`.
  const resolved = stripTrailingSlashes(path.resolve(trimmed));
  return POSIX_STREAMS.has(resolved.toLowerCase());
};
