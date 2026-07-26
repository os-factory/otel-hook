/**
 * Per-key async mutex.
 *
 * Ordinary promises already serialize a single caller's `await`s, but two
 * concurrent callers racing a read-modify-write against the same key (two
 * hook invocations updating the same session, in the same process) are not
 * serialized by anything. This chains each key's operations through a promise
 * tail so they run one at a time, in arrival order, without blocking unrelated
 * keys.
 */
export interface AsyncLock {
  /**
   * `timeoutMillis` bounds how long the caller waits to *acquire* the key.
   *
   * Two guarantees, and the boundary between them is the whole contract:
   *
   * - **A timed-out caller's `fn` never runs.** Giving up on the wait cancels the
   *   queued operation. It has to: a caller that has been told "I could not take
   *   the lock" will report contention and move on, and if `fn` then ran anyway it
   *   would mutate state after the caller had already declared that nothing
   *   happened. That is worse than either outcome on its own — the state changes
   *   and nobody is watching.
   * - **Work is never cancelled after acquisition.** Once `fn` has started the
   *   timeout is irrelevant; interrupting a read-modify-write partway through is
   *   exactly the corruption a mutex exists to prevent. So the timeout bounds
   *   *waiting*, never *exclusivity* and never *completion*.
   *
   * Cancellation does not let a waiter skip the queue: the cancelled slot still
   * settles in order, so everyone behind it keeps its place. A cancelled call
   * rejects with {@link LockWaitTimeoutError}, the same error a timed-out wait
   * produces, because from the caller's side they are one condition.
   */
  run<T>(key: string, fn: () => Promise<T>, timeoutMillis?: number): Promise<T>;
}

export class LockWaitTimeoutError extends Error {
  public readonly lockKey: string;

  public constructor(key: string, timeoutMillis: number) {
    super(`lock wait exceeded ${timeoutMillis}ms`);
    this.name = "LockWaitTimeoutError";
    this.lockKey = key;
  }
}

export const createAsyncLock = (): AsyncLock => {
  const tail = new Map<string, Promise<void>>();

  const run = async <T>(key: string, fn: () => Promise<T>, timeoutMillis?: number): Promise<T> => {
    const previous = tail.get(key) ?? Promise.resolve();
    const queued = previous.then(
      () => undefined,
      () => undefined,
    );

    /**
     * `entered` flips synchronously, immediately before `fn` is invoked, and
     * `cancelled` is only ever set from the timer while `entered` is false.
     *
     * That ordering is what makes the two guarantees exclusive rather than racy.
     * Microtasks drain before timers, so if this slot's turn has arrived at all,
     * the callback below has already run and set `entered` before any timer
     * callback can observe it — there is no window in which the timer sees a
     * not-yet-entered slot that is in fact about to run.
     */
    let cancelled = false;
    let entered = false;

    const current = queued.then((): T | Promise<T> => {
      if (cancelled) {
        // The waiter gave up before its turn came, so `fn` is skipped entirely.
        // The slot still settles here, in order, so nothing behind it is reordered.
        throw new LockWaitTimeoutError(key, timeoutMillis ?? 0);
      }
      entered = true;
      return fn();
    });

    const swallowed = current.then(
      () => undefined,
      () => undefined,
    );
    tail.set(key, swallowed);
    void swallowed.then(() => {
      if (tail.get(key) === swallowed) {
        tail.delete(key);
      }
    });

    if (timeoutMillis === undefined) {
      return current;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        if (!entered) {
          cancelled = true;
        }
        reject(new LockWaitTimeoutError(key, timeoutMillis));
      }, timeoutMillis);
      timer.unref?.();
    });
    try {
      // Raced against the queue gate, not against `current`: once the slot is
      // entered the caller waits for `fn` however long it takes.
      await Promise.race([queued, timeout]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
    return current;
  };

  return { run };
};
