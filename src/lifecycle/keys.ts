/**
 * State key namespaces for lifecycle bookkeeping.
 *
 * Prefixed with `lifecycle:` so these keys can never collide with the
 * orchestrator's own `sequence:<sessionId>` and `usage:<sessionId>:...` keys
 * in the same {@link StateStore}, even though both share the store.
 *
 * Two properties are load-bearing here, because the store hashes a *whole
 * logical key* into one record: keys must be unambiguous, and a key space whose
 * layout changes must not be readable under its old meaning.
 */
export const LIFECYCLE_PREFIX = "lifecycle";

/**
 * Layout version of the span key space.
 *
 * Bumped when the *segments* change, not when a record's contents do — that is
 * {@link SPAN_RECORD_VERSION}'s job. Version 2 inserted the provider segment,
 * so a v1 key must never be reachable: reading one would pair a span across
 * providers, which is exactly the attribution guess this library refuses.
 */
export const SPAN_KEY_VERSION = 2;

/**
 * Layout version of the dedup key space.
 *
 * Version 2 re-scoped these keys from a session id to a delivery scope. The two
 * spaces are not interchangeable — a v1 key found under a v2 read would suppress
 * an unrelated callback — so the version segment keeps them disjoint.
 */
export const DEDUP_KEY_VERSION = 2;

/**
 * Make a variable segment unambiguous within a `:`-delimited key.
 *
 * Without this, `dedupKey("a:b", "c")` and `dedupKey("a", "b:c")` produce the
 * identical logical key, and the store hashes both to one record — so one
 * delivery silently suppresses an unrelated one. That is reachable input, not a
 * theoretical one: `--callback-scope` is host-supplied, and a provider's session
 * or tool-call id is not required to avoid a colon.
 *
 * `%` is escaped first so the encoding stays injective, which makes this a true
 * bijection on segments rather than a lossy scrub. A segment containing neither
 * character encodes to itself, so keys already on disk keep their identity and
 * no cumulative baseline is reset by adopting this.
 */
const encodeSegment = (segment: string): string =>
  segment.replaceAll("%", "%25").replaceAll(":", "%3A");

/**
 * Session first, then provider: the janitor sweeps a whole session by prefix,
 * so the session segment has to lead. The provider segment below it is what
 * makes cross-provider pairing impossible by construction rather than only by
 * the runtime check in the span correlator.
 */
export const spanKey = (
  sessionId: string,
  providerId: string,
  scope: string,
  scopeKey: string,
): string =>
  `${spanScanPrefix(sessionId)}${encodeSegment(providerId)}:${encodeSegment(scope)}:${encodeSegment(scopeKey)}`;

/**
 * The session-scoped prefix names one layout version; the bare prefix names
 * every one of them. That asymmetry is deliberate: a sweep must be able to
 * reclaim records written by a previous version, which a versioned prefix could
 * never match, while a *read* must never reach across a layout change.
 */
export const spanScanPrefix = (sessionId?: string): string =>
  sessionId === undefined
    ? `${LIFECYCLE_PREFIX}:span:`
    : `${LIFECYCLE_PREFIX}:span:v${String(SPAN_KEY_VERSION)}:${encodeSegment(sessionId)}:`;

/**
 * Dedup keys are scoped by a *delivery scope*, not by a session id.
 *
 * A host-supplied delivery id carries its own namespace, and a provider-derived
 * one is scoped by a digest of provider, installation, and session — so neither
 * is a session id, and neither can be found by scanning for one.
 */
export const dedupKey = (scope: string, callbackId: string): string =>
  `${dedupScanPrefix(scope)}${encodeSegment(callbackId)}`;

export const dedupScanPrefix = (scope?: string): string =>
  scope === undefined
    ? `${LIFECYCLE_PREFIX}:dedup:`
    : `${LIFECYCLE_PREFIX}:dedup:v${String(DEDUP_KEY_VERSION)}:${encodeSegment(scope)}:`;

const decodeSegment = (segment: string): string =>
  segment.replaceAll("%3A", ":").replaceAll("%25", "%");

/**
 * Recover the delivery scope a dedup key belongs to.
 *
 * Needed by the sweep and nothing else. A sweep enumerates keys rather than being
 * handed a scope, but deleting a dedup record is a read-modify-write against the
 * same record a concurrent `claim` is deciding on — so the sweep has to take the
 * same per-scope lock, and to take it, it has to know the scope. Recovering it
 * from the key is safe precisely because {@link encodeSegment} is injective.
 *
 * Returns `undefined` for a key from a previous layout version, which no lock
 * protects because no current read can reach it.
 */
export const dedupScopeOf = (key: string): string | undefined => {
  const prefix = `${LIFECYCLE_PREFIX}:dedup:v${String(DEDUP_KEY_VERSION)}:`;
  if (!key.startsWith(prefix)) {
    return undefined;
  }
  // Exactly two segments follow the prefix, and neither can contain a raw `:`,
  // so the first `:` after the prefix is unambiguously the boundary.
  const rest = key.slice(prefix.length);
  const boundary = rest.indexOf(":");
  return boundary <= 0 ? undefined : decodeSegment(rest.slice(0, boundary));
};

/**
 * Usage rollup keys are escaped but deliberately *not* versioned: their layout
 * has not changed, and a version segment would orphan every cumulative token
 * baseline on disk — resetting usage accounting to fix a bug that escaping
 * already fixes.
 */
export const rollupUsageKey = (sessionId: string, scope: string, scopeKey: string): string =>
  `${rollupScanPrefix(sessionId)}${encodeSegment(scope)}:${encodeSegment(scopeKey)}`;

export const rollupEpochKey = (sessionId: string, scope: string, scopeKey: string): string =>
  `${rollupEpochScanPrefix(sessionId)}${encodeSegment(scope)}:${encodeSegment(scopeKey)}`;

export const rollupScanPrefix = (sessionId?: string): string =>
  sessionId === undefined
    ? `${LIFECYCLE_PREFIX}:usage:`
    : `${LIFECYCLE_PREFIX}:usage:${encodeSegment(sessionId)}:`;

export const rollupEpochScanPrefix = (sessionId?: string): string =>
  sessionId === undefined
    ? `${LIFECYCLE_PREFIX}:epoch:`
    : `${LIFECYCLE_PREFIX}:epoch:${encodeSegment(sessionId)}:`;
