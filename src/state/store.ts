import type { Clock, StateStore } from "../runtime/ports.js";

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
