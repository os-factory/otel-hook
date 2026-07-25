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
   * `timeoutMillis` bounds how long the caller waits to acquire the key; it
   * does not bound `fn` after acquisition or cancel a queued operation.
   * Letting a timed-out caller skip the queue
   * would let it run concurrently with whoever still holds the key, which
   * defeats the point of a mutex. So a slow holder can make a waiter give up
   * on an answer while its own turn still arrives later, in order, and still
   * takes effect — the timeout bounds *waiting*, never *exclusivity*.
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
    const acquired = previous.then(
      () => undefined,
      () => undefined,
    );
    const current = acquired.then(fn);
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
        reject(new LockWaitTimeoutError(key, timeoutMillis));
      }, timeoutMillis);
      timer.unref?.();
    });
    try {
      await Promise.race([acquired, timeout]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
    return current;
  };

  return { run };
};
