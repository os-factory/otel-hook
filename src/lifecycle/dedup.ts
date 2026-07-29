import { randomBytes } from "node:crypto";

import type { Attributes } from "../model/primitives.js";
import type { Clock, StateRecord, StateStore } from "../runtime/ports.js";
import { withOptionalSessionLock } from "../state/store.js";
import { dedupKey, dedupScanPrefix, dedupScopeOf } from "./keys.js";

export type DedupCheckResult = {
  /** True when `callbackId` was already marked seen for this scope. */
  readonly duplicate: boolean;
};

export type DedupCleanupResult = {
  readonly removed: number;
  readonly scanned: number;
  /**
   * Aged-out records the sweep deliberately kept because they are uncommitted
   * claims younger than the stale-claim window — a live process may still be
   * working on them.
   *
   * Reported rather than merely not-removed, because the two are indistinguishable
   * in `removed` and only one of them means "retention is configured shorter than
   * this installation's own export budget". Absent when nothing was retained.
   */
  readonly retainedInFlight?: number;
};

/**
 * What happened when a delivery tried to take ownership of a callback id.
 *
 * - `fresh`: nothing had this id. The caller owns it and must `commit`.
 * - `duplicate`: a previous delivery ran this callback to completion.
 * - `in-flight`: another delivery holds the id right now — a concurrent process,
 *   or one that has not committed yet. Treated as a duplicate.
 * - `reclaimed`: a claim was abandoned long enough ago to be assumed dead, and
 *   this delivery has taken it over. The caller owns it and must `commit`.
 */
export type DeliveryClaimOutcome = "fresh" | "duplicate" | "in-flight" | "reclaimed";

export type DeliveryClaimResult = {
  readonly outcome: DeliveryClaimOutcome;
  /** True for `duplicate` and `in-flight`: the caller must not export or account. */
  readonly duplicate: boolean;
  /** True for `fresh` and `reclaimed`: the caller owns the id and should commit. */
  readonly owned: boolean;
  /** How many deliveries have claimed this id, including this one. */
  readonly attempt: number;
  /** Age of the claim that was taken over. Present only for `reclaimed`. */
  readonly abandonedForMillis?: number;
  /**
   * Opaque proof that *this* delivery owns the claim. Present when `owned`.
   *
   * No floor computation can be proven exact, so the stale window may still be too
   * short for some real installation. Passing this back to {@link
   * CallbackDeduplicator.commit} turns that from a silent double-count into a
   * detected, reported condition: if a peer reclaimed the id in the meantime the
   * record carries a different token, and the commit refuses rather than
   * overwriting the peer's in-flight work.
   */
  readonly owner?: string;
};

/** Whether a commit actually took effect. */
export type DeliveryCommitResult = {
  readonly status: "committed" | "superseded";
  /** The attempt number recorded, for diagnostics. */
  readonly attempt: number;
};

export type DeliveryClaimOptions = {
  /**
   * How long an uncommitted claim is respected before it is assumed to belong to
   * a process that died mid-flight. Default 60,000ms.
   */
  readonly staleClaimMillis?: number;
};

/**
 * Delivery guard: suppresses a redelivered callback while local state is intact.
 *
 * Deliberately not described as "exactly-once". This records intent and completion
 * in a local store; the collector it protects is a separate system with no shared
 * transaction, so a process killed between an accepted export and `commit` leaves a
 * callback that will be exported again. What this guarantees is that a redelivery
 * seen by a *live* store is suppressed, and that a crash is recoverable rather than
 * either silently lost or permanently blocked.
 *
 * Coding-agent hosts redeliver callbacks — a retried hook invocation, a
 * duplicated event, a replayed transcript — and a deterministic identity makes
 * the replay recomputable, but something still has to remember which identities
 * have already been handled. This is that memory: a bounded, TTL-swept set of
 * seen ids per scope, independent of what the id actually names.
 *
 * Ownership is two-phase on purpose. `claim` records an intent before the caller
 * exports anything and `commit` records completion afterwards, so the window
 * where a crash could produce a double export does not exist: a second delivery
 * arriving in that window sees `in-flight` and stands down. The cost of that
 * choice is that a process killed between the two leaves an uncommitted claim,
 * which is why an old one is reclaimable rather than permanent — permanent would
 * turn every crash into silently lost telemetry.
 */
