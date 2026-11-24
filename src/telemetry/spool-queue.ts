import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
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

/**
 * Why a queued batch was dropped rather than delivered.
 *
 * - `age` — older than the queue's `maxAgeMillis`.
 * - `size` — evicted (or refused) to stay within `maxBytes`.
 * - `count` — evicted (or refused) to stay within the batch-count bound.
 * - `rejected` — the destination answered with a non-retryable status on replay,
 *   so sending it again could never succeed.
 */
export type SpoolDropReason = "age" | "size" | "count" | "rejected";

/** Drop counts, persisted beside the queue so they outlive the process that dropped. */
export type SpoolDropCounts = {
  readonly total: number;
  readonly age: number;
  readonly size: number;
  readonly count: number;
  readonly rejected: number;
  readonly lastDroppedAt?: number;
};

export type SpoolStats = {
  readonly batches: number;
  readonly bytes: number;
  /** Enqueue time of the oldest queued batch. Absent when the queue is empty. */
  readonly oldestEnqueuedAt?: number;
  readonly dropped: SpoolDropCounts;
};

/**
 * What a queue does when a new batch would exceed a bound.
 *
 * `refuse-new` keeps what is queued and reports the new batch as lost — the
 * original behavior, still the default for a queue built directly. `drop-oldest`
 * evicts from the head until the new batch fits, which is what the runtime's
 * per-destination spools use.
 */
export type SpoolOverflowPolicy = "refuse-new" | "drop-oldest";

/**
 * What a drain's sender reports for one batch: delivered (`true`), still
 * undeliverable and worth retrying (`false`), or permanently undeliverable
 * (`"discard"`), which removes it and counts it as a `rejected` drop instead of
 * stopping the drain behind it.
 */
export type SpoolSendOutcome = boolean | "discard";

export const EMPTY_SPOOL_DROP_COUNTS: SpoolDropCounts = Object.freeze({
  total: 0,
  age: 0,
  size: 0,
  count: 0,
  rejected: 0,
});

/** Outcome of validating one batch read back from a queue file. */
export type SpoolValidation<TBatch> =
  | { readonly batch: TBatch }
  | { readonly rejection: string };

export type SpoolQueueOptions<TBatch> = StoreNamespace & {
  readonly rootDir: string;
  readonly clock: Clock;
  readonly logger?: Logger;
  /** Bound on the number of queued batches. */
  readonly maxFiles: number;
  /** Bound on the total bytes of queued batches. Unbounded when absent. */
  readonly maxBytes?: number;
  /** A batch older than this is dropped, at enqueue and at drain. No age bound when absent. */
  readonly maxAgeMillis?: number;
  /** Default `refuse-new`. */
  readonly overflow?: SpoolOverflowPolicy;
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
    send: (batch: TBatch) => Promise<SpoolSendOutcome>,
    options?: { readonly maxBatches?: number },
  ): Promise<SpoolDrainResult>;
  size(): Promise<number>;
  /** Depth, bytes, and persisted drop counts. Read-only: creates no directory. */
  stats(): Promise<SpoolStats>;
}

/** Name of the drop-count file, inside the queue directory and outside its `*.json` listing. */
export const SPOOL_DROPS_FILE = ".drops";

/** Enqueue time encoded in a queue file name, or undefined for a foreign name. */
const enqueuedAtOf = (fileName: string): number | undefined => {
  const match = /^(\d{16})-/.exec(fileName);
  return match?.[1] === undefined ? undefined : Number(match[1]);
};

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

