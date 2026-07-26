import type { Clock, StateStore } from "../runtime/ports.js";
import { LockWaitTimeoutError } from "./async-lock.js";

/**
 * A lock could not be acquired within its wait bound because somebody else holds
 * it.
 *
 * Distinct from "the store is broken" on purpose, and the distinction is
 * load-bearing for callers that guard a read-modify-write with it. Contention
 * means a peer is plausibly *inside* the critical section right now, so
 * proceeding unlocked would produce exactly the lost update the lock exists to
 * prevent. A store that cannot lock at all — an unwritable directory, a full
 * disk — protects nothing, because the state the lock guards is equally
 * unreachable; there proceeding is the fail-open answer and costs nothing.
 */
export class StateLockTimeoutError extends Error {
  public readonly lockKey: string;

  public constructor(key: string, timeoutMillis: number) {
    super(`state store lock wait for "${key}" exceeded ${String(timeoutMillis)}ms`);
    this.name = "StateLockTimeoutError";
    this.lockKey = key;
  }
}

/**
 * Whether a thrown value means "somebody else holds the lock".
 *
 * Also true for {@link LockWaitTimeoutError}, the in-process variant, which
 * carries a second warning for callers: a timed-out wait does not cancel the
 * queued critical section, so it may still run afterwards. A caller that treats
 * contention as "retry unlocked" would therefore risk running the section twice.
 */
export const isStateLockContention = (thrown: unknown): boolean =>
  thrown instanceof StateLockTimeoutError || thrown instanceof LockWaitTimeoutError;

/**
 * Optional capability beyond the frozen {@link StateStore} contract: a
 * session-scoped lock a caller can use to make a multi-step read-modify-write
 * atomic across an entire session, not just a single key.
 *
 * Deliberately keyed by an explicit `sessionId` the caller already knows,
 * rather than derived by parsing the store's own keys, so a store never has
 * to understand any particular key scheme.
 */
export interface LockingStateStore extends StateStore {
  withSessionLock<T>(
    sessionId: string,
    fn: () => Promise<T>,
    options?: { readonly timeoutMillis?: number },
  ): Promise<T>;
}

export const isLockingStateStore = (store: StateStore): store is LockingStateStore =>
  typeof (store as Partial<LockingStateStore>).withSessionLock === "function";

/** Runs `fn` under the store's session lock when it has one; otherwise runs it directly. */
export const withOptionalSessionLock = async <T>(
  store: StateStore,
  sessionId: string,
  fn: () => Promise<T>,
  options?: { readonly timeoutMillis?: number },
): Promise<T> => {
  if (isLockingStateStore(store)) {
    return store.withSessionLock(sessionId, fn, options);
  }
  return fn();
};

export type StateStoreDependencies = {
  readonly clock: Clock;
};
