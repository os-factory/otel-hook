# ADR 0007: Replay-stable delivery deduplication

- Status: accepted
- Date: 2026-07-26
- Milestone: M2 (delivery guarantees)

## Context

Coding-agent hosts redeliver hook callbacks: a retried invocation, a duplicated
event, a replayed transcript. Until now the runtime deduplicated only against an
explicit, host-supplied `--callback-id`, and hosts that supply none got duplicate
spans and — worse — duplicate usage accounting.

The obvious identifiers cannot carry the guarantee. `invocationId` is seeded with
a clock reading by some adapters (Claude Code documents each hook firing as a
distinct invocation), and `eventId` is seeded with a session sequence number that
has already advanced by the time a redelivery arrives. Neither is replay-stable.

Payloads *do* often carry something that is: a `tool_use_id`, a `turn_id`, a
`generationId`, a provider-recorded `timestamp`. But only the adapter knows which
of its fields those are, and none of them are safe to use naively — some
callbacks fire more than once for the same field value, and some payload fields
are content rather than identifiers.

## Decision

1. **Adapters declare coverage and report components, not ids.** A new capability
   `deliveryIdentifier` (`none | partial | all`) states how much of a provider's
   traffic is replay-identifiable, and an optional `deliveryIdentity(input,
   context)` returns a `ProviderDeliveryClaim` per callback: the provider's
   session id, its own event name, identifier-shaped `components`, and `evidence`
   naming the fields used. Returning nothing is always safe.

2. **The runtime owns normalization.** `resolveDeliveryIdentity` digests provider
   id, installation id, and session id into an opaque *scope*, and event name plus
   components into an opaque *callback id*. The digest comes from the injected
   `IdGenerator`, which is content-addressed (ADR 0006), so a later process
   recomputes the identical pair without reading state — that is what makes the
   identity survive a restart.

3. **Components are structurally constrained to identifiers.**
   `DELIVERY_COMPONENT_PATTERN` admits provider ids, integer counters, event
   names, and ISO-8601 timestamps, and rejects anything containing whitespace or a
   path separator. An adapter that seeds an identity with a prompt, a tool
   response, or a home directory produces a *rejected claim*, not a privacy
   incident. A claim that throws or fails the schema degrades to "no identity",
   never to a failed invocation.

4. **Ownership is two-phase.** `claim` records intent before anything is exported
   and `commit` records completion afterwards, under the store's session lock. A
   delivery arriving between the two sees `in-flight` and stands down, so the
   window in which a crash could produce a double export does not exist. An
   uncommitted claim older than `staleClaimMillis` (default 60,000ms) is
   reclaimable, so a crash costs a delayed export rather than a permanent loss.

   `staleClaimMillis` is **raised to a derived floor** rather than honoured
   verbatim: state-lock wait + every export attempt the exporter policy permits +
   the bounded flush, plus a scheduling margin. A window shorter than one process's
   own work is not a weaker guarantee but an inverted one — a peer declares a live
   holder abandoned and both export the same callback. Raising it is logged with
   both the requested and effective values.

   `commit` also requires the observation to be **durable**, and the test is *any*
   rather than *all* — `DeliveryDurability`, computed once by `classifyDurability`:

   | Fate | Meaning | Claim |
   | --- | --- | --- |
   | `nothing-to-deliver` | Suppressed, or no events | committed |
   | `delivered` | Every span reached the collector or the spool | committed |
   | `partial` | Some reached it, some did not | **committed**, loss reported |
   | `lost` | Nothing reached it | **released** for retry |

   A successful spool enqueue counts as delivered, because a later invocation
   drains it. `lost` is released and `delivery.retryable` reported, so the next
   delivery is fresh work — committing there would be an at-most-*zero* guarantee:
   the telemetry gone and the claim forbidding a retry.

   `partial` is terminal, and that is the uncomfortable but correct answer.
   Retrying it would re-export every span a collector already accepted, converting
   a reported loss into a silent double-count; a duplicated span corrupts a total
   nobody can reconstruct, while a reported loss is a number somebody can act on.
   So the callback commits and `delivery.partialLoss` states how many spans went
   with it.

5. **Deduplication decides before `ingest`.** `OtelHook.resolveDelivery` is a
   separate, synchronous, side-effect-free step that runs only `detect` and
   `deliveryIdentity`. A caller that learned the identity afterwards could only
   suppress a duplicate it had already sent.

6. **A duplicate is parsed but mutates nothing.** `ingest` takes a `suppress`
   option: the adapter still runs, so the provider's protocol response is derived
   from a real parse — a redelivered callback still expects its response — but
   nothing is exported, the session sequence counter is not advanced, and no
   cumulative usage baseline is rewritten. Usage rollups are skipped too.

   9. **`ingest` is a three-phase transaction**, because "prepared" and "committed"
   are different states and only one of them may touch accounting:

   1. *Prepare*, under the session lock: read the sequence, parse, screen, and
      reserve the sequence range. Reservation is deliberately not rolled back, so a
      failed callback leaves a **gap** in the numbering — invisible to a collector,
      and far cheaper than a reused number.
   2. *Deliver*, with no lock held: export, and classify the result.
   3. *Commit*, under the session lock again, and only when the fate is
      committable: derive usage deltas and advance the cumulative baseline; the
      runtime then applies the rollups.

   Usage accounting sits in phase 3 rather than phase 1 because both halves of it
   are one-way. Advancing a cumulative baseline destroys the difference the
   callback represented, so a lost callback that had already advanced it would
   release its claim and the retry would diff the same snapshot against itself and
   report zero. Delta usage fails the mirror image: it needs no baseline, so a
   retry simply accumulates the same delta twice. Nothing exported depends on these
   numbers — a span carries the usage the provider *reported*, never the derived
   delta — so deferring them is free.

   The baseline read, the diff, and the write-back stay inside one critical
   section, so two concurrent processes cannot diff against the same snapshot. The
   rollup apply is a second, sequential critical section (the accumulator takes the
   same non-reentrant session lock), which leaves a narrow crash window between
   baseline and rollup; baseline-first is chosen so that window under-counts a
   rollup rather than leaving the next diff to over-count.

   Suppressing at the sink instead was tried and is wrong: a discarding sink stops
   the *export* while the orchestrator still advances canonical state, so a
   redelivered callback renumbered every later event in the session and changed its
   derived event id — the exact replay-stability this ADR exists to protect.

