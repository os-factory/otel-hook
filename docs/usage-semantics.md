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
