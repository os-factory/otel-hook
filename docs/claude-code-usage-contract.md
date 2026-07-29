# Claude Code usage and compaction contract

What Claude Code actually reports, where it reports it, and which canonical
counters therefore cannot be filled. Written to settle `ADAPTER-NOTE-001` and
`ADAPTER-NOTE-002`, which both said "this repository cannot decide without a
real capture".

See [usage-semantics.md](usage-semantics.md) for what the canonical counters
mean, and [ADR 0003](adr/0003-provider-adapter-boundary.md) for why the adapter
may not go looking for these numbers itself.

## How this was established

Two independent read-only observations, both against **Claude Code 2.1.220**:

1. **The hook contract**, read from the shipped CLI's own embedded Zod schemas
   for hook stdin — the definitions Claude Code validates against before
   invoking a hook command. This is the protocol, not documentation of it.
2. **The usage shape**, read from local session transcripts: 4,999 `usage`
   objects across 40 transcript files.

No transcript content, prompt text, path, or token measurement from those
captures is reproduced here or in any fixture. What is recorded below is field
*names*, field *locations*, aggregate *counts*, and arithmetic *invariants* — the
only things needed to pin a contract, and the only things safe to commit
(`CLAUDE.md`). The fixtures under `fixtures/contracts/claude-code/` reproduce the
confirmed *shape* with invented values, and their provenance sidecars carry
`providerVersionObserved: "2.1.220"`.

Re-verifying is a matter of repeating both observations against a newer release;
neither requires this repository to hold a capture.

## Finding 1: no hook callback carries a token counter

Every hook event in 2.1.220 is a common base object intersected with per-event
fields. The base is:

```text
session_id, transcript_path, cwd, prompt_id?, permission_mode?, agent_id?,
agent_type?, effort?: { level }
```

The per-event fields relevant to usage and compaction are:

| Event          | Event-specific fields                                                   |
| -------------- | ----------------------------------------------------------------------- |
| `Stop`         | `stop_hook_active`, `last_assistant_message?`, `background_tasks?`       |
| `StopFailure`  | `error`, `error_details?`, `last_assistant_message?`                     |
| `SubagentStop` | `stop_hook_active`, `agent_id`, `agent_transcript_path`, `agent_type`, `last_assistant_message?` |
| `PreCompact`   | `trigger` (`manual` \| `auto`), `custom_instructions` (nullable)          |
| `PostCompact`  | `trigger` (`manual` \| `auto`), `compact_summary`                         |

**No hook event in the protocol carries a `usage` object or any token counter.**
Not `Stop`, not `SubagentStop`, not `PostCompact`. This is why
`src/providers/claude/schema.ts` accepts `usage` as *optional* and why
`capabilities.ts` frames cached-input support as "the payload shape is accepted
when a wrapping harness attaches it": a bare Claude Code installation reports no
tokens to a hook at all, and the adapter must not read `transcript_path` to find
them (`AGENT.md`).

## Finding 2: usage lives at `message.usage`, and its input buckets are disjoint

Every `usage` object observed sits at `message.usage` on an assistant transcript
record — 4,999 of 4,999. There is no other location, and no top-level token
counter anywhere on the record. Observed key set:

```text
input_tokens, output_tokens, cache_read_input_tokens,
cache_creation_input_tokens, cache_creation { ephemeral_5m_input_tokens,
ephemeral_1h_input_tokens }, server_tool_use { web_search_requests,
web_fetch_requests }, service_tier, inference_geo, speed, iterations[]
```

`input_tokens` is the **fresh** portion of the prompt only. Cache reads and cache
writes are separate, additive buckets, which the captures show directly rather
than by assertion: across 4,999 objects `input_tokens` never left the range
1..5,656 while `cache_read_input_tokens` reached 713,543 and
`cache_creation_input_tokens` reached 607,589. In 4,988 of 4,999,
`cache_read_input_tokens >= input_tokens`. An `input_tokens` that included cache
reads could not stay in the low thousands across a 700k-token prompt.

This is exactly the fold `normalizeClaudeUsage` performs, and it is what keeps
the canonical buckets **non-overlapping by construction**:

```text
canonical inputTokens = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
canonical uncachedInputTokens (derived) = input_tokens
cacheCreationAccounting = included-in-input
```

Because each canonical subset is one of the addends of the total, no subset can
exceed its total and no bucket is counted twice — the invariant holds
structurally, not by a range check that a provider change could invalidate.

## Finding 3: `cache_creation` sub-buckets are a TTL split, never an addition

`cache_creation.ephemeral_5m_input_tokens + cache_creation.ephemeral_1h_input_tokens`
equalled `cache_creation_input_tokens` in **4,999 of 4,999** objects — no
exceptions.

So the sub-object is a breakdown of the same tokens by cache TTL, not extra
tokens. The adapter therefore:

- derives `cache_creation_input_tokens` from the sub-buckets when only they are
  present, and
- **verifies** the sum when both are present, warning on a mismatch and keeping
  the explicit counter.

It never adds them. Adding a breakdown to its own total is the archetypal
double-count, and it would double the cache-write cost of every cached turn.

## Finding 4: `iterations[]` is a breakdown too

