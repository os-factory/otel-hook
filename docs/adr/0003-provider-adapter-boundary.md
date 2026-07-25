# ADR 0003: Provider payloads stop at the adapter boundary

- Status: accepted
- Date: 2026-07-25
- Milestone: M1 (core contract)

## Context

Hook payloads are the most sensitive data this library touches: prompts, tool
arguments, file paths, and occasionally credentials pasted into a conversation.
They are also the least stable — each provider changes its schema on its own
schedule.

If a payload, or any fragment of one, can travel past the adapter, then every
downstream component becomes a potential disclosure path and every provider
schema change becomes a core-package change.

## Decision

1. `ProviderAdapter` receives the payload as `unknown` and is the only component
   permitted to interpret it. Nothing it returns may contain payload-derived
   data except canonical model values.
2. The contract is four separate methods, because each has different obligations:
   - `detect` — cheap, side-effect free, no filesystem or network. Returns a
     confidence (`none` | `weak` | `strong` | `exact`) and short non-sensitive
     reasons. Returning `none` is always allowed; guessing is not.
   - `identify` — contributes identity claims, arbitrated by the core (ADR 0001).
   - `parse` — produces canonical events, or `ignored`, or `failed`.
   - `hookResponse` — derives the provider's stdout contract from the outcome
     alone (ADR 0004).
3. Adapters receive a `ProviderContext` with the privacy service, clock, id
   generator, logger, and limits — and nothing else. There is no filesystem or
   network handle, so an adapter cannot scan transcript directories.
4. Content must be described through the privacy service (`describeContent`,
   `describeStructured`), which returns a `ContentFact`. Adapters cannot build a
   fact with text by hand and have it survive: the orchestrator drops events
   whose disclosure does not match the resolved policy.
5. `createEventFactory` owns identity, provenance, sequence numbering, and
   derived event ids, so an adapter cannot renumber a sequence or attach the
   wrong session.
6. The registry is a value, not a mutable global. Unknown providers stay unknown:
   no adapter, ambiguity between equally-confident adapters, or confidence below
   the configured minimum all resolve to `unknown` with attribution declined.
7. An adapter that throws is contained. Its peers are still consulted, and the
   thrown message never reaches a diagnostic — only the error class name.

## Consequences

- A new provider is a new adapter plus fixtures; the core model does not change.
- Adapters cannot leak by accident: extensions and attributes accept only
  primitives, and content facts are produced by the privacy service.
- Adapters cannot implement clever cross-session correlation by reading files.
  That is deliberate — such correlation is exactly what produces mis-attributed
  sessions.
- Detection confidence must be honest. An adapter that always claims `exact`
  makes every registry containing it ambiguous, which surfaces as declined
  attribution rather than as wrong data.

## Alternatives considered

- **Passing raw payloads through for consumer-side enrichment.** Rejected: it
  makes every consumer a data processor for prompt content.
- **Boolean detection.** Rejected: it cannot express "this looks like my
  provider but I am not certain", so the registry could not distinguish a
  confident match from a hopeful one.
- **Letting adapters emit events without a factory.** Rejected: sequence and id
  derivation are what make replay safe, and they must not be per-adapter.
