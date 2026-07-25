import type { Clock, StateRecord, StateValue } from "../runtime/ports.js";
import { stateRecordSchema } from "../runtime/ports.js";
import { createAsyncLock } from "./async-lock.js";
import type { LockingStateStore } from "./store.js";

export type BoundedMemoryStateStoreOptions = {
  readonly clock: Clock;
  /** Oldest entry is evicted once this many keys are held. Default 10,000. */
  readonly maxEntries?: number;
  /** When set, a record older than this is treated as absent and dropped lazily. */
  readonly ttlMillis?: number;
  /** Bounds how long a `withSessionLock` call waits before rejecting. Default 5,000ms. */
  readonly lockTimeoutMillis?: number;
};

export interface BoundedMemoryStateStore extends LockingStateStore {
  size(): number;
  /** Actively removes expired entries; returns the count removed. */
  pruneExpired(now?: number): number;
}

/**
 * Production in-memory {@link StateStore}.
 *
 * Unlike the unbounded test double in `runtime/memory.ts`, this store is
 * meant to back a long-lived host process: it bounds its own size and can
 * expire entries by age, so a process that embeds many sessions over its
 * lifetime cannot grow without limit. State does not survive a process
 * restart; hosts that need it to should use the filesystem store instead.
 */
export const createBoundedMemoryStateStore = (
  options: BoundedMemoryStateStoreOptions,
): BoundedMemoryStateStore => {
  const records = new Map<string, StateRecord>();
  const keyLock = createAsyncLock();
  const sessionLock = createAsyncLock();
  const maxEntries = options.maxEntries ?? 10_000;
  const lockTimeoutMillis = options.lockTimeoutMillis ?? 5_000;

  const isExpired = (record: StateRecord, now: number): boolean =>
    options.ttlMillis !== undefined && now - record.updatedAt > options.ttlMillis;

  const evictOldestIfOverCapacity = (): void => {
    while (records.size > maxEntries) {
      let oldestKey: string | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [key, record] of records) {
        if (record.updatedAt < oldestAt) {
          oldestAt = record.updatedAt;
          oldestKey = key;
        }
      }
      if (oldestKey === undefined) {
        break;
      }
      records.delete(oldestKey);
    }
  };

  return {
    read: (key: string): Promise<StateRecord | undefined> =>
      keyLock.run(key, (): Promise<StateRecord | undefined> => {
        const record = records.get(key);
        if (record === undefined) {
          return Promise.resolve(undefined);
        }
        if (isExpired(record, options.clock.now())) {
          records.delete(key);
          return Promise.resolve(undefined);
        }
        return Promise.resolve(record);
      }),
    write: (key: string, value: StateValue): Promise<StateRecord> =>
      keyLock.run(key, (): Promise<StateRecord> => {
        const previous = records.get(key);
        const record = stateRecordSchema.parse({
          revision: (previous?.revision ?? 0) + 1,
          updatedAt: options.clock.now(),
          value,
        });
        records.set(key, record);
        evictOldestIfOverCapacity();
        return Promise.resolve(record);
      }),
    delete: (key: string): Promise<void> =>
      keyLock.run(key, (): Promise<void> => {
        records.delete(key);
        return Promise.resolve();
      }),
    keys: (prefix: string): Promise<readonly string[]> =>
      Promise.resolve([...records.keys()].filter((key) => key.startsWith(prefix)).sort()),
    withSessionLock: <T>(
      sessionId: string,
      fn: () => Promise<T>,
      lockOptions?: { readonly timeoutMillis?: number },
    ): Promise<T> => sessionLock.run(sessionId, fn, lockOptions?.timeoutMillis ?? lockTimeoutMillis),
    size: (): number => records.size,
    pruneExpired: (now?: number): number => {
      const cutoff = now ?? options.clock.now();
      let removed = 0;
      for (const [key, record] of records) {
        if (isExpired(record, cutoff)) {
          records.delete(key);
          removed += 1;
        }
      }
      return removed;
    },
  };
};
