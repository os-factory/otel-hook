import { open, stat } from "node:fs/promises";
import * as path from "node:path";

import type { LocatedWorktree, WorktreeLocator } from "./ports.js";

/**
 * Filesystem {@link WorktreeLocator}: finds the git worktree containing a path
 * by reading the files git itself reads, without spawning `git` (ADR 0008).
 *
 * From the path upward, the first directory holding a `.git` entry is the
 * worktree root:
 *
 * - `.git` is a **directory** — the main worktree; its git dir is that directory.
 * - `.git` is a **file** — a linked worktree (or a submodule): it holds
 *   `gitdir: <path>`, relative to the worktree root when not absolute.
 *
 * The branch is read from `<gitdir>/HEAD`: `ref: refs/heads/<name>` names a
 * branch; anything else (a detached commit id) names none. A `.git` entry that
 * cannot be read, points nowhere, or has no readable `HEAD` makes the answer
 * `undefined` — a broken worktree is not evidence, and the walk does not skip
 * past it to an enclosing repository that the event did not target.
 *
 * Everything is bounded: walk depth, bytes read per file, and cache size. Every
 * failure is `undefined`; nothing throws.
 */

/** Deepest directory chain walked before giving up. */
export const MAX_WORKTREE_WALK_DEPTH = 128;
/** Bytes read from a `.git` file or a `HEAD`; both are one short line. */
const MAX_GIT_FILE_BYTES = 4096;
/** Directories remembered before the cache is cleared and refilled. */
const MAX_CACHE_ENTRIES = 1024;
/** Default lifetime of a cached probe. Short: a branch can be switched. */
export const DEFAULT_WORKTREE_CACHE_TTL_MILLIS = 5_000;
/** Longest branch name accepted; git refs are far shorter in practice. */
const MAX_BRANCH_NAME_LENGTH = 255;

type Probe =
  | { readonly kind: "absent" }
  | { readonly kind: "worktree"; readonly located: LocatedWorktree }
  | { readonly kind: "invalid" };

const ABSENT: Probe = Object.freeze({ kind: "absent" });
const INVALID: Probe = Object.freeze({ kind: "invalid" });

const readBounded = async (filePath: string): Promise<string | undefined> => {
  let handle;
  try {
    handle = await open(filePath, "r");
    const buffer = Buffer.alloc(MAX_GIT_FILE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, MAX_GIT_FILE_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

/** `ref: refs/heads/<name>` → `<name>`; anything else → no branch. */
export const parseHeadBranch = (head: string): string | undefined => {
  const line = head.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const match = /^ref:\s*refs\/heads\/(.+)$/.exec(line);
  const branch = match?.[1];
  if (
    branch === undefined ||
    branch.length === 0 ||
    branch.length > MAX_BRANCH_NAME_LENGTH ||
    // git forbids these in ref names; their presence means this is not one.
    [...branch].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f) ||
    /[ ~^:?*[\\]/.test(branch)
  ) {
    return undefined;
  }
  return branch;
};

/** `gitdir: <path>` → the path, resolved against the worktree root. */
export const parseGitDirFile = (content: string, worktreeRoot: string): string | undefined => {
  const line = content.split(/\r?\n/, 1)[0]?.trim() ?? "";
  // A prefix check, not a regex: `gitdir:` followed by long runs of spaces made
  // the former `/^gitdir:\s*(.+)$/` backtrack polynomially (CodeQL).
  const target = line.startsWith("gitdir:") ? line.slice("gitdir:".length).trim() : undefined;
  if (target === undefined || target.length === 0 || target.includes("\u0000")) {
    return undefined;
  }
  return path.resolve(worktreeRoot, target);
};

const probeDirectory = async (directory: string): Promise<Probe> => {
  const dotGit = path.join(directory, ".git");
  let info;
  try {
    info = await stat(dotGit);
  } catch {
    // ENOENT, ENOTDIR (the "directory" is a file), EACCES: no worktree here.
    return ABSENT;
  }
  let gitDir: string | undefined;
  if (info.isDirectory()) {
    gitDir = dotGit;
  } else if (info.isFile()) {
    const content = await readBounded(dotGit);
    gitDir = content === undefined ? undefined : parseGitDirFile(content, directory);
  }
  if (gitDir === undefined) {
    return INVALID;
  }
  const head = await readBounded(path.join(gitDir, "HEAD"));
  if (head === undefined) {
    return INVALID;
  }
  const branch = parseHeadBranch(head);
  return {
    kind: "worktree",
    located: { root: directory, ...(branch === undefined ? {} : { branch }) },
  };
};

export type FilesystemWorktreeLocatorOptions = {
  /** Monotonic milliseconds for cache expiry. Defaults to `performance.now()`. */
  readonly monotonicMillis?: () => number;
  readonly cacheTtlMillis?: number;
};

/**
 * Create a locator with its own cache. The cache is instance state, never
 * module state: two hooks in one process do not share it.
 */
export const createFilesystemWorktreeLocator = (
  options: FilesystemWorktreeLocatorOptions = {},
): WorktreeLocator => {
  const now = options.monotonicMillis ?? ((): number => performance.now());
  const ttl = options.cacheTtlMillis ?? DEFAULT_WORKTREE_CACHE_TTL_MILLIS;
  const cache = new Map<string, { readonly at: number; readonly probe: Promise<Probe> }>();

  const cachedProbe = (directory: string): Promise<Probe> => {
    const hit = cache.get(directory);
    const at = now();
    if (hit !== undefined && at - hit.at <= ttl) {
      return hit.probe;
    }
    if (cache.size >= MAX_CACHE_ENTRIES) {
      cache.clear();
    }
    const probe = probeDirectory(directory).catch((): Probe => INVALID);
    cache.set(directory, { at, probe });
    return probe;
  };

  const locate = async (absolutePath: string): Promise<LocatedWorktree | undefined> => {
    try {
      if (!path.isAbsolute(absolutePath) || absolutePath.includes("\u0000")) {
        return undefined;
      }
      let directory = path.resolve(absolutePath);
      for (let depth = 0; depth < MAX_WORKTREE_WALK_DEPTH; depth += 1) {
        const probe = await cachedProbe(directory);
        if (probe.kind === "worktree") {
          return probe.located;
        }
        if (probe.kind === "invalid") {
          return undefined;
        }
        const parent = path.dirname(directory);
        if (parent === directory) {
          return undefined;
        }
        directory = parent;
      }
      return undefined;
    } catch {
      return undefined;
    }
  };

  return { locate };
};
