# ADR 0001: Invocation identity is isolated and immutable

- Status: accepted
- Date: 2026-07-25
- Milestone: M1 (core contract)

## Context

A coding-agent hook runs many times per session, sometimes concurrently: a tool
hook and a generation hook can fire while a subagent is running, and a single
host process may embed the library more than once. Telemetry libraries commonly
solve identity by holding a module-level "current session" or "active tracer"
and mutating it as work starts and stops.

That pattern fails here in two specific ways:

1. Concurrent invocations overwrite each other's session, so events get attached
   to whichever invocation wrote last. The corruption is silent and looks like
   real data.
2. Ambient identity makes configuration and identity interchangeable. Once a
   session id can arrive through an environment variable, any process that
   inherits that variable inherits the identity too.

## Decision

1. `InvocationIdentity` is a value: parsed, frozen, and passed explicitly to
   every function that needs it. There is no module-level identity, session,
   tracer, or workspace anywhere in the package.
2. Identity is resolved once per invocation from *claims*. Each claim carries a
   source label and a detection confidence. For every field, only the
   highest-confidence claims are considered; two distinct values at that
   confidence produce a conflict.
3. Attribution fails closed. On conflict, or when `invocationId`/`sessionId` are
   missing, the invocation is not attributed at all and no events are emitted.
   `startedAt` and an `unknown` workspace may come from an explicit fallback,
   because neither asserts anything false.
4. Runtime exporter policy (`ExporterPolicy`) and identity are separate types
   with no shared field names, and no environment variable sets identity.
5. Consumer-supplied metadata is opaque: carried and exported, never
   interpreted, and sanitized through the privacy service on the way in.

## Consequences

- Two hooks in one process cannot see each other's identity. A test asserts
  this by running two hooks over different sessions.
- Some observations are dropped rather than labelled. That is the intended
  trade: a mislabelled session silently corrupts every aggregate computed from
  it, while a missing one is visible as a gap and reported as a diagnostic.
- Provider adapters cannot resolve identity themselves; they contribute claims.
  Arbitration lives in one place and is tested independently of any provider.

## Alternatives considered

- **Ambient current-session singleton.** Rejected: unsafe under concurrency, and
  it makes identity reachable through configuration.
- **Merging conflicting claims by precedence order.** Rejected: source order is
  not evidence. Two adapters that both claim certainty about different sessions
  indicate a detection bug, and picking one hides it.
- **Generating a session id when none is found.** Rejected: a synthetic session
  id looks identical to a real one downstream and inflates session counts.
