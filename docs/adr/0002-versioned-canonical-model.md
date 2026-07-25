# ADR 0002: A versioned canonical event model with explicit usage semantics

- Status: accepted
- Date: 2026-07-25
- Milestone: M1 (core contract)

## Context

Every coding agent describes its lifecycle differently: hook names, nesting,
what counts as a "turn", and above all how tokens are counted. Cached input is
sometimes a subset of the input total and sometimes an additional bucket; cache
creation is sometimes billed separately; some providers report a running total
per session while others report per call. If those differences reach consumers,
every consumer re-derives them, and each one gets a slightly different bill.

## Decision

1. One canonical, Zod-validated event model, versioned by
   `CANONICAL_SCHEMA_VERSION`, stamped on every event. Consumers treat an
   unknown version as unreadable rather than guessing.
2. Events are self-describing: identity, provenance, workspace, sequence, and
   timestamp are duplicated onto each event instead of referenced through shared
   state, so an event remains interpretable once it leaves the process.
3. Lifecycle coverage is a closed union: session, prompt, generation, tool,
   subagent, compaction, and error events.
4. Usage is explicit about what each number means:
   - `inputTokens` and `outputTokens` are **inclusive** totals.
   - `cachedInputTokens` and `reasoningOutputTokens` are **subsets** of those
     totals, never additions.
   - `cacheCreationInputTokens` carries a required
     `cacheCreationAccounting` discriminator (`included-in-input`,
     `disjoint-from-input`, `not-reported`) whenever it is non-zero.
   - `providerTotalTokens` is preserved verbatim alongside the canonical
     `totalTokens`, with a `providerTotalAgreement` flag when they differ.
   - `temporality` distinguishes `delta` from `cumulative` observations.
5. Invalid combinations are rejected, not clamped. Derived fields
   (`uncachedInputTokens`, `totalTokens`, `providerTotalAgreement`) are part of
   the schema and re-checked on parse, so an inconsistent usage object cannot
   exist even if hand-built.
6. Extensions are namespaced (`acme.tier`) and restricted to attribute
   primitives. Core namespaces are reserved.

Full semantics, including the normalization rules and the delta derivation, are
documented in `docs/usage-semantics.md`.

## Consequences

- Adapters must state their accounting mode. The alternative — inferring it —
  mis-totals every cost calculation downstream, so `normalizeUsage` refuses.
- A subset that exceeds its total is a hard error. Clamping would invent a
  plausible billing story from a provider bug.
- Because extension values cannot be nested objects, a raw provider payload
  cannot be smuggled out through an extension. The type system enforces
  ADR 0003 rather than relying on adapter discipline.
- Adding an optional field is a non-breaking change; re-interpreting a field
  requires a version bump.

## Alternatives considered

- **Pass provider usage through untouched.** Rejected: it moves the semantic
  problem to every consumer and makes cross-provider comparison meaningless.
- **A single `totalTokens` field.** Rejected: it cannot express cache economics,
  which is where most of the cost variance in agent workloads lives.
- **Normalizing cumulative reports into events in place.** Rejected: the
  provider's own number is evidence. Deltas are derived alongside the event
  (`UsageObservation`), so both survive.