7. **Same-scope deliveries are serialized in arrival order**, so deduplication
   never reorders the callbacks it lets through. Unrelated scopes stay concurrent.
   That in-process lock does not order *different* callbacks across processes, so
   `ingest` additionally holds the store's cross-process session lock across the
   session-state critical section (read sequence → parse → derive usage → commit
   sequence). Export happens after that lock is released: the span correlator takes
   the same session lock from inside the sink, and the lock is not reentrant, so
   exporting under it would self-deadlock. Lock order is therefore always
   delivery-scope lock → state lock, never the reverse, and no state lock is ever
   held while another is acquired.

8. **A missing guarantee is reported, not inferred.** `requireCallbackId` raises
   `delivery-identifier-unavailable` per unidentifiable callback, naming the
   provider, its declared capability, the reason, and the remedy. It is fail-open
   (ADR 0004): the callback is still exported and still accounted, because losing
   a real observation is unrecoverable and exporting a possible duplicate is not.

## Consequences

- Hosts get redelivery *suppression* for identifiable callbacks with no
  configuration at all, and can audit the rest with `--require-callback-id`.
- **This is at-least-once export, not exactly-once, and the ADR does not claim
  otherwise.** OTLP acceptance and the local claim commit are two systems with no
  transaction between them, so a process killed after the collector accepted a batch
  and before `commit` re-exports on redelivery. The alternative ordering — commit,
  then export — converts that window into *silent loss*, which is strictly worse:
  a duplicate carries the same derived trace and span id and is therefore droppable
  at the collector, while a missing observation is undetectable downstream. Local
  accounting is committed under the claim's own lock and is at-most-once.
- Rollup application is *not* idempotent by delivery identity. Making it so would
  require the rollup write and the claim commit to be one atomic operation, and the
  state store has no multi-key transaction; simulating one across keys would be a
  pseudo-transaction whose failure modes are harder to reason about than the
  single-increment under-count it would close. The window is documented and the
  baseline is ordered first so the *next* observation stays correct.
- `staleClaimMillis` is a conservative floor, not a proof. Claims therefore carry an
  owner token verified at commit: a claim reclaimed under a live holder produces
  `delivery-claim-superseded` rather than a silent double count, which is what makes
  a mis-sized window an operator-visible condition instead of a corrupted total.
- `ProviderCapabilities` gained a required field, which is a breaking change for
  third-party adapters. That is deliberate: an undeclared capability is exactly
  the ambiguity capability declarations exist to remove.
- No raw provider identifier reaches a state key or a diagnostic attribute as a
  side effect of deduplicating on it.
- Deduplication coverage is per callback, and every shipped adapter is `partial`.
  What each one cannot identify is enumerated in the README's known limitations
  and asserted by name in `tests/providers/delivery-identity.test.ts`.
- Detection runs twice per invocation (once to resolve the delivery, once inside
  `ingest`). `detect` is contractually cheap and side-effect free, so this buys
  the ordering guarantee above at a measured cost.
- Genuine lock *contention* declines the observation for retry rather than
  processing unserialized. `AsyncLock.run` **cancels** a queued operation whose
  caller timed out waiting, so this is a provable statement rather than a hopeful
  one: nothing was read, reserved, or written, which is what makes the retry a
  clean second attempt rather than a second half-application. A store that cannot
  lock at all — an unwritable directory, a full disk — is a different condition: it
  protects nothing, so processing continues unserialized and fails open. The two
  are distinguished by type (`isStateLockContention`), not by message.

## Alternatives considered

- **Hash the whole payload into a delivery id.** Rejected: it is content-derived
  by construction, it would make an identity change whenever a host restamps a
  field, and it puts prompts and tool responses into the id derivation path.
- **Mark seen before ingest, single-phase.** Rejected: a process killed after the
  mark loses that callback's telemetry permanently, with no way to tell a crash
  from a completed export.
- **Mark seen after export.** Rejected: it leaves a real window in which a
  concurrent or retried delivery exports the same callback twice.
- **Let the adapter return a finished id.** Rejected: it puts scoping, digesting,
  and the privacy guard in five places instead of one, and nothing would stop a
  raw session id from reaching disk.
- **Use a provider-recorded timestamp for every callback.** Rejected wherever
  genuine firings can share a millisecond — suppressing a real callback to catch a
  hypothetical duplicate trades a certain loss for a possible one. This is why the
  Gemini CLI adapter claims only `SessionStart` and `SessionEnd`: its protocol
  carries no request, turn, or tool-call id, so a millisecond reading is the only
  candidate, and it repeats on redelivery without separating two real occurrences.
- **Put the policy in `OtelHookConfig`.** Rejected: deduplication is a property of
  the integration runtime that owns the state store, not of the canonical model's
  configuration, and ADR 0001 keeps that boundary narrow.
