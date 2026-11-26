/**
 * Repository keys: how a destination scope names a repository, and how a record's
 * `vcs.repository.url.full` is compared against it.
 *
 * A key is the repository URL's host and path, lowercased, without scheme,
 * credentials, port, trailing slash, or `.git` suffix — `github.com/acme/widget`.
 * The same remote spelled as HTTPS, `git@host:path` or `ssh://` gives the same
 * key, so a scope written from `git remote get-url origin` matches a record
 * stamped with the browse URL and the other way around.
 *
 * Pure: no I/O, never throws.
 */

/** OpenTelemetry VCS attribute a record's repository is read from. */
export const ATTR_VCS_REPOSITORY_URL_FULL = "vcs.repository.url.full";

/** Longest repository reference accepted, in a scope or on a record. */
export const MAX_REPOSITORY_REFERENCE_LENGTH = 2048;

const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;
/** `user@host:path` (scp-like git syntax), never `C:\...` or `host:port/...`. */
const SCP_LIKE_PATTERN = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/;

/** Drops trailing `/` with a linear scan (`/\/+$/` backtracks quadratically). */
const trimTrailingSlashes = (value: string): string => {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) end -= 1;
  return value.slice(0, end);
};

const keyOf = (host: string, pathname: string): string | undefined => {
  const withoutSlashes = trimTrailingSlashes(pathname);
  const cleanedPath = trimTrailingSlashes(
    withoutSlashes.toLowerCase().endsWith(".git") ? withoutSlashes.slice(0, -4) : withoutSlashes,
  );
  if (host.length === 0 || cleanedPath.length === 0 || cleanedPath === "/") {
    return undefined;
  }
  const withSlash = cleanedPath.startsWith("/") ? cleanedPath : `/${cleanedPath}`;
  return `${host}${withSlash}`.toLowerCase();
};

/**
 * The key of a repository URL or remote, or `undefined` when it does not name
 * one (empty, unparsable, no path, or a local path).
 *
 * Accepted: `https://host/path(.git)`, `http://…`, `ssh://user@host[:port]/path`,
 * `git://…`, `user@host:path` (scp-like), and an already-normalized
 * `host/path`. Credentials and ports never reach the key.
 */
export const normalizeRepositoryKey = (reference: string): string | undefined => {
  const trimmed = reference.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_REPOSITORY_REFERENCE_LENGTH) {
    return undefined;
  }
  if (SCHEME_PATTERN.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return undefined;
    }
    if (url.protocol === "file:") {
      return undefined;
    }
    return keyOf(url.hostname, url.pathname);
  }
  if (trimmed.startsWith("/") || trimmed.startsWith(".") || trimmed.includes("\\")) {
    // A local path is not a repository identity a receiver could share.
    return undefined;
  }
  const scp = SCP_LIKE_PATTERN.exec(trimmed);
  if (scp !== null && !trimmed.split(":")[0]?.includes("/")) {
    const [, host, pathPart] = scp;
    return host === undefined || pathPart === undefined ? undefined : keyOf(host, pathPart);
  }
  // `host/path`, already a key (or a browse URL without its scheme).
  try {
    const url = new URL(`https://${trimmed}`);
    return keyOf(url.hostname, url.pathname);
  } catch {
    return undefined;
  }
};