export interface CallbackDeduplicator {
  /**
   * Single-phase check: marks the id complete immediately and reports whether it
   * had been seen. Retained for callers that have nothing to protect between the
   * check and the side effect; `claim`/`commit` is the stronger guarantee.
   */
  checkAndMark(scope: string, callbackId: string): Promise<DedupCheckResult>;
  /** Take ownership of a callback id before acting on it. */
  claim(
    scope: string,
    callbackId: string,
    options?: DeliveryClaimOptions,
  ): Promise<DeliveryClaimResult>;
  /**
   * Record that a claimed callback ran to completion.
   *
   * `owner` is the token {@link DeliveryClaimResult.owner} handed out. Supplied and
   * matching, the claim completes. Supplied and *not* matching, the claim has been
   * reclaimed by a peer while this delivery was still working, and the commit is
   * refused — reported as `"superseded"` so the caller can say so instead of
   * silently marking a callback handled that somebody else is mid-flight on.
   */
  commit(scope: string, callbackId: string, owner?: string): Promise<DeliveryCommitResult>;
  /**
   * Give up a claim without completing it, so the next delivery of the same
   * callback is treated as fresh instead of waiting out the stale window.
   */
  release(scope: string, callbackId: string): Promise<void>;
  /**
   * Drop dedup records older than `maxAgeMillis`.
   *
   * An uncommitted claim is held back until it is also older than
   * `staleClaimMillis`, whatever the retention says. Retention is an operator's
   * answer to "how long should a handled callback stay recognizable"; the stale
   * window is a statement about how long one process's own work can take. Deleting
   * a claim inside that window would hand the callback to a concurrent delivery as
   * *fresh* while the holder is still exporting it — a retention setting silently
   * converting suppression into a double export, which is the opposite of what
   * tightening retention looks like it does.
   */
  cleanup(
    maxAgeMillis: number,
    options?: {
      readonly maxEntries?: number;
      readonly sessionId?: string;
      /** Floor on how long an uncommitted claim survives. Default 60,000ms. */
      readonly staleClaimMillis?: number;
    },
  ): Promise<DedupCleanupResult>;
}

export type CallbackDeduplicatorDependencies = {
  readonly stateStore: StateStore;
  readonly clock: Clock;
};

const DEFAULT_STALE_CLAIM_MILLIS = 60_000;

type DedupState = "claimed" | "completed";

/**
 * Read the recorded state of a dedup record.
 *
 * A record written by an older release carries only `seenAt`, which meant
 * "handled". Absent a `state` field it is therefore read as `completed`, so an
 * upgrade never resurrects a callback the previous version had already exported.
 */
const stateOf = (record: StateRecord | undefined): DedupState | undefined => {
  if (record?.value.kind !== "attributes") {
    return undefined;
  }
  const declared = record.value.attributes.state;
  if (declared === "claimed" || declared === "completed") {
    return declared;
  }
  return "completed";
};

const attemptOf = (record: StateRecord | undefined): number => {
  if (record?.value.kind !== "attributes") {
    return 0;
  }
  const attempt = record.value.attributes.attempt;
  return typeof attempt === "number" && Number.isInteger(attempt) && attempt > 0 ? attempt : 1;
};

const ownerOf = (record: StateRecord | undefined): string | undefined => {
  if (record?.value.kind !== "attributes") {
    return undefined;
  }
  const owner = record.value.attributes.owner;
  return typeof owner === "string" && owner.length > 0 ? owner : undefined;
};

const newOwnerToken = (): string => randomBytes(12).toString("hex");

const claimedAtOf = (record: StateRecord | undefined): number | undefined => {
  if (record?.value.kind !== "attributes") {
    return undefined;
  }
  const claimedAt = record.value.attributes.claimedAt;
  return typeof claimedAt === "number" ? claimedAt : record.updatedAt;
};

