import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";

import type { Clock, Logger, StateRecord, StateValue } from "../runtime/ports.js";
import { stateRecordSchema } from "../runtime/ports.js";
import { createAsyncLock } from "./async-lock.js";
import { keyDigest, namespaceSegments, sanitizeSegment, type StoreNamespace } from "./keys.js";
import type { LockingStateStore } from "./store.js";

export type FilesystemStateStoreOptions = StoreNamespace & {
  readonly rootDir: string;
  readonly clock: Clock;
  readonly logger?: Logger;
  /** Bounds how long a write, read, or session lock waits. Default 5,000ms. */
  readonly lockTimeoutMillis?: number;
  /** A lock file older than this is assumed to belong to a crashed process and is reclaimed. Default 30,000ms. */
  readonly lockStaleMillis?: number;
  /** Delay between lock acquisition attempts. Default 25ms. */
  readonly lockPollIntervalMillis?: number;
};

export interface FilesystemStateStore extends LockingStateStore {
  readonly recordsDir: string;
  readonly quarantineDir: string;
  /** Bounded sweep: removes records untouched for longer than `maxAgeMillis`. */
  pruneStale(
    maxAgeMillis: number,
    options?: { readonly maxEntries?: number },
  ): Promise<{ readonly removed: number; readonly scanned: number }>;
}

type Envelope = { readonly key: string; readonly record: StateRecord };

const isErrnoException = (thrown: unknown, code: string): boolean =>
  thrown instanceof Error && (thrown as NodeJS.ErrnoException).code === code;

const sleep = (millis: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, millis);
    timer.unref?.();
  });

const wrapFsError = (thrown: unknown, operation: string): Error => {
  if (thrown instanceof Error) {
    return new Error(`filesystem state store ${operation} failed: ${thrown.name}`, { cause: thrown });
  }
  return new Error(`filesystem state store ${operation} failed`);
};

/**
 * Crash-safe filesystem {@link StateStore}.
 *
 * Every write lands via a temp file plus `rename`, which POSIX guarantees is
 * atomic within one directory: a reader never observes a half-written record,
 * and a process killed mid-write leaves only an orphaned temp file, never a
 * corrupt one. A record that still fails to parse (disk corruption, a manual
 * edit, a future incompatible version) is quarantined rather than thrown from
 * `read`, so a single bad file degrades one key instead of the whole store.
 *
 * Locking is layered: an in-process {@link createAsyncLock} orders same-process
 * callers, and a lock file with a staleness timeout orders across processes
 * and recovers automatically if the holder crashed while holding it.
 */
