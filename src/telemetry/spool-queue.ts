import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";

import type { Clock, Logger } from "../runtime/ports.js";
import { namespaceSegments, type StoreNamespace } from "../state/keys.js";

export type SpoolEnqueueResult =
  | { readonly spooled: true }
  | { readonly spooled: false; readonly reason: "capacity-exceeded" };

export type SpoolDrainResult = {
  readonly drained: number;
  readonly remaining: number;
  readonly failed: number;
  /**
   * Batches removed from the queue because they were unusable rather than
   * undeliverable.
   *
   * Distinct from `failed`, which means "the collector would not take it, try
   * later". A quarantined batch will never become deliverable, so counting it
   * separately is what stops a permanent problem from reading as transient.
   */
  readonly quarantined: number;
};

/** Outcome of validating one batch read back from a queue file. */
export type SpoolValidation<TBatch> =
  | { readonly batch: TBatch }
  | { readonly rejection: string };

export type SpoolQueueOptions<TBatch> = StoreNamespace & {
  readonly rootDir: string;
  readonly clock: Clock;
  readonly logger?: Logger;
  /** Refuses new entries once this many are queued, rather than growing without bound. */
  readonly maxFiles: number;
  /**
   * Directory holding the queue, under the identity namespace. One name per
   * signal, so a batch of one signal can never be drained by the other's sender —
   * the two encode different payloads and a mixed queue would quarantine
   * perfectly good batches.
   */
  readonly queueName: string;
  /** Re-validates a batch read back from disk, before any of it reaches a sender. */
  readonly validate: (value: unknown, identity: StoreNamespace) => SpoolValidation<TBatch>;
};

/**
 * Durable filesystem queue for export batches a collector could not accept.
 *
 * A hook process is short-lived, so "retry later" means "persist and let a later
 * invocation retry" rather than an in-process backoff loop. Each instance is
 * rooted at `<rootDir>/<providerId>/<installationId>/<queueName>`; two queues for
 * different providers, installations, or signals never share a directory, so a
 * batch from one identity cannot physically land in another's drain — batches
 * cannot mix identities by construction, not by a runtime check alone (the check
 * inside {@link SpoolQueue.drain} is defense in depth for a hand-edited or
 * misplaced file).
 *
 * Shared by the trace and log spools rather than written twice: the drain's
 * quarantine-and-continue behavior is the subtle part, and a second copy of it is
 * a second place for the head-of-queue-blocking bug to come back.
 */
export interface SpoolQueue<TBatch> {
  enqueue(batch: TBatch): Promise<SpoolEnqueueResult>;
  /** Sequential, bounded drain: stops after the first failed send, or after `maxBatches`. */
  drain(
    send: (batch: TBatch) => Promise<boolean>,
    options?: { readonly maxBatches?: number },
  ): Promise<SpoolDrainResult>;
  size(): Promise<number>;
}

/** Default bound on a single drain pass, so one invocation's flush stays short. */
export const DEFAULT_DRAIN_MAX_BATCHES = 20;

const isErrnoException = (thrown: unknown, code: string): boolean =>
  thrown instanceof Error && (thrown as NodeJS.ErrnoException).code === code;

export const createSpoolQueue = <TBatch>(
  options: SpoolQueueOptions<TBatch>,
): SpoolQueue<TBatch> => {
  const [providerSegment, installationSegment] = namespaceSegments(options);
  const queueDir = path.join(options.rootDir, providerSegment, installationSegment, options.queueName);
  const corruptDir = path.join(
    options.rootDir,
    providerSegment,
    installationSegment,
    `${options.queueName}-corrupt`,
  );

  let dirsReady: Promise<void> | undefined;
  const ensureDirs = async (): Promise<void> => {
    if (dirsReady !== undefined) {
      return dirsReady;
    }
    const promise = (async (): Promise<void> => {
      await mkdir(queueDir, { recursive: true });
      await mkdir(corruptDir, { recursive: true });
    })();
    dirsReady = promise;
    try {
      await promise;
    } catch (thrown) {
      dirsReady = undefined;
      throw thrown;
    }
  };

  const listSorted = async (): Promise<readonly string[]> => {
    let entries: string[];
    try {
      entries = await readdir(queueDir);
    } catch (thrown) {
      if (isErrnoException(thrown, "ENOENT")) {
        return [];
      }
      throw thrown;
    }
    return entries.filter((entry) => entry.endsWith(".json") && !entry.startsWith(".tmp-")).sort();
  };

  const enqueue = async (batch: TBatch): Promise<SpoolEnqueueResult> => {
    await ensureDirs();
    const existing = await listSorted();
    if (existing.length >= options.maxFiles) {
      options.logger?.warn("durable spool at capacity; batch dropped", {
        "spool.max_files": options.maxFiles,
        "spool.queue": options.queueName,
      });
      return { spooled: false, reason: "capacity-exceeded" };
    }
    const fileName = `${String(options.clock.now()).padStart(16, "0")}-${randomBytes(6).toString("hex")}.json`;
    const target = path.join(queueDir, fileName);
    const tmp = path.join(queueDir, `.tmp-${randomBytes(6).toString("hex")}.json`);
    await writeFile(tmp, JSON.stringify(batch), "utf8");
    await rename(tmp, target);
    return { spooled: true };
  };

  const drain = async (
    send: (batch: TBatch) => Promise<boolean>,
    drainOptions?: { readonly maxBatches?: number },
  ): Promise<SpoolDrainResult> => {
    await ensureDirs();
    const cap = drainOptions?.maxBatches ?? DEFAULT_DRAIN_MAX_BATCHES;
    const files = await listSorted();
    let drained = 0;
    let failed = 0;
    let quarantined = 0;
    let index = 0;

    for (; index < files.length && index < cap; index += 1) {
      const fileName = files[index];
      if (fileName === undefined) {
        break;
      }
      const filePath = path.join(queueDir, fileName);

      /**
       * Move a file out of the queue, or delete it if quarantine is unavailable.
       *
       * Getting it *out of the queue* is the part that matters. A file the drain
       * cannot use and cannot move would be re-read on every pass, and because the
       * head is processed first it would block every healthy batch behind it — the
       * one failure mode a retry queue must not have. So a failed quarantine falls
       * back to deleting: losing one unusable batch beats losing all the usable
       * ones queued behind it.
       */
      const quarantine = async (rejection: string): Promise<void> => {
        quarantined += 1;
        options.logger?.error("durable spool quarantined an unusable batch", {
          "spool.rejection": rejection,
          "spool.file": fileName,
          "spool.queue": options.queueName,
        });
        try {
          await rename(filePath, path.join(corruptDir, fileName));
        } catch {
          await unlink(filePath).catch(() => undefined);
        }
      };

      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
      } catch {
        await quarantine("unparseable-json");
        continue;
      }

      const validation = options.validate(parsed, {
        providerId: options.providerId,
        installationId: options.installationId,
      });
      if ("rejection" in validation) {
        await quarantine(validation.rejection);
        continue;
      }

      let delivered: boolean;
      try {
        delivered = await send(validation.batch);
      } catch {
        delivered = false;
      }
      if (delivered) {
        await unlink(filePath).catch(() => undefined);
        drained += 1;
      } else {
        failed += 1;
        break;
      }
    }

    const remaining = (await listSorted()).length;
    return { drained, remaining, failed, quarantined };
  };

  return {
    enqueue,
    drain,
    size: async (): Promise<number> => {
      await ensureDirs();
      return (await listSorted()).length;
    },
  };
};