`usage.iterations[]` carries per-iteration `input_tokens`, `output_tokens`,
`cache_read_input_tokens`, `cache_creation_input_tokens`, `cache_creation`, and
`type` (always `"message"` in the captures). Length was 1 in all 4,983 objects
carrying it, and the per-iteration figures summed to the outer counters exactly
for all four fields, in every object.

`iterations[]` is therefore the same tokens, itemized. The adapter audits the sum
and warns on a mismatch, and never adds it to the outer counters.

## Finding 5: reasoning tokens and a provider total do not exist

Across 4,999 real `usage` objects:

- **0** carry any key matching `/reasoning/` or `/thinking_token/`.
- **0** carry any key matching `/total_token/`.

Anthropic's usage shape has no separate reasoning bucket — thinking tokens are
billed inside `output_tokens`, and nothing distinguishes them — and no grand
total for a canonical total to agree or disagree with.

These are the two counters `ADAPTER-NOTE-001` was open about. They are now
**explicit capability exclusions**, confirmed against real captures rather than
assumed:

| Capability                | Value   | Why                                                        |
| ------------------------- | ------- | ---------------------------------------------------------- |
| `reportsReasoningOutput`  | `false` | No such counter exists in the provider's usage shape.      |
| `reportsProviderTotal`    | `false` | No provider total exists, so `providerTotalAgreement` stays `unreported`. |
| `reportsCachedInput`      | `true`  | `usage.cache_read_input_tokens`, when a harness attaches usage. |
| `reportsCacheCreation`    | `true`  | `usage.cache_creation_input_tokens`, ditto.                |
| `cacheCreationAccounting` | `included-in-input` | The fold above.                                  |

A declared exclusion is not the same as a zero, which is the entire reason
capabilities are declared: a consumer can tell "this provider does not report
reasoning tokens" from "this turn spent none".

### A foreign counter is reported, not absorbed

If a wrapping harness attaches `usage.total_tokens` or
`usage.reasoning_output_tokens` anyway, the adapter does **not** read it, and
says so in a parse warning naming the excluded field. Absorbing it would make the
declared capabilities lie: `providerTotalAgreement` would start reporting
`agrees`/`disagrees` for a provider that reports no total, and a consumer
distinguishing "unreported" from "zero" would be reading a value the provider
never produced.

## Finding 6: neither compaction callback reports context size

`PreCompact` carries `trigger` and `custom_instructions`. `PostCompact` carries
`trigger` and `compact_summary`. **Neither carries a token count** — no
`context_tokens_before`, no `context_tokens_after`, no
`estimated_tokens_removed`, no dropped-message count.

This settles `ADAPTER-NOTE-002` in a way the note did not anticipate. The note
described plumbing a `contextTokensBefore` seen at `PreCompact` through injected
state so it could reach `compaction.performed` at `PostCompact`. There is
nothing to plumb: the provider never states the figure at either edge, so the
state bridge would carry a value only a non-Claude-Code harness could have
supplied, at the cost of cross-invocation machinery on the compaction path.

`contextTokensBefore` is therefore an **explicit capability exclusion** for
`claude-code`, asserted in `tests/providers/claude/compaction.test.ts` and
`tests/parity/claude-code.parity.test.ts`:

- The schema still accepts `context_tokens_before` / `context_tokens_after` /
  `dropped_message_count` when a harness attaches them to `PostCompact`, where
  they reach `compaction.performed` in one callback and need no state at all.
- A `context_tokens_before` attached to `PreCompact` is declined *explicitly*:
  `PreCompact` reports why it was ignored, naming the figure, instead of dropping
  it silently.

Retiring the exclusion needs two things, in this order: a Claude Code release
that reports context size on a compaction callback, and — only if it reports the
before-figure on `PreCompact` alone — an integration-layer state bridge keyed by
session. That bridge belongs to the integration layer, not here: ADR 0006 forbids
adapters holding cross-invocation state, and adding a channel for it to
`ProviderParseResult` would change a shared public contract that this provider
does not own.

`compact_summary` is deliberately **not** read. It is a model-generated summary
of the conversation — content, in the sense `docs/state-retention.md` uses the
word — and compaction telemetry needs its size and trigger, not its text.

## Finding 7: `stop_hook_active` is what makes a repeated `Stop` safe to dedupe

`Stop` and `SubagentStop` both carry a required `stop_hook_active` boolean. It is
`false` on the once-per-prompt stop and `true` on a stop that fired because a
hook continued the turn.

That distinction is what a delivery identity for `Stop` was missing.
`prompt_id` alone cannot separate a redelivery from a genuine second stop, so
`Stop` was previously never deduplicated — and `Stop` is a usage-bearing
callback, so a redelivered one double-counted a turn's tokens. Keyed on
`prompt_id` **and gated on `stop_hook_active === false`**, the once-per-prompt
stop is deduplicated while every continuation stop stays unidentifiable and is
still exported.

The gate is deliberately one-sided. Two continuation stops both report
`stop_hook_active: true`, so claiming an identity for them would suppress a real
second firing and lose its tokens — a certain loss to avoid a possible
double-count. Under-reporting an identity costs deduplication; over-reporting one
costs telemetry (`src/providers/adapter.ts`).

The same reasoning fixes a latent inversion on `SubagentStop`, which was keyed on
`agent_id` alone: a hook-continued subagent stop repeats `agent_id` and would
have been suppressed as a redelivery. It now declines an identity when
`stop_hook_active` is `true`.