export const createFilesystemStateStore = (
  options: FilesystemStateStoreOptions,
): FilesystemStateStore => {
  const [providerSegment, installationSegment] = namespaceSegments(options);
  const baseDir = path.join(options.rootDir, providerSegment, installationSegment);
  const recordsDir = path.join(baseDir, "records");
  const quarantineDir = path.join(baseDir, "quarantine");
  const locksDir = path.join(baseDir, "locks");

  const lockTimeoutMillis = options.lockTimeoutMillis ?? 5_000;
  const lockStaleMillis = options.lockStaleMillis ?? 30_000;
  const lockPollIntervalMillis = options.lockPollIntervalMillis ?? 25;

  const keyLock = createAsyncLock();
  const sessionLock = createAsyncLock();

  let dirsReady: Promise<void> | undefined;
  const ensureDirs = async (): Promise<void> => {
    if (dirsReady !== undefined) {
      return dirsReady;
    }
    const promise = (async (): Promise<void> => {
      await mkdir(recordsDir, { recursive: true });
      await mkdir(quarantineDir, { recursive: true });
      await mkdir(locksDir, { recursive: true });
    })();
    dirsReady = promise;
    try {
      await promise;
    } catch (thrown) {
      dirsReady = undefined;
      throw wrapFsError(thrown, "ensure-dirs");
    }
  };

  const recordPath = (key: string): string => path.join(recordsDir, `${keyDigest(key)}.json`);
  const tempPath = (key: string): string =>
    path.join(recordsDir, `.tmp-${keyDigest(key)}-${randomBytes(6).toString("hex")}.json`);
  const lockPath = (sessionId: string): string =>
    path.join(locksDir, `${sanitizeSegment(sessionId)}.lock`);

  const quarantine = async (filePath: string, key: string, reason: string): Promise<void> => {
    const dest = path.join(quarantineDir, `${options.clock.now()}-${keyDigest(key)}-${reason}.json`);
    try {
      await rename(filePath, dest);
    } catch {
      await unlink(filePath).catch(() => undefined);
    }
    options.logger?.warn("filesystem state record quarantined", { "state.reason": reason });
  };

  const readUnlocked = async (key: string): Promise<StateRecord | undefined> => {
    await ensureDirs();
    const filePath = recordPath(key);
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (thrown) {
      if (isErrnoException(thrown, "ENOENT")) {
        return undefined;
      }
      throw wrapFsError(thrown, "read");
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      await quarantine(filePath, key, "invalid-json");
      return undefined;
    }

    const envelope = parsedJson as Partial<Envelope>;
    if (envelope.key !== key) {
      await quarantine(filePath, key, "key-mismatch");
      return undefined;
    }
    const parsed = stateRecordSchema.safeParse(envelope.record);
    if (!parsed.success) {
      await quarantine(filePath, key, "schema-invalid");
      return undefined;
    }
    return parsed.data;
  };

  const writeUnlocked = async (key: string, value: StateValue): Promise<StateRecord> => {
    await ensureDirs();
    const previous = await readUnlocked(key);
    const record = stateRecordSchema.parse({
      revision: (previous?.revision ?? 0) + 1,
      updatedAt: options.clock.now(),
      value,
    });
    const envelope: Envelope = { key, record };
    const tmp = tempPath(key);
    try {
      await writeFile(tmp, JSON.stringify(envelope), "utf8");
      await rename(tmp, recordPath(key));
    } catch (thrown) {
      await unlink(tmp).catch(() => undefined);
      throw wrapFsError(thrown, "write");
    }
    return record;
  };

  const acquireFileLock = async (
    sessionId: string,
    timeoutMillis: number,
  ): Promise<() => Promise<void>> => {
    await ensureDirs();
    const filePath = lockPath(sessionId);
    const startedAt = options.clock.monotonicMillis();

    for (;;) {
      try {
        const handle = await open(filePath, "wx");
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: options.clock.now() }));
        } finally {
          await handle.close();
        }
        return async (): Promise<void> => {
          await unlink(filePath).catch(() => undefined);
        };
      } catch (thrown) {
        if (!isErrnoException(thrown, "EEXIST")) {
          throw wrapFsError(thrown, "lock");
        }
      }

      const stale = await (async (): Promise<boolean> => {
        try {
          const raw = await readFile(filePath, "utf8");
          const parsed = JSON.parse(raw) as { acquiredAt?: unknown };
          return (
            typeof parsed.acquiredAt !== "number" ||
            options.clock.now() - parsed.acquiredAt > lockStaleMillis
          );
        } catch {
          return true;
        }
      })();
      if (stale) {
        await unlink(filePath).catch(() => undefined);
        continue;
      }

      if (options.clock.monotonicMillis() - startedAt >= timeoutMillis) {
        throw new Error(`filesystem state store lock wait exceeded ${timeoutMillis}ms`);
      }
      await sleep(lockPollIntervalMillis);
    }
  };

  return {
    recordsDir,
    quarantineDir,
    read: (key: string): Promise<StateRecord | undefined> =>
      keyLock.run(key, () => readUnlocked(key), lockTimeoutMillis),
    write: (key: string, value: StateValue): Promise<StateRecord> =>
      keyLock.run(key, () => writeUnlocked(key, value), lockTimeoutMillis),
    delete: (key: string): Promise<void> =>
      keyLock.run(
        key,
        async (): Promise<void> => {
          await ensureDirs();
          await unlink(recordPath(key)).catch((thrown: unknown) => {
            if (!isErrnoException(thrown, "ENOENT")) {
              throw wrapFsError(thrown, "delete");
            }
          });
        },
        lockTimeoutMillis,
      ),
    keys: async (prefix: string): Promise<readonly string[]> => {
      await ensureDirs();
      let entries: string[];
      try {
        entries = await readdir(recordsDir);
      } catch (thrown) {
        if (isErrnoException(thrown, "ENOENT")) {
          return [];
        }
        throw wrapFsError(thrown, "keys");
      }
      const found: string[] = [];
      for (const entry of entries) {
        if (!entry.endsWith(".json") || entry.startsWith(".tmp-")) {
          continue;
        }
        let raw: string;
        try {
          raw = await readFile(path.join(recordsDir, entry), "utf8");
        } catch {
          continue;
        }
        try {
          const envelope = JSON.parse(raw) as Partial<Envelope>;
          if (typeof envelope.key === "string" && envelope.key.startsWith(prefix)) {
            found.push(envelope.key);
          }
        } catch {
          continue;
        }
      }
      return found.sort();
    },
    withSessionLock: async <T>(
      sessionId: string,
      fn: () => Promise<T>,
      lockOptions?: { readonly timeoutMillis?: number },
    ): Promise<T> => {
      const timeoutMillis = lockOptions?.timeoutMillis ?? lockTimeoutMillis;
      return sessionLock.run(
        sessionId,
        async (): Promise<T> => {
          const release = await acquireFileLock(sessionId, timeoutMillis);
          try {
            return await fn();
          } finally {
            await release();
          }
        },
        timeoutMillis,
      );
    },
    pruneStale: async (
      maxAgeMillis: number,
      pruneOptions?: { readonly maxEntries?: number },
    ): Promise<{ readonly removed: number; readonly scanned: number }> => {
      await ensureDirs();
      const cap = pruneOptions?.maxEntries ?? 5_000;
      const now = options.clock.now();
      let removed = 0;
      let scanned = 0;

      let entries: string[];
      try {
        entries = await readdir(recordsDir);
      } catch (thrown) {
        if (!isErrnoException(thrown, "ENOENT")) {
          throw wrapFsError(thrown, "prune");
        }
        entries = [];
      }
      for (const entry of entries) {
        if (scanned >= cap) {
          break;
        }
        if (!entry.endsWith(".json") || entry.startsWith(".tmp-")) {
          continue;
        }
        scanned += 1;
        const filePath = path.join(recordsDir, entry);
        try {
          // Ages are measured against the record's own `updatedAt`, taken from
          // the injected clock at write time, never the OS mtime: a test (or a
          // host) using a clock other than the wall clock would otherwise be
          // compared against a completely unrelated time source.
          const raw = await readFile(filePath, "utf8");
          const envelope = JSON.parse(raw) as Partial<Envelope>;
          const updatedAt = envelope.record?.updatedAt;
          if (typeof updatedAt === "number" && now - updatedAt > maxAgeMillis) {
            await unlink(filePath).catch(() => undefined);
            removed += 1;
          }
        } catch {
          continue;
        }
      }

      let lockEntries: string[];
      try {
        lockEntries = await readdir(locksDir);
      } catch {
        lockEntries = [];
      }
      for (const entry of lockEntries) {
        const filePath = path.join(locksDir, entry);
        try {
          const raw = await readFile(filePath, "utf8");
          const parsed = JSON.parse(raw) as { acquiredAt?: unknown };
          if (typeof parsed.acquiredAt === "number" && now - parsed.acquiredAt > lockStaleMillis) {
            await unlink(filePath).catch(() => undefined);
          }
        } catch {
          continue;
        }
      }

      return { removed, scanned };
    },
  };
};
