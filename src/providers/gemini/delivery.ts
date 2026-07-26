/**
 * Why no Gemini CLI callback carries a delivery identity.
 *
 * This file deliberately exports no `deliveryIdentity` function. The adapter
 * declares `deliveryIdentifier: "none"`, and this is the record of the field-by-
 * field reasoning behind that, so a future protocol version can be checked against
 * it rather than re-litigated from scratch.
 *
 * ## What the protocol provides
 *
 * Every Gemini hook input carries exactly three things that could bear on identity
 * (see `schema.ts`): `session_id`, `hook_event_name`, and an optional `timestamp`.
 * There is no request id, no turn id, and no tool-call id anywhere in the
 * vocabulary.
 *
 * ## Why a timestamp is not an identity
 *
 * `timestamp` is provider-recorded rather than read from a clock when the hook
 * runs, so it does repeat on redelivery. But repeating is only half of what an
 * identity needs: it must also *separate* two genuine firings, and a millisecond
 * reading does not. Two `BeforeTool` firings for the same tool inside one
 * millisecond — a loop issuing the same call, a parallel fan-out, a fast local
 * tool — produce byte-identical `(timestamp, tool_name)` pairs. Keying on that pair
 * makes the runtime suppress the *second real call* as though it were a
 * redelivery, which silently loses a span and its usage.
 *
 * ## Why `session_id` is not an identity either
 *
 * This is the subtler one, and it is why even the once-per-session events are
 * refused. `SessionStart` carries `source: "startup" | "resume" | "clear"`, so the
 * Gemini CLI fires it **again within the same `session_id`** when a session is
 * resumed or cleared. `(session_id, "SessionStart")` therefore names a *class* of
 * firings, not one firing. Treating it as an identity would suppress every resume
 * and every clear after the first — the user's session would appear to start once
 * and never restart, and the same argument applies to `SessionEnd` on the closing
 * side.
 *
 * A constant component would have made that worse rather than better: it looks
 * like a deliberate identity while being the least discriminating value possible.
 *
 * ## Consequence
 *
 * Deduplication for the Gemini CLI is available only against a host-supplied
 * `--callback-id`. `requireCallbackId` reports every callback as
 * `provider-declares-none`, which is the honest diagnostic: the gap is in the
 * protocol, not in this adapter's reading of it. Under-reporting coverage is
 * recoverable at a collector; suppressing a real observation is not.
 *
 * **To unblock:** a per-firing identifier in the Gemini hook payload — a request,
 * turn, or invocation id, or a `session_start_id` that changes on resume and clear.
 */

/**
 * Every callback, and the field that would have to exist to identify it.
 *
 * Documentation rather than control flow. Kept exhaustive so that adding a hook
 * event without revisiting delivery identity is visibly an omission.
 */
export const GEMINI_UNIDENTIFIABLE_CALLBACKS: Readonly<Record<string, string>> = Object.freeze({
  SessionStart:
    "fires again within the same session_id on resume and clear (payload `source`), so session_id names a class of firings rather than one",
  SessionEnd: "the closing side of the same problem: a cleared session ends under the same session_id",
  BeforeTool:
    "no tool-call id; two calls to one tool can share a millisecond, so (timestamp, tool_name) would suppress a genuine second call",
  AfterTool:
    "no tool-call id; two calls to one tool can share a millisecond, so (timestamp, tool_name) would suppress a genuine second call",
  BeforeAgent: "no turn id; fires once per turn with only a millisecond separating turns",
  AfterAgent: "no turn id; fires once per turn with only a millisecond separating turns",
  PreCompress: "no compaction id; can fire repeatedly within one session",
  BeforeModel: "no request id",
  AfterModel: "fires per streaming chunk, so several genuine firings share one request and often one millisecond",
  BeforeToolSelection: "no request id",
  Notification: "produces no canonical event",
});
