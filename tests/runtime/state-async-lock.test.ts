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

  it("times out a queued caller without cancelling its ordered operation", async () => {
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

    release();
    await first;
    await vi.waitFor(() => {
      expect(queued).toHaveBeenCalledOnce();
    });
  });
});
