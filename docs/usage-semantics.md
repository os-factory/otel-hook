# Canonical usage semantics

This document defines exactly what each token counter means, which combinations
are legal, and how observations compose. See
[ADR 0002](adr/0002-versioned-canonical-model.md) for why the model is shaped
this way.

## Fields

| Field                       | Meaning                                                            |
| --------------------------- | ------------------------------------------------------------------ |
| `temporality`               | `delta` (change since the last observation) or `cumulative` (running total) |
| `inputTokens`               | **Inclusive** input total attributed to the observation             |
| `cachedInputTokens`         | **Subset** of `inputTokens` served from a prompt cache              |
| `cacheCreationInputTokens`  | Tokens written to a prompt cache                                    |
| `cacheCreationAccounting`   | Whether cache-creation tokens sit inside `inputTokens` or beside it  |
| `outputTokens`              | **Inclusive** output total                                          |
| `reasoningOutputTokens`     | **Subset** of `outputTokens` spent on reasoning                     |
| `uncachedInputTokens`       | *Derived.* Input that was neither a cache read nor a cache write     |
| `totalTokens`               | *Derived.* Canonical billable total                                  |
| `providerTotalTokens`       | The provider's own total, verbatim, if it reported one               |
| `providerTotalAgreement`    | *Derived.* `unreported` \| `agrees` \| `disagrees`                    |

Subset fields are never additions. `inputTokens = uncachedInputTokens +
cachedInputTokens + (cacheCreationInputTokens if included-in-input)`.

## Cache-creation accounting

Providers differ on whether writing to a prompt cache is billed inside the input
total or as a separate bucket, so the mode is explicit:

| Mode                  | Meaning                                                      | Effect on `totalTokens`         |
| --------------------- | ------------------------------------------------------------ | ------------------------------- |
| `included-in-input`   | `cacheCreationInputTokens` ⊆ `inputTokens`                    | not added again                 |
| `disjoint-from-input` | Cache-creation tokens are billed **in addition** to input     | added                           |
| `not-reported`        | Provider exposes no cache-creation counter                    | pinned to zero                  |

`totalTokens = inputTokens + (cacheCreationInputTokens if disjoint-from-input) + outputTokens`.

## Normalization rules

`normalizeUsage(report)` is the only constructor for `CanonicalUsage`. It is
deterministic:

1. Absent counters default to `0`. `providerTotalTokens` stays absent.
2. Non-integer, negative, and non-finite counters are **rejected**.
3. Unknown fields and unknown `temporality` values are **rejected**.
4. A subset exceeding its total is **rejected**, never clamped — clamping would
   invent a billing story from a provider bug.
5. `cacheCreationAccounting` defaults to `not-reported` when no cache-creation
   tokens are reported, and is **required** when they are. It is never inferred:
   guessing the mode mis-totals every downstream cost calculation.
6. A provider total that disagrees with the canonical total is preserved as
   reported and flagged `disagrees`. Both numbers survive; neither is edited.

Derived fields are part of `canonicalUsageSchema` and re-checked on parse, so an
inconsistent usage object cannot exist even if hand-built.

## Temporality

`delta` observations compose; `cumulative` observations do not. Accordingly:

- `addUsage(a, b)` requires both to be `delta` and throws otherwise.
- `cumulativeToDelta(previous, current)` requires both to be `cumulative` and
  returns `{ usage, resetDetected }`.

`cumulativeToDelta` is replay-safe:

- Re-processing the same snapshot yields an all-zero delta.
- If any counter decreases, the series restarted (new session, replayed
  transcript, provider reset). That is reported as `resetDetected: true` with the
  current snapshot as the delta — never a negative delta.
- Diffing across differing `cacheCreationAccounting` modes throws, because the
  subtraction would be meaningless.

## Derivation in the runtime

Events keep whatever the provider reported. The orchestrator derives deltas
*alongside* them, returning `UsageObservation[]` from `ingest`:

```text
UsageObservation = { eventId, sequence, scope, scopeKey, reportedTemporality, delta, resetDetected }
```

Scopes and their state keys:

| Event                   | Scope        | Scope key               |
| ----------------------- | ------------ | ----------------------- |
| `session.end`           | `session`    | `sessionId`             |
| `compaction.performed`  | `session`    | `sessionId`             |
| `generation.end`        | `generation` | `generationId`          |
| `subagent.end`          | `subagent`   | `subagentInvocationId`  |

Baselines are stored at `usage:<sessionId>:<scope>:<scopeKey>`. A `delta` report
passes through unchanged. A `cumulative` report with no stored baseline is
emitted as its own first delta. If the baseline cannot be read, the observation
is **skipped** with a `state-store-failure` diagnostic — emitting the raw
snapshot would double-count.

### Which series a cumulative report continues

The scope an observation is *attributed to* and the series its baseline is *read
from* are two different questions, and conflating them silently multiplies usage.

A provider declares the answer with
`ProviderCapabilities.cumulativeUsageSeries`:

| Value                       | The baseline for a `generation.end` snapshot is…                |
| --------------------------- | --------------------------------------------------------------- |
| `event-scope` (default)     | the previous snapshot **for that same `generationId`**           |
| `session-lifetime`          | the previous snapshot **anywhere in the session**                |

`event-scope` is right for a provider whose counter restarts per generation.
`session-lifetime` is right for one that keeps a single running total for the
whole session and stamps it onto whichever callback reports next — Codex, whose
every usage-bearing hook carries the rollout's session-wide `total_token_usage`.

For such a provider, keying the baseline by `generationId` is a correctness bug,
not a modelling preference: each turn has a fresh `turn_id`, so every snapshot
would find no predecessor and be emitted whole. A three-turn session reporting
13 500 → 22 500 → 25 300 would bill 61 300 instead of 25 300.

Two details make this safe rather than merely different:

- The **observation** keeps `scope: "generation"` and its own `scopeKey`. A
  turn's token spend is still attributed to that turn; only the subtraction
  changed. Session-level events (`compaction.performed`) land on the same series,
  so a compaction snapshot continues the curve instead of starting a competing
  baseline.
- **Subagent scopes are never redirected.** A delegated agent's counter is its
  own series, not a point on the parent's curve. Folding it in would read as a
  reset every time a subagent reported a total below the parent's.

Rewinding is still reported, never hidden: replaying a session from the top makes
the counter regress, which surfaces as a single `resetDetected` observation
restating the snapshot. That is indistinguishable from a genuine restart — Codex
reuses a session id after a `/clear` — so the contract is to flag it rather than
to guess which one happened.