export const createCallbackDeduplicator = (
  deps: CallbackDeduplicatorDependencies,
): CallbackDeduplicator => {
  const { stateStore, clock } = deps;

  const write = (key: string, attributes: Attributes): Promise<unknown> =>
    stateStore.write(key, { kind: "attributes", attributes });

  const checkAndMark = (scope: string, callbackId: string): Promise<DedupCheckResult> =>
    withOptionalSessionLock(stateStore, scope, async (): Promise<DedupCheckResult> => {
      const key = dedupKey(scope, callbackId);
      const existing = await stateStore.read(key);
      if (existing?.value.kind === "attributes") {
        return { duplicate: true };
      }
      const now = clock.now();
      await write(key, {
        state: "completed",
        attempt: 1,
        claimedAt: now,
        seenAt: now,
        owner: newOwnerToken(),
      });
      return { duplicate: false };
    });

  const claim = (
    scope: string,
    callbackId: string,
    options?: DeliveryClaimOptions,
  ): Promise<DeliveryClaimResult> =>
    withOptionalSessionLock(stateStore, scope, async (): Promise<DeliveryClaimResult> => {
      const staleClaimMillis = options?.staleClaimMillis ?? DEFAULT_STALE_CLAIM_MILLIS;
      const key = dedupKey(scope, callbackId);
      const existing = await stateStore.read(key);
      const state = stateOf(existing);
      const now = clock.now();

      if (state === "completed") {
        return { outcome: "duplicate", duplicate: true, owned: false, attempt: attemptOf(existing) };
      }

      if (state === "claimed") {
        const claimedAt = claimedAtOf(existing) ?? now;
        const age = now - claimedAt;
        if (age <= staleClaimMillis) {
          return {
            outcome: "in-flight",
            duplicate: true,
            owned: false,
            attempt: attemptOf(existing),
          };
        }
        const attempt = attemptOf(existing) + 1;
        const owner = newOwnerToken();
        await write(key, { state: "claimed", attempt, claimedAt: now, owner });
        return {
          outcome: "reclaimed",
          duplicate: false,
          owned: true,
          attempt,
          abandonedForMillis: age,
          owner,
        };
      }

      const owner = newOwnerToken();
      await write(key, { state: "claimed", attempt: 1, claimedAt: now, owner });
      return { outcome: "fresh", duplicate: false, owned: true, attempt: 1, owner };
    });

  const commit = (
    scope: string,
    callbackId: string,
    owner?: string,
  ): Promise<DeliveryCommitResult> =>
    withOptionalSessionLock(stateStore, scope, async (): Promise<DeliveryCommitResult> => {
      const key = dedupKey(scope, callbackId);
      const existing = await stateStore.read(key);
      const now = clock.now();
      const attempt = Math.max(attemptOf(existing), 1);

      const recordedOwner = ownerOf(existing);
      if (owner !== undefined && recordedOwner !== undefined && recordedOwner !== owner) {
        // A peer reclaimed this id while we were still working, which means the
        // stale window was shorter than this installation's real worst case.
        // Completing it now would tell that peer's delivery to stand down after it
        // has already exported. Refusing is the honest answer, and being able to
        // say so is the point of the token: no floor computation can be proven
        // exact, so the failure has to be detectable rather than merely unlikely.
        return { status: "superseded", attempt };
      }

      await write(key, {
        state: "completed",
        attempt,
        claimedAt: claimedAtOf(existing) ?? now,
        completedAt: now,
        seenAt: now,
        ...(recordedOwner === undefined ? {} : { owner: recordedOwner }),
      });
      return { status: "committed", attempt };
    });

  const release = (scope: string, callbackId: string): Promise<void> =>
    withOptionalSessionLock(stateStore, scope, async (): Promise<void> => {
      const key = dedupKey(scope, callbackId);
      // Only an uncommitted claim is droppable: releasing a completed record
      // would re-open a callback whose telemetry has already been exported.
      if (stateOf(await stateStore.read(key)) === "claimed") {
        await stateStore.delete(key);
      }
    });

  const cleanup = async (
    maxAgeMillis: number,
    options?: {
      readonly maxEntries?: number;
      readonly sessionId?: string;
      readonly staleClaimMillis?: number;
    },
  ): Promise<DedupCleanupResult> => {
    const keys = await stateStore.keys(dedupScanPrefix(options?.sessionId));
    const cap = options?.maxEntries ?? 1_000;
    const staleClaimMillis = options?.staleClaimMillis ?? DEFAULT_STALE_CLAIM_MILLIS;
    const now = clock.now();
    let removed = 0;
    let scanned = 0;
    let retainedInFlight = 0;

    /** Whether this record may be dropped, counting a live claim as it goes. */
    const isDroppable = (record: StateRecord | undefined, count: boolean): boolean => {
      if (record === undefined || now - record.updatedAt <= maxAgeMillis) {
        return false;
      }
      if (stateOf(record) === "claimed") {
        const age = now - (claimedAtOf(record) ?? record.updatedAt);
        if (age <= staleClaimMillis) {
          if (count) {
            retainedInFlight += 1;
          }
          return false;
        }
      }
      return true;
    };

    for (const key of keys) {
      if (scanned >= cap) {
        break;
      }
      scanned += 1;

      // Unlocked first pass. It decides only whether this key is worth locking for,
      // which is what keeps a sweep of a mostly-live store from paying a lock
      // acquisition per record: the common answer is "not aged out, leave it".
      if (!isDroppable(await stateStore.read(key), true)) {
        continue;
      }

      const scope = dedupScopeOf(key);
      if (scope === undefined) {
        // A key from a previous layout version: unreachable by any current read, so
        // there is no claim to race and no scope to lock on.
        await stateStore.delete(key);
        removed += 1;
        continue;
      }

      // Locked second pass, because a peer's `claim` takes this same lock and may
      // have refreshed the record since the first read. Deciding once, outside the
      // lock, would let a sweep delete a claim written microseconds earlier — and the
      // concurrent redelivery would then read `fresh` and export a second time.
      await withOptionalSessionLock(stateStore, scope, async (): Promise<void> => {
        if (!isDroppable(await stateStore.read(key), false)) {
          return;
        }
        await stateStore.delete(key);
        removed += 1;
      });
    }

    return {
      removed,
      scanned,
      ...(retainedInFlight === 0 ? {} : { retainedInFlight }),
    };
  };

  return { checkAndMark, claim, commit, release, cleanup };
};
