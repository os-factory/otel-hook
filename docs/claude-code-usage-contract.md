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
them (`AGENTS.md`, ADR 0003). The hook runtime may, when the host turns on
`providers.claudeCode.readTranscriptUsage`, and a wrapping harness may, with the
bounded helpers described in finding 8.

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

## Finding 8: the model is on `SessionStart` and in the transcript, never on `Stop`

The hook side is finding 1's (2.1.220 schemas); the transcript side was
re-checked against **Claude Code 2.1.332** for issue #64, the same way: record
and field names only, nothing copied.

- `SessionStart` carries `model`. No other hook callback in finding 1's list
  names one, `Stop` and `StopFailure` included.
- Every top-level assistant transcript record carries `message.model` next to
  `message.usage`. It follows `/model`, so it is the only exact per-turn source.
- Assistant records that Claude Code makes up itself (an API error notice, an
  interrupted turn) carry the model `<synthetic>` and zeroed usage. Subagent
  records carry `isSidechain: true`.
- `message.usage` now also has `output_tokens_details { thinking_tokens }`. It is
  not read: it is a breakdown of `output_tokens`, and `reportsReasoningOutput`
  stays `false` until a decision is made to model it.

- One request is written as one record per content block, each repeating its
  `message.id` and its usage so far; the last record of an id holds the final
  counts.

So the model and usage reach a generation span in up to three ways, and none of
them makes the adapter read a file:

1. **Session model, always on.** The core remembers the last model a session
   reported (`session.start`, or a top-level `generation.*` with a known model)
   under `model:<sessionId>` in the state store, and hands it to the adapter as
   `ProviderParseInput.sessionModel` (ADR 0006: the adapter keeps no state of its
   own). `Stop` / `StopFailure` use it for both `gen_ai.request.model` and
   `gen_ai.response.model`, and the span is named `generation <model>`. `unknown`
   remains only when nothing in the session ever named a model, or when the host
   runs with a store that does not survive between hook processes.
2. **Turn totals, read by otel-hook (opt-in setting).** With
   `providers.claudeCode.readTranscriptUsage` on (`--claude-transcript-usage`,
   `OTEL_HOOK_CLAUDE_TRANSCRIPT_USAGE=1`, or the config file), the hook runtime
   runs `createClaudeTranscriptUsageEnricher` before the adapter parses. It keeps
   a byte cursor per session in the state store (`cursor:claude-transcript-usage:<sessionId>`,
   holding the offset and a digest of the path, never the path):
   - `SessionStart` records where the transcript ends (0 if it does not exist
     yet), unless a cursor for the same transcript already exists, so a
     compaction restart does not skip the turn it interrupted;
   - `Stop` / `StopFailure` read from the cursor to the end (at most 8 MiB,
     within 500 ms), sum every main-thread request (deduplicated by
     `message.id`, last record wins; sidechain and `<synthetic>` records
     skipped), attach the turn's model and usage with `usage_partial: false`,
     and move the cursor to the end of the last complete line;
   - with no cursor for this transcript, a range over the cap, or a transcript
     that shrank, it falls back to the last request in the bounded tail,
     attaches it with `usage_partial: true`, and moves the cursor to the end;
   - a timeout or an unreadable file attaches nothing and keeps the cursor, so
     the next turn's range includes the tokens: late, never twice;
   - a payload that already carries `usage` is left alone, and the cursor moves
     past it;
   - `SubagentStop` does the same over the subagent's own transcript
     (`agent_transcript_path`), with one cursor per subagent
     (`cursor:claude-transcript-usage:<sessionId>:agent-<digest of agent_id>`).
     It sums that agent's sidechain records (a record naming another `agentId`
     is skipped). A subagent with no cursor yet is read from the start of its
     file, which holds that subagent alone, so its first stop is exact too
     (issue #68).
   The generation span carries `otelhook.usage.partial` (`false` for a turn
   total, `true` for the fallback).
3. **Harness-attached (library helper).** A wrapper can instead attach
   `{ model, usage }` itself with `attachClaudeTranscriptTurn(payload)`. It
   reads the last 1 MiB of the one `transcript_path` the payload names, within
   250 ms, and attaches the last request only, with `usage_partial: true`.

All readers open only a regular `.jsonl` file at an absolute path, never list a
directory, never throw, and let nothing but model ids and counters out of the
record.

### The one sanctioned exception to "no transcript reads in the hook"

ADR 0003 gives adapters no filesystem handle, and this document has always said
the adapter must not read `transcript_path`. That still holds: the adapter only
maps fields that are already on the payload. Option 2 is the single place where
otel-hook reads a file a hook payload names, inside the hook process, and it is
off by default. It is allowed because there is no other source for Claude Code
tokens, and because it is bounded (one named file, a byte cap, a time budget,
fail-open), host-configured rather than provider-chosen, and visible in
configuration. Any further transcript read needs the same justification and its
own setting.

Why turn totals and not the last request: in agentic use most turns contain
several model requests (one per tool round trip), so the last request alone
reports only a small share of the turn's billed input and output tokens. A cursor gives
the exact turn without a bounded tail ever having to find where the turn began.
Subagent requests are not in the turn's sum: Claude Code writes them to the
subagent's own transcript, and the parent's transcript marks any it holds
`isSidechain`. They are counted once, at `SubagentStop`, on a generation inside
the subagent: `generation.start` / `generation.end` with `subagentId` set (exported
as `otelhook.subagent.id`), the subagent's own model, and the summed usage. The
`subagent.end` event carries no usage, so nothing restates it, and a subagent's
model never becomes the session's model. The generation id is
`(session_id, agent_id)` for the once-per-run stop, which delivery deduplicates on,
and adds the sequence for a hook-continued stop, whose cursor counts only the
requests written since the previous one. Usage a wrapper attaches to
`SubagentStop` is reported the same way.

Without the setting a subagent exports no generation at all, as before. A
subagent whose cursor was lost (an expired store) and that a hook then continues
is read from the start of its file again, so that one stop can recount its earlier
requests; a fresh subagent cannot hit this.

The synthetic tail in `fixtures/contracts/claude-code/transcript-tail-turn.json`
pins this shape, and `subagent-transcript-turn.json` pins a subagent's own file. `tests/providers/claude/transcript.test.ts` covers the helper and
the session model, `tests/providers/claude/transcript-usage-enricher.test.ts`
the cursor and the setting, and `tests/e2e-proof/proof-run.test.ts` shows that
`check-evidence.mjs` `token-usage` passes for Claude Code both ways.
