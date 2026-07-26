import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import * as path from "node:path";

import type { Clock } from "../runtime/ports.js";

/**
 * Cross-process advisory lock around one configuration file.
 *
 * Two `otel-hook setup` runs against the same `settings.json` — a shell loop, a
 * provisioning tool, two terminals — would otherwise both read the original
 * document and both write their own merge, so whichever finished last would
 * silently drop the other's registration. Atomic renames make each *write*
 * safe; only a lock makes the read-merge-write *sequence* safe.
 *
 * `open(path, "wx")` is the primitive: it either creates the file or fails with
 * `EEXIST`, atomically, on every platform this package supports. A lock whose
 * recorded acquisition time is older than `staleMillis` is assumed to belong to
 * a process that crashed while holding it and is reclaimed, so a killed setup
 * cannot wedge every later one.
 *
 * This is a separate implementation from the state store's session lock on
 * purpose: that one is namespaced under the state directory and keyed by session
 * id, while this one has to live beside a file it does not own.
 */

export type FileLockOptions = {
  readonly clock: Clock;
  /** How long to wait for the holder before giving up. Default 5,000ms. */
  readonly timeoutMillis?: number;
  /** A lock older than this is treated as abandoned. Default 30,000ms. */
  readonly staleMillis?: number;
  /** Delay between acquisition attempts. Default 25ms. */
  readonly pollIntervalMillis?: number;
};

export class FileLockTimeoutError extends Error {
  constructor(lockPath: string, timeoutMillis: number) {
    super(
      `timed out after ${String(timeoutMillis)}ms waiting for the lock on ${path.basename(lockPath)}`,
    );
    this.name = "FileLockTimeoutError";
  }
}

/** Where the lock for a configuration file lives: beside it, clearly ours. */
export const lockPathFor = (filePath: string): string => `${filePath}.otel-hook.lock`;

/**
 * Contents of a held lock. `token` is what makes reclaim safe.
 *
 * Without it, "release the lock" means "unlink this path", which is not the same
 * operation: a holder slow enough to be declared stale gets its lock unlinked by
 * a waiter, the waiter creates its *own* lock at the same path, and then the
 * original holder's `finally` unlinks the successor's lock — leaving the file
 * unprotected while the successor still believes it holds it, and letting a
 * third process run concurrently with it. A random token per acquisition turns
 * both reclaim and release into compare-and-delete, so a lock can only ever be
 * removed by the process that actually owns it.
 */
type LockContents = {
  readonly token: string;
  readonly pid: number;
  readonly acquiredAt: number;
};

/**
 * Stand-in token for reclaiming a lock whose own token cannot be read.
 *
 * `releaseIfOwned` only restores a captured file when it reads a token that
 * *differs* from the one supplied; an unreadable file yields no token, so it is
 * removed. That is the intended behaviour here — the file has already been judged
 * stale — and it is why nothing else may ever use this value as a real token.
 */
/*
 * Filesystem-safe, because it becomes part of a tombstone filename, and unable to
 * collide with a real token, which is always 32 hex characters.
 */
const RECLAIM_UNTOKENED = "reclaim-untokened";

const isErrnoException = (thrown: unknown, code: string): boolean =>
  thrown instanceof Error && (thrown as NodeJS.ErrnoException).code === code;

const readLockContents = async (lockPath: string): Promise<LockContents | undefined> => {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LockContents>;
    return typeof parsed.token === "string" &&
      typeof parsed.acquiredAt === "number" &&
      typeof parsed.pid === "number"
      ? { token: parsed.token, pid: parsed.pid, acquiredAt: parsed.acquiredAt }
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Remove the lock if and only if we still own it — via a tombstone rename.
 *
 * Read-then-unlink cannot be made safe, however narrow the window: between the
 * read and the unlink the lock can be released and re-taken by someone else, and
 * the unlink then destroys a live lock. `unlink` takes a *path*, and a path is
 * exactly the thing that stops identifying our lock the moment we let go of it.
 *
 * So the delete is staged through a rename to a name only this call knows:
 *
 * 1. `rename(lockPath, tombstone)` — atomic on POSIX and, via
 *    `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`, on Windows. After it, *nothing*
 *    else can be at `lockPath` under our name; whatever we captured is now
 *    private to us, and a competitor's `open(lockPath, "wx")` will simply succeed.
 * 2. Read the tombstone and compare tokens. If it is ours, unlink it: the lock is
 *    released, and the release could not have touched anybody else's lock because
 *    we were holding the only reference to it.
 * 3. If it is *not* ours, we just moved a live lock out from under its owner, so
 *    put it back: `rename(tombstone, lockPath)`. The owner never observes a gap it
 *    can act on, because it only ever reads its lock to verify ownership, and it
 *    will find its own token restored.
 *
 * Honest limits, since this is a lock file and not a database:
 *
 * - The restore in step 3 is not itself atomic with step 1. A third process can
 *   acquire `lockPath` inside that window (the original owner having been judged
 *   stale by someone). The restore then replaces it. Both are recorded as *held*,
 *   so the outcome is a lock held by a process that will not release it until its
 *   own stale window elapses — a delay, not two writers, which is the failure
 *   direction that matters for a config-file installer.
 * - If the process dies between steps 1 and 3 the lock is left as a tombstone.
 *   Tombstones are named with our own token and are never treated as locks, so the
 *   effect is a released lock plus one stray file, not a wedge.
 * - `rename` across the same directory is required; the tombstone therefore lives
 *   beside the lock rather than in a temp directory.
 */
const releaseIfOwned = async (lockPath: string, token: string): Promise<boolean> => {
  const tombstone = `${lockPath}.${token}.releasing`;
  try {
    await rename(lockPath, tombstone);
  } catch {
    // Already gone, or never ours to move. Either way there is nothing to release
    // and nothing of anybody else's has been touched.
    return false;
  }

  const captured = await readLockContents(tombstone);
  if (captured !== undefined && captured.token !== token) {
    // Someone else's live lock. Put it back exactly as found.
    await rename(tombstone, lockPath).catch(async () => {
      // The restore failed, which would silently strand a live holder. Leave the
      // tombstone in place rather than deleting it, so the situation is
      // recoverable by inspection instead of invisible.
      await Promise.resolve();
    });
    return false;
  }

  await unlink(tombstone).catch(() => undefined);
  return true;
};

/**
 * Deliberately *not* `unref`'d. A process polling for this lock has nothing
 * else on its event loop, so an unref'd timer would let Node decide the program
 * was finished and exit — silently, with the setup never performed.
 */
const delay = (millis: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, millis);
  });

