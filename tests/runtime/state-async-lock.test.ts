import { describe, expect, it, vi } from "vitest";

import { createAsyncLock, LockWaitTimeoutError } from "../../src/state/async-lock.js";

const delay = (millis: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, millis);
  });

describe("createAsyncLock", () => {
  it("does not apply the acquisition timeout to work after the lock is acquired", async () => {
    const lock = createAsyncLock();

    await expect(
      lock.run(
        "key",
        async () => {
          await delay(30);
          return "done";
        },
        5,
      ),
    ).resolves.toBe("done");
  });

  it("cancels a queued caller that timed out, so its work never runs", async () => {
    const lock = createAsyncLock();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const first = lock.run("key", async () => {
      signalStarted();
      await gate;
    });
    await started;

    const queued = vi.fn(() => Promise.resolve("queued"));
    await expect(lock.run("key", queued, 5)).rejects.toBeInstanceOf(LockWaitTimeoutError);
    expect(queued).not.toHaveBeenCalled();

    // The holder finishes and the queue drains. The cancelled operation must stay
    // cancelled: its caller has already been told the lock could not be taken and
    // has reported that nothing happened, so running it now would mutate state
    // after the fact, with nobody watching the result.
    release();
    await first;
    await delay(20);
    expect(queued).not.toHaveBeenCalled();
  });

  it("keeps the queue ordered across a cancelled slot", async () => {
    const lock = createAsyncLock();
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });

    const first = lock.run("key", async () => {
      signalStarted();
      await gate;
      order.push("first");
    });
    await started;

    // A doomed waiter between two live ones. Cancelling it must not let the third
    // jump the queue, and must not strand it behind a slot that never settles.
    const doomed = lock.run("key", () => {
      order.push("doomed");
      return Promise.resolve();
    }, 5).catch(() => order.push("doomed-cancelled"));
    const third = lock.run("key", () => {
      order.push("third");
      return Promise.resolve();
    });

    await doomed;
    release();
    await Promise.all([first, third]);

    expect(order).toEqual(["doomed-cancelled", "first", "third"]);
  });

  it("does not cancel work that already acquired the key", async () => {
    const lock = createAsyncLock();
    const ran = vi.fn();

    // The timeout expires while `fn` is mid-flight. Interrupting a
    // read-modify-write partway through is the corruption a mutex exists to
    // prevent, so acquisition is the point of no return.
    await expect(
      lock.run(
        "key",
        async () => {
          await delay(40);
          ran();
          return "finished";
        },
        5,
      ),
    ).resolves.toBe("finished");
    expect(ran).toHaveBeenCalledOnce();
  });

  it("still runs a queued caller that has no timeout at all", async () => {
    const lock = createAsyncLock();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = lock.run("key", () => gate);

    const patient = vi.fn(() => Promise.resolve("patient"));
    const second = lock.run("key", patient);

    release();
    await expect(second).resolves.toBe("patient");
    await first;
    expect(patient).toHaveBeenCalledOnce();
  });
});
