import type { Clock, StateStore } from "../runtime/ports.js";
import { withOptionalSessionLock } from "../state/store.js";
import { dedupKey, dedupScanPrefix } from "./keys.js";

export type DedupCheckResult = {
  /** True when `callbackId` was already marked seen for this session. */
  readonly duplicate: boolean;
};

export type DedupCleanupResult = { readonly removed: number; readonly scanned: number };

/**
 * Generic at-least-once delivery guard.
 *
 * Coding-agent hosts can redeliver a callback (a retried hook invocation, a
 * duplicated event), and the deterministic {@link IdGenerator} makes replays
 * produce the same id — but something still has to remember which ids have
 * already been handled. This is that memory: a bounded, TTL-swept set of seen
 * ids per session, independent of what the id actually names (an event id, a
 * provider request id, a span correlation key all work).
 */
export interface CallbackDeduplicator {
  checkAndMark(sessionId: string, callbackId: string): Promise<DedupCheckResult>;
  cleanup(
    maxAgeMillis: number,
    options?: { readonly maxEntries?: number; readonly sessionId?: string },
  ): Promise<DedupCleanupResult>;
}

export type CallbackDeduplicatorDependencies = {
  readonly stateStore: StateStore;
  readonly clock: Clock;
};

export const createCallbackDeduplicator = (
  deps: CallbackDeduplicatorDependencies,
): CallbackDeduplicator => {
  const { stateStore, clock } = deps;

  const checkAndMark = (sessionId: string, callbackId: string): Promise<DedupCheckResult> =>
    withOptionalSessionLock(stateStore, sessionId, async (): Promise<DedupCheckResult> => {
      const key = dedupKey(sessionId, callbackId);
      const existing = await stateStore.read(key);
      if (existing?.value.kind === "attributes") {
        return { duplicate: true };
      }
      await stateStore.write(key, { kind: "attributes", attributes: { seenAt: clock.now() } });
      return { duplicate: false };
    });

  const cleanup = async (
    maxAgeMillis: number,
    options?: { readonly maxEntries?: number; readonly sessionId?: string },
  ): Promise<DedupCleanupResult> => {
    const keys = await stateStore.keys(dedupScanPrefix(options?.sessionId));
    const cap = options?.maxEntries ?? 1_000;
    const now = clock.now();
    let removed = 0;
    let scanned = 0;
    for (const key of keys) {
      if (scanned >= cap) {
        break;
      }
      scanned += 1;
      const record = await stateStore.read(key);
      if (record !== undefined && now - record.updatedAt > maxAgeMillis) {
        await stateStore.delete(key);
        removed += 1;
      }
    }
    return { removed, scanned };
  };

  return { checkAndMark, cleanup };
};
