import type { Attributes } from "@opentelemetry/api";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";

import type { Clock, Logger } from "../runtime/ports.js";
import { namespaceSegments, type StoreNamespace } from "../state/keys.js";

export type SerializedSpan = {
  readonly name: string;
  readonly kind: number;
  readonly traceId: string;
  readonly spanId: string;
  readonly startMillis: number;
  readonly endMillis: number;
  readonly attributes: Attributes;
  readonly statusCode: number;
  readonly statusMessage?: string;
};

export type SpoolBatch = {
  readonly providerId: string;
  readonly installationId: string;
  readonly resourceAttributes: Attributes;
  readonly instrumentationScope: { readonly name: string; readonly version?: string };
  readonly spans: readonly SerializedSpan[];
  readonly enqueuedAt: number;
};

export type SpoolEnqueueResult =
  | { readonly spooled: true }
  | { readonly spooled: false; readonly reason: "capacity-exceeded" };

export type SpoolDrainResult = {
  readonly drained: number;
  readonly remaining: number;
  readonly failed: number;
};

export type DurableSpoolOptions = StoreNamespace & {
  readonly rootDir: string;
  readonly clock: Clock;
  readonly logger?: Logger;
  /** Refuses new entries once this many are queued, rather than growing without bound. Default 500. */
  readonly maxSpoolFiles?: number;
};

/**
 * Durable filesystem queue for export batches a collector could not accept.
 *
 * A hook process is short-lived, so "retry later" means "persist and let a
 * later invocation retry" rather than an in-process backoff loop. Each
 * instance is rooted at `<rootDir>/<providerId>/<installationId>/spool`; two
 * spools for different providers or installations never share a directory,
 * so a batch from one identity cannot physically land in another's drain —
 * batches cannot mix identities by construction, not by a runtime check
 * alone (the check in {@link DurableSpool.drain} is defense in depth for a
 * hand-edited or misplaced file).
 */
export interface DurableSpool {
  enqueue(batch: SpoolBatch): Promise<SpoolEnqueueResult>;
  /** Sequential, bounded drain: stops after the first failed send, or after `maxBatches`. */
  drain(
    send: (batch: SpoolBatch) => Promise<boolean>,
    options?: { readonly maxBatches?: number },
  ): Promise<SpoolDrainResult>;
  size(): Promise<number>;
}

const isErrnoException = (thrown: unknown, code: string): boolean =>
  thrown instanceof Error && (thrown as NodeJS.ErrnoException).code === code;

export const createFileDurableSpool = (options: DurableSpoolOptions): DurableSpool => {
  const [providerSegment, installationSegment] = namespaceSegments(options);
  const spoolDir = path.join(options.rootDir, providerSegment, installationSegment, "spool");
  const corruptDir = path.join(options.rootDir, providerSegment, installationSegment, "spool-corrupt");
  const maxSpoolFiles = options.maxSpoolFiles ?? 500;

  let dirsReady: Promise<void> | undefined;
  const ensureDirs = async (): Promise<void> => {
    if (dirsReady !== undefined) {
      return dirsReady;
    }
    const promise = (async (): Promise<void> => {
      await mkdir(spoolDir, { recursive: true });
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
      entries = await readdir(spoolDir);
    } catch (thrown) {
      if (isErrnoException(thrown, "ENOENT")) {
        return [];
      }
      throw thrown;
    }
    return entries.filter((entry) => entry.endsWith(".json") && !entry.startsWith(".tmp-")).sort();
  };

  const enqueue = async (batch: SpoolBatch): Promise<SpoolEnqueueResult> => {
    await ensureDirs();
    const existing = await listSorted();
    if (existing.length >= maxSpoolFiles) {
      options.logger?.warn("durable spool at capacity; batch dropped", {
        "spool.max_files": maxSpoolFiles,
      });
      return { spooled: false, reason: "capacity-exceeded" };
    }
    const fileName = `${String(options.clock.now()).padStart(16, "0")}-${randomBytes(6).toString("hex")}.json`;
    const target = path.join(spoolDir, fileName);
    const tmp = path.join(spoolDir, `.tmp-${randomBytes(6).toString("hex")}.json`);
    await writeFile(tmp, JSON.stringify(batch), "utf8");
    await rename(tmp, target);
    return { spooled: true };
  };

  const drain = async (
    send: (batch: SpoolBatch) => Promise<boolean>,
    drainOptions?: { readonly maxBatches?: number },
  ): Promise<SpoolDrainResult> => {
    await ensureDirs();
    const cap = drainOptions?.maxBatches ?? 20;
    const files = await listSorted();
    let drained = 0;
    let failed = 0;
    let index = 0;

    for (; index < files.length && index < cap; index += 1) {
      const fileName = files[index];
      if (fileName === undefined) {
        break;
      }
      const filePath = path.join(spoolDir, fileName);
      let batch: SpoolBatch;
      try {
        const raw = await readFile(filePath, "utf8");
        batch = JSON.parse(raw) as SpoolBatch;
      } catch {
        await rename(filePath, path.join(corruptDir, fileName)).catch(() => undefined);
        continue;
      }
      if (batch.providerId !== options.providerId || batch.installationId !== options.installationId) {
        await rename(filePath, path.join(corruptDir, fileName)).catch(() => undefined);
        options.logger?.error("durable spool refused a batch with a mismatched identity", {});
        continue;
      }

      let delivered: boolean;
      try {
        delivered = await send(batch);
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
    return { drained, remaining, failed };
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
