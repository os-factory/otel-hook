/**
 * State key namespaces for lifecycle bookkeeping.
 *
 * Prefixed with `lifecycle:` so these keys can never collide with the
 * orchestrator's own `sequence:<sessionId>` and `usage:<sessionId>:...` keys
 * in the same {@link StateStore}, even though both share the store.
 */
export const LIFECYCLE_PREFIX = "lifecycle";

export const spanKey = (sessionId: string, scope: string, scopeKey: string): string =>
  `${LIFECYCLE_PREFIX}:span:${sessionId}:${scope}:${scopeKey}`;

export const spanScanPrefix = (sessionId?: string): string =>
  sessionId === undefined ? `${LIFECYCLE_PREFIX}:span:` : `${LIFECYCLE_PREFIX}:span:${sessionId}:`;

export const dedupKey = (sessionId: string, callbackId: string): string =>
  `${LIFECYCLE_PREFIX}:dedup:${sessionId}:${callbackId}`;

export const dedupScanPrefix = (sessionId?: string): string =>
  sessionId === undefined ? `${LIFECYCLE_PREFIX}:dedup:` : `${LIFECYCLE_PREFIX}:dedup:${sessionId}:`;

export const rollupUsageKey = (sessionId: string, scope: string, scopeKey: string): string =>
  `${LIFECYCLE_PREFIX}:usage:${sessionId}:${scope}:${scopeKey}`;

export const rollupEpochKey = (sessionId: string, scope: string, scopeKey: string): string =>
  `${LIFECYCLE_PREFIX}:epoch:${sessionId}:${scope}:${scopeKey}`;

export const rollupScanPrefix = (sessionId?: string): string =>
  sessionId === undefined ? `${LIFECYCLE_PREFIX}:usage:` : `${LIFECYCLE_PREFIX}:usage:${sessionId}:`;

export const rollupEpochScanPrefix = (sessionId?: string): string =>
  sessionId === undefined ? `${LIFECYCLE_PREFIX}:epoch:` : `${LIFECYCLE_PREFIX}:epoch:${sessionId}:`;