/**
 * Whether the current holder has abandoned the lock.
 *
 * The subtle case, and the reason this is not a one-liner: `open(path, "wx")`
 * creates the file *before* its contents are written, so a waiter can observe a
 * lock that is legitimately held but still empty. Treating "unparseable" as
 * "abandoned" would let that waiter delete a live lock and run concurrently
 * with its holder — which is precisely the lost update the lock exists to
 * prevent, made rare enough to look like flakiness.
 *
 * So the recorded timestamp is preferred (it comes from the same injected clock
 * as the timeout), and the file's mtime is consulted only when there is no
 * readable timestamp — which answers "was this created microseconds ago, or did
 * someone die mid-write half an hour back?" without guessing.
 */
const isStale = async (
  lockPath: string,
  clock: Clock,
  staleMillis: number,
): Promise<{ readonly stale: boolean; readonly token?: string }> => {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (thrown) {
    // Released between our EEXIST and this read: not stale, just gone.
    return { stale: !isErrnoException(thrown, "ENOENT") };
  }

  try {
    const parsed = JSON.parse(raw) as { acquiredAt?: unknown; token?: unknown };
    if (typeof parsed.acquiredAt === "number") {
      return {
        stale: clock.now() - parsed.acquiredAt > staleMillis,
        ...(typeof parsed.token === "string" ? { token: parsed.token } : {}),
      };
    }
  } catch {
    // Fall through to the mtime check.
  }

  try {
    const stats = await stat(lockPath);
    return { stale: clock.now() - stats.mtimeMs > staleMillis };
  } catch (thrown) {
    return { stale: !isErrnoException(thrown, "ENOENT") };
  }
};

/**
 * Run `fn` while holding the lock for `filePath`, releasing it on every path.
 *
 * The timeout bounds only lock *acquisition*; `fn` itself is not interrupted,
 * because aborting a caller partway through a read-merge-write is exactly the
 * outcome the lock exists to prevent.
 */
export const withFileLock = async <T>(
  filePath: string,
  options: FileLockOptions,
  fn: () => Promise<T>,
): Promise<T> => {
  const timeoutMillis = options.timeoutMillis ?? 5_000;
  const staleMillis = options.staleMillis ?? 30_000;
  const pollIntervalMillis = options.pollIntervalMillis ?? 25;
  const lockPath = lockPathFor(filePath);
  const startedAt = options.clock.monotonicMillis();

  await mkdir(path.dirname(filePath), { recursive: true });

  // Acquisition is a loop of its own so that an error thrown by `fn` — which may
  // legitimately be an EEXIST from something else entirely — can never be
  // mistaken for lock contention and cause `fn` to run a second time.
  for (;;) {
    const token = randomBytes(16).toString("hex");
    let acquired = false;
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        const contents: LockContents = {
          token,
          pid: process.pid,
          acquiredAt: options.clock.now(),
        };
        await handle.writeFile(JSON.stringify(contents));
        // Durable before the lock is treated as held: a waiter that reads a
        // half-written lock cannot see a token, and would fall back to mtime.
        await handle.sync();
      } finally {
        await handle.close();
      }
      acquired = true;
    } catch (thrown) {
      if (!isErrnoException(thrown, "EEXIST")) {
        throw thrown;
      }
    }

    if (acquired) {
      try {
        return await fn();
      } finally {
        // Only our own lock. If a waiter declared us stale and took over, the
        // captured file carries the successor's token and is put straight back.
        await releaseIfOwned(lockPath, token);
      }
    }

    const staleness = await isStale(lockPath, options.clock, staleMillis);
    if (staleness.stale) {
      // Reclaim the exact lock we judged stale, through the same tombstone
      // protocol. Two waiters can decide a lock is stale at the same instant; with
      // a plain unlink the slower one would delete whichever lock had been created
      // in the meantime — including the faster one's. Capturing by rename and
      // comparing the token means only the holder of the *judged* lock is removed,
      // and anything else found is restored.
      if (staleness.token === undefined) {
        // No readable token — a lock still being written, or one from a release
        // that predates tokens. Capture it anyway, but only delete what we
        // captured; the token check inside is a no-op for an unreadable file, which
        // is the best available and is why the staleness bound is generous.
        await releaseIfOwned(lockPath, RECLAIM_UNTOKENED);
      } else {
        await releaseIfOwned(lockPath, staleness.token);
      }
      continue;
    }
    if (options.clock.monotonicMillis() - startedAt >= timeoutMillis) {
      throw new FileLockTimeoutError(lockPath, timeoutMillis);
    }
    await delay(pollIntervalMillis);
  }
};