/** Read a queue directory's drop counts. Missing or unreadable reads as zero. */
export const readSpoolDropCounts = async (queueDir: string): Promise<SpoolDropCounts> => {
  try {
    const parsed = JSON.parse(await readFile(path.join(queueDir, SPOOL_DROPS_FILE), "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return EMPTY_SPOOL_DROP_COUNTS;
    }
    const record = parsed as Record<string, unknown>;
    const field = (name: string): number => (isCount(record[name]) ? record[name] : 0);
    return {
      total: field("total"),
      age: field("age"),
      size: field("size"),
      count: field("count"),
      rejected: field("rejected"),
      ...(isCount(record.lastDroppedAt) ? { lastDroppedAt: record.lastDroppedAt } : {}),
    };
  } catch {
    return EMPTY_SPOOL_DROP_COUNTS;
  }
};

/**
 * Depth, bytes, and drop counts of one queue directory, without creating it.
 *
 * Exported for `doctor`, which inspects queues on disk without constructing the
 * sinks that own them.
 */
export const readSpoolQueueStats = async (queueDir: string): Promise<SpoolStats> => {
  let entries: string[];
  try {
    entries = await readdir(queueDir);
  } catch {
    return { batches: 0, bytes: 0, dropped: await readSpoolDropCounts(queueDir) };
  }
  const files = entries.filter((entry) => entry.endsWith(".json") && !entry.startsWith(".tmp-")).sort();
  let bytes = 0;
  for (const file of files) {
    try {
      bytes += (await stat(path.join(queueDir, file))).size;
    } catch {
      // Drained by a peer between the listing and the stat.
    }
  }
  const oldest = files[0] === undefined ? undefined : enqueuedAtOf(files[0]);
  return {
    batches: files.length,
    bytes,
    ...(oldest === undefined ? {} : { oldestEnqueuedAt: oldest }),
    dropped: await readSpoolDropCounts(queueDir),
  };
};

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

  /**
   * Add drops to the persisted counts.
   *
   * A read-modify-write without a lock: two processes dropping at the same moment
   * can lose one increment. The counts are a diagnostic, not an invoice, and a
   * lock here would put a second contention point on the failure path.
   */
  const recordDrops = async (reason: SpoolDropReason, dropped: number): Promise<void> => {
    if (dropped <= 0) {
      return;
    }
    try {
      const current = await readSpoolDropCounts(queueDir);
      const next: SpoolDropCounts = {
        ...current,
        total: current.total + dropped,
        [reason]: current[reason] + dropped,
        lastDroppedAt: options.clock.now(),
      };
      const tmp = path.join(queueDir, `.tmp-${randomBytes(6).toString("hex")}.drops`);
      await writeFile(tmp, JSON.stringify(next), "utf8");
      await rename(tmp, path.join(queueDir, SPOOL_DROPS_FILE));
    } catch {
      // Counting is best-effort; the drop itself already happened.
    }
    options.logger?.warn("durable spool dropped batches", {
      "spool.queue": options.queueName,
      "spool.drop_reason": reason,
      "spool.dropped": dropped,
    });
  };

  type QueuedFile = { readonly name: string; readonly enqueuedAt?: number; readonly bytes: number };

  const listWithSizes = async (): Promise<QueuedFile[]> => {
    const names = await listSorted();
    const files: QueuedFile[] = [];
    for (const name of names) {
      let bytes = 0;
      if (options.maxBytes !== undefined) {
        try {
          bytes = (await stat(path.join(queueDir, name))).size;
        } catch {
          continue;
        }
      }
      const enqueuedAt = enqueuedAtOf(name);
      files.push({ name, bytes, ...(enqueuedAt === undefined ? {} : { enqueuedAt }) });
    }
    return files;
  };

  /** Remove queued files; the count is what actually left the queue. */
  const evict = async (files: readonly QueuedFile[]): Promise<number> => {
    let removed = 0;
    for (const file of files) {
      try {
        await unlink(path.join(queueDir, file.name));
        removed += 1;
      } catch {
        // Already drained or evicted by a peer: it left the queue either way, but
        // not because of this process, so it is not counted here.
      }
    }
    return removed;
  };

  const isExpired = (file: QueuedFile, now: number): boolean =>
    options.maxAgeMillis !== undefined &&
    file.enqueuedAt !== undefined &&
    now - file.enqueuedAt > options.maxAgeMillis;

  const enqueue = async (batch: TBatch): Promise<SpoolEnqueueResult> => {
    await ensureDirs();
    const serialized = JSON.stringify(batch);
    const bytes = Buffer.byteLength(serialized, "utf8");
    const refuse = async (reason: "size" | "count"): Promise<SpoolEnqueueResult> => {
      options.logger?.warn("durable spool at capacity; batch dropped", {
        "spool.max_files": options.maxFiles,
        ...(options.maxBytes === undefined ? {} : { "spool.max_bytes": options.maxBytes }),
        "spool.queue": options.queueName,
      });
      await recordDrops(reason, 1);
      return { spooled: false, reason: "capacity-exceeded" };
    };

    if (options.maxBytes !== undefined && bytes > options.maxBytes) {
      // Larger than the whole budget: evicting everything else still would not
      // make room, so it is the one batch that is refused under either policy.
      return refuse("size");
    }

    let queued = await listWithSizes();
    const now = options.clock.now();
    const expired = queued.filter((file) => isExpired(file, now));
    if (expired.length > 0) {
      await recordDrops("age", await evict(expired));
      queued = queued.filter((file) => !isExpired(file, now));
    }

    const overflow = options.overflow ?? "refuse-new";
    const totalBytes = (): number => queued.reduce((sum, file) => sum + file.bytes, 0);
    if (overflow === "refuse-new") {
      if (queued.length >= options.maxFiles) {
        return refuse("count");
      }
      if (options.maxBytes !== undefined && totalBytes() + bytes > options.maxBytes) {
        return refuse("size");
      }
    } else {
      // Oldest first: the listing is sorted by enqueue time.
      const overCount = Math.max(0, queued.length + 1 - options.maxFiles);
      if (overCount > 0) {
        await recordDrops("count", await evict(queued.slice(0, overCount)));
        queued = queued.slice(overCount);
      }
      if (options.maxBytes !== undefined) {
        let excess = totalBytes() + bytes - options.maxBytes;
        let cut = 0;
        while (excess > 0 && cut < queued.length) {
          excess -= queued[cut]?.bytes ?? 0;
          cut += 1;
        }
        if (cut > 0) {
          await recordDrops("size", await evict(queued.slice(0, cut)));
          queued = queued.slice(cut);
        }
      }
    }

    const fileName = `${String(now).padStart(16, "0")}-${randomBytes(6).toString("hex")}.json`;
    const target = path.join(queueDir, fileName);
    const tmp = path.join(queueDir, `.tmp-${randomBytes(6).toString("hex")}.json`);
    await writeFile(tmp, serialized, "utf8");
    await rename(tmp, target);
    return { spooled: true };
  };

  const drain = async (
    send: (batch: TBatch) => Promise<SpoolSendOutcome>,
    drainOptions?: { readonly maxBatches?: number },
  ): Promise<SpoolDrainResult> => {
    await ensureDirs();
    const cap = drainOptions?.maxBatches ?? DEFAULT_DRAIN_MAX_BATCHES;
    let files = await listSorted();
    if (options.maxAgeMillis !== undefined) {
      // Expired batches are dropped, not sent: a collector would place them far in
      // the past, and they would spend this invocation's short flush window.
      const now = options.clock.now();
      const expired = files
        .map((name): QueuedFile => {
          const enqueuedAt = enqueuedAtOf(name);
          return { name, bytes: 0, ...(enqueuedAt === undefined ? {} : { enqueuedAt }) };
        })
        .filter((file) => isExpired(file, now));
      if (expired.length > 0) {
        await recordDrops("age", await evict(expired));
        const gone = new Set(expired.map((file) => file.name));
        files = files.filter((name) => !gone.has(name));
      }
    }
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

      let delivered: SpoolSendOutcome;
      try {
        delivered = await send(validation.batch);
      } catch {
        delivered = false;
      }
      if (delivered === "discard") {
        // Permanently refused: retrying can never succeed, and stopping here would
        // wedge every batch queued behind it.
        if (await unlink(filePath).then(() => true, () => false)) {
          await recordDrops("rejected", 1);
        }
        continue;
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
    stats: (): Promise<SpoolStats> => readSpoolQueueStats(queueDir),
  };
};
