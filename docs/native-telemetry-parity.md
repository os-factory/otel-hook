# Native telemetry parity

Can otel-hook's hook-based telemetry replace each provider's built-in
OpenTelemetry exporter? Issue #55 asks this. This document gives the answer as
it stands today, and the results feed the provider capability matrix in #18.

| | |
| --- | --- |
| Date | 2026-11-24 |
| otel-hook | 0.6.0 (`package.json`) |
| Claude Code | native side from the monitoring docs; latest release on npm that day was **2.1.331**. The hook side was confirmed against **2.1.220** ([usage contract](claude-code-usage-contract.md)). |
| Codex CLI | native side from the config docs plus `codex-rs/otel` source; latest GitHub release that day was **0.172.0**. The hook side was observed on **0.163.0**. |
| Gemini CLI | native side from `docs/cli/telemetry.md` on `main`; latest on npm that day was **0.71.1** |
| Cursor | native export is a server-side Enterprise feature (instrumentation scope `cursor.telemetry` 0.1.0). The hook side was captured on IDE 3.12.17 and CLI 2026.07.17. |
| Antigravity | no native exporter is documented |

None of the provider documentation pages say which agent version they
describe. The versions above are the latest releases on the day the docs were
read.

## Evidence level: nothing here is confirmed by a capture yet

Every cell in the tables below comes from **reading**: the provider's public
documentation for the native side, and this repository's code for the otel-hook
side. No session has yet been captured with both exporters on. The tables use
these tags:

- **docs**: native behaviour, read from the official documentation cited for
  that provider.
- **src**: native field names read from the provider's own open-source code
  (Codex only), because its docs name few attributes.
- **code**: otel-hook behaviour, read from the files cited.
- **capture**: confirmed by a real dual-exporter capture. **No cell has this
  tag yet.**

To upgrade a cell, see [Confirming a cell](#confirming-a-cell).

## Status vocabulary

| Status | Meaning |
| --- | --- |
| covered | otel-hook reports the same fact at the same granularity |
| partial | otel-hook reports it, with a stated difference |
| derivable | otel-hook does not report it today, but a hook payload holds enough to derive it |
| impossible | no hook this provider fires carries it |
| not native | the native exporter does not report it either, so there is nothing to replace (otel-hook may still add it) |
| unverified | the docs or the code are not enough to decide |

These statuses also appear, in short form, as `documented` in
[`scripts/parity/native-parity-categories.json`](../scripts/parity/native-parity-categories.json).
The parity script prints them next to what a capture shows, so keep the two in
step.

## Where otel-hook's side comes from

otel-hook uses one vocabulary for every provider:

- **Spans:** `session`, `prompt`, `generation <model>`, `tool <name>`,
  `subagent`, `compaction`, `error`
  ([`src/telemetry/semconv.ts`](../src/telemetry/semconv.ts)).
- **Logs** (only with `--logs`): `otelhook.<canonical event type>`
  ([`src/telemetry/log-records.ts`](../src/telemetry/log-records.ts),
  [canonical log mapping](canonical-log-mapping.md)).
- **Token counts:** `gen_ai.usage.{input_tokens, output_tokens,
  cache_read.input_tokens, cache_creation.input_tokens,
  reasoning.output_tokens}`, labelled with `otelhook.usage.temporality`
  ([usage semantics](usage-semantics.md)).

Facts that hold for every provider:

- **No cost.** The canonical model has `cost` on `session.end` and
  `generation.end`, but neither mapping exports it.
- **No metrics.** otel-hook emits traces and logs only. A count such as "tool
  calls" is the number of spans or records.
- **Durations come from span timing.** A tool span starts at the `tool.start`
  edge and ends at the `tool.end` edge, using the provider's own timestamp
  where it sends one and the hook's clock otherwise. A provider-reported
  `duration_ms` is parsed into `durationMillis` but is not exported.
- **No API-request level.** Hooks fire per turn or per tool call, so per-request
  latency, HTTP status, and retries are out of reach. The exception is Gemini
  CLI, whose `BeforeModel`/`AfterModel` hooks wrap each model call.

## Claude Code

Native sources: <https://code.claude.com/docs/en/monitoring-usage> (docs).

Native exporter facts:

- Enabled with `CLAUDE_CODE_ENABLE_TELEMETRY=1`.
- Emits metrics (meter `com.anthropic.claude_code`) and events (logs).
- Spans exist as a beta, behind `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`.
- Endpoints can be set per signal, but there is one endpoint per signal (#54).

otel-hook sources:

- [`src/providers/claude/events.ts`](../src/providers/claude/events.ts)
- [`src/providers/claude/capabilities.ts`](../src/providers/claude/capabilities.ts)
- [usage contract](claude-code-usage-contract.md)

| Item | Native | otel-hook | Status |
| --- | --- | --- | --- |
| Tokens: input / output / cache read / cache write | `claude_code.token.usage{type=input\|output\|cacheRead\|cacheCreation}`; per request on `claude_code.api_request` (`input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`) (docs) | No hook carries a token counter, and the adapter may not read `transcript_path` (code; hook schema confirmed on 2.1.220). A wrapping harness can attach the last assistant message's `message.usage` to `Stop` with the shipped `attachClaudeTranscriptTurn` helper; the generation span then carries all four `gen_ai.usage.*` buckets for that request (code; issue #64) | **partial**: harness-attached, last request of the turn only |
| Reported cost | `claude_code.cost.usage` (USD); `cost_usd` on `api_request` (docs) | Not exported (code) | **impossible**: no tokens either |
| Model | `model` on token and cost metrics and on `api_request` (docs) | Taken from `SessionStart.model` and remembered for the session in the state store, so every generation span carries it as `gen_ai.request.model` / `gen_ai.response.model` and is named `generation <model>`. A model a harness attaches to `Stop` (the transcript's `message.model`, which follows `/model`) becomes that turn's response model and the session's model from then on. `unknown` only when nothing in the session named a model (code; issue #64). | **covered** with a durable state store; per-turn exactness needs the harness |
| API request count and latency | One `api_request` event per request, with `duration_ms`; beta span `claude_code.llm_request` (docs) | Nothing at request level (code) | **impossible** |
| Errors | `api_error` (`error`, `status_code`, `attempt`), `internal_error` (docs) | `StopFailure` → generation `outcome` plus `otelhook.generation.stop_reason`; `PostToolUseFailure` → tool span with error status (code) | **partial**: no HTTP status, no API errors that `StopFailure` does not see |
| Retries | `attempt` on `api_error`; `api_retries_exhausted` (docs) | none (code) | **impossible** |
| Tool calls | `tool_result` (`tool_name`, `tool_use_id`); beta span `claude_code.tool` (docs) | `tool <name>` span plus `tool.start`/`tool.end` records (code) | **covered** |
| Tool decision | `tool_decision` (`decision`, `source`); `claude_code.code_edit_tool.decision` (docs) | `PermissionRequest` is ignored, and `otelhook.tool.permission_decision` is never set for Claude (code) | **derivable**: a `PermissionRequest` with no later `PostToolUse` means the call was denied or aborted. The decision *source* (config, hook, user) is impossible. |
| Tool duration | `duration_ms` on `tool_result` (execution only) (docs) | Span from `PreToolUse` to `PostToolUse`, by the hook's clock, so it includes time waiting for permission (code) | **partial** |
| Tool result | `success`, `error_type`, result size (docs) | `otelhook.outcome` ok or error; size only as content `byte_length` on logs (code) | **covered** |
| Prompts | `user_prompt` (`prompt_length`; text opt-in with `OTEL_LOG_USER_PROMPTS`) (docs) | `prompt` span plus `prompt.submitted` record with length and salted hash; text needs two opt-ins (code) | **covered** |
| Turns | beta `claude_code.interaction` span; `assistant_response` (docs) | One `generation` span per `Stop`/`StopFailure`, with the session's model, and tokens when a harness attaches them (code) | **partial** |
| Compaction | `compaction` (`trigger`, `success`, `duration_ms`, `pre_tokens`, `post_tokens`) (docs) | `PostCompact` → `compaction` span with `otelhook.compaction.trigger`; no token figures (code; finding 6 of the usage contract) | **partial** |
| Session start | `claude_code.session.count{start_type}` (docs) | `session.start` record. The `session` span is exported only when `SessionEnd` arrives. (code) | **covered** |
| Session end | Not documented (docs) | `SessionEnd` → `session` span with `otelhook.outcome` (code) | **not native**: otel-hook adds it |
| Lines of code changed | `claude_code.lines_of_code.count{type=added\|removed}` (docs) | none (code) | **derivable** from `Edit`/`Write`/`MultiEdit` tool input on `PostToolUse` |
| Commits and PRs | `claude_code.commit.count`, `claude_code.pull_request.count` (docs) | none (code) | **derivable**, by heuristic, from a successful `Bash` call running `git commit` or `gh pr create` |
| Active time | `claude_code.active_time.total{type=user\|cli}` (docs) | none (code) | **derivable** for CLI time (prompt-to-`Stop` intervals). User time is impossible. |
| Subagents | `subagent_completed` (`agent_type`, `total_tokens`, `total_tool_uses`, `duration_ms`) (docs) | `SubagentStart`/`SubagentStop` → `subagent` span plus `otelhook.subagent.id` on child events (code) | **partial**: no tokens or tool counts |
| **Personal data** | `user.email` and `organization.id` whenever available, with no opt-out; `user.account_uuid`/`user.account_id` on by default (`OTEL_METRICS_INCLUDE_ACCOUNT_UUID` turns them off); `user.id` (anonymous, always); `terminal.type`; `host.name` with `OTEL_RESOURCE_INCLUDE_HOST` (docs) | None of these. Session ids are the provider's own; workspace and repository ids are salted handles, never paths; content is off by default (code). See [Personal data](#personal-data-on-the-otel-hook-side). | otel-hook carries **less** |

**Recommendation: not yet.** "otel-hook only" for Claude Code loses every
token, cost, API-request, error-detail, retry, lines-of-code, commit/PR and
active-time signal. These are the signals a cost or usage dashboard is built
on. Claude Code's hooks do not carry them, and three of them cannot be
recovered from hooks at all. A launcher can choose "otel-hook only" when it
needs only activity telemetry (sessions, prompts, tools, subagents) and wants
email and account ids kept off the wire. Otherwise, keep the native exporter
and remove `user.email`, `user.account_uuid` and `organization.id` in a
collector.

## Codex CLI

Native sources:

- <https://learn.chatgpt.com/docs/config-file/config-advanced> (docs; `developers.openai.com/codex/config-advanced` redirects here)
- <https://learn.chatgpt.com/docs/config-file/config-reference> (docs)
- `codex-rs/otel` in <https://github.com/openai/codex> (src; for exact event and attribute names)

Native exporter facts:

- Configured in `[otel]` in `config.toml`: `exporter` for logs,
  `trace_exporter`, and `metrics_exporter`. Each accepts `otlp-http` or
  `otlp-grpc`, and each has its own endpoint.
- Metrics default to Statsig unless set.

otel-hook sources:

- [`src/providers/codex/adapter.ts`](../src/providers/codex/adapter.ts)
- [`src/providers/codex/usage.ts`](../src/providers/codex/usage.ts)
- [usage semantics](usage-semantics.md#usage-keys-per-provider)

| Item | Native | otel-hook | Status |
| --- | --- | --- | --- |
| Tokens: input / output / cache read | `codex.sse_event` on `response.completed`: `input_token_count`, `output_token_count`, `cached_token_count`, `reasoning_token_count`; `codex.turn.token_usage` metric (src, docs) | `Stop.usage` → `gen_ai.usage.*` on the generation span. The value is the **session-wide cumulative** total, labelled `cumulative`, with per-turn deltas derived (code) | **partial**: per turn rather than per response, and a running total rather than a delta |
| Tokens: cache write | `cache_write_token_count` (src) | Codex hook usage has no such counter (`reportsCacheCreation: false`) (code) | **impossible** |
| Reported cost | `codex.turn_cost` (`usage.estimated_usd`), `codex.turn.cost_microusd` (src; not in the docs) | none (code) | **derivable**: the native value is an estimate too |
| Model | `model` on every event (src) | `SessionStart.model` and `Stop.model` → `gen_ai.*.model`, vendor `openai` (code) | **covered** |
| API request count and latency | `codex.api_request` event and metric with `duration_ms` (docs, src) | none (code) | **impossible** |
| Errors | `error.message`, `http.response.status_code` on `codex.api_request` (src) | Tool errors; `Stop.stop_reason` → generation outcome (code) | **partial** |
| Retries | `attempt` on `codex.api_request` (src) | none (code) | **impossible** |
| Tool calls | `codex.tool_result`; `codex.tool.call` metric (docs, src) | `tool <name>` span (code) | **covered** |
| Tool decision | `codex.tool_decision` (`decision`, `source`) (src) | `permission_decision` → `otelhook.tool.permission_decision` on the `tool.end` record (code) | **partial**: no decision source |
| Tool duration | `duration_ms` on `codex.tool_result`; `codex.tool.call.duration_ms` (src, docs) | The payload's `duration_ms` is parsed but not exported; the span uses hook timestamps (code) | **partial**, and closing it is a small, derivable fix |
| Tool result | `success`, `output_length` (src) | `otelhook.outcome` (code) | **covered** |
| Prompts | `codex.user_prompt` (text opt-in with `log_user_prompt`) (src, docs) | `prompt` span plus record (code) | **covered** |
| Turns | `codex.agent_response`, `codex.turn_ttft`, turn metrics (src, docs) | One generation per `turn_id` (code) | **covered** |
| Compaction | Not documented | `PreCompact`/`PostCompact` → `compaction` (code) | **not native**: otel-hook adds it |
| Session start | `codex.conversation_starts`; `codex.thread.started` (src) | `session.start` record only. With no session end, no `session` span is ever exported (code). | **covered** |
| Session end | Not documented | Codex has no `SessionEnd` hook (code) | **not native**, and impossible from hooks |
| Lines of code, commits and PRs, active time | Not documented | none (code) | **not native**. Lines of code could be derived from `apply_patch` input. |
| Subagents | `codex.multi_agent.spawned`; `agent.type` on `codex.agent_response` (src) | `SubagentStart`/`SubagentStop` → `subagent` span (code) | **covered** |
| **Personal data** | `user.email`, `user.account_id`, `auth_mode`, `conversation.id`, `terminal.type` on every event, with no documented opt-out (src) | None of these (code) | otel-hook carries **less** |

**Recommendation: conditional.** Turns, tools, prompts, subagents, model and
token totals are covered. A launcher that needs per-request latency, retries,
API error detail or cache-write tokens must keep native logs. Because native
events carry `user.email` and `user.account_id` with no opt-out, otel-hook only
is the privacy-safer default *if* those are not needed. Do not make it the
default until a capture confirms that the cumulative token totals reconcile
with `codex.sse_event`.

## Gemini CLI

Native sources:
<https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/telemetry.md>
(docs; read as a fetched summary, not verbatim. Re-read it before confirming
any cell.)

Native exporter facts:

- Turned on with `telemetry.enabled` in `settings.json`, or with
  `GEMINI_TELEMETRY_ENABLED`.
- **One** `otlpEndpoint` for every signal, using `grpc` or `http`.
- `logPrompts` is **on by default**.

otel-hook sources:

- [`src/providers/gemini/adapter.ts`](../src/providers/gemini/adapter.ts)
- [`src/providers/gemini/usage.ts`](../src/providers/gemini/usage.ts)

| Item | Native | otel-hook | Status |
| --- | --- | --- | --- |
| Tokens: input / output | `gemini_cli.token.usage{type=input\|output\|thought\|cache\|tool}`; `gen_ai.client.token.usage` (docs) | `AfterModel.usageMetadata` → `gen_ai.usage.*` per model call (code) | **covered** |
| Tokens: cache read | `type=cache` (docs) | The CLI's hook translator strips `cachedContentTokenCount`; the adapter maps it when present (code) | **impossible** today |
| Tokens: cache write | Not documented | none | **not native** |
| Reported cost | Not documented | none | **not native** |
| Model | `model` on `api_response` and request metrics (docs) | `llm_request.model` on the generation span (code) | **covered** |
| API request count and latency | `gemini_cli.api.request.count`, `gemini_cli.api.request.latency` (docs) | One `generation` span per `BeforeModel`/`AfterModel` pair, timed by the hooks (code) | **partial**: no status code; hook-measured latency |
| Errors | `gemini_cli.api_error` (docs) | Tool errors; `finishReason` → outcome (code) | **partial** |
| Retries | `gemini_cli.chat.content_retry`, `content_retry_failure`; retry count metric (docs) | none (code) | **impossible** |
| Tool calls | `gemini_cli.tool_call`; `gemini_cli.tool.call.count` (docs) | `tool <name>` span (code) | **covered** |
| Tool decision | `decision` (accept, reject, auto_accept, modify) on `tool_call` (docs) | No decision field is known on `BeforeTool`/`AfterTool` (code) | **unverified** |
| Tool duration | `duration_ms`; `gemini_cli.tool.call.latency` (docs) | Span from `BeforeTool` to `AfterTool` (code) | **partial** |
| Tool result | `success`, `error_type` (docs) | Whether `tool_response.error` is present → outcome (code) | **covered** |
| Prompts | `gemini_cli.user_prompt` (text **on by default**) (docs) | `BeforeAgent` → prompt (text off by default) (code) | **covered** |
| Turns | `gemini_cli.agent.turns`; `turnCount` on `conversation_finished` (docs) | `AfterAgent` is ignored (code) | **derivable** |
| Compaction | `gemini_cli.chat_compression` (`tokens_before`, `tokens_after`) (docs) | `PreCompress` → `compaction` with trigger, no tokens (code) | **partial** |
| Session start and end | `gemini_cli.config`, `gemini_cli.session.count`; `conversation_finished` (docs) | `SessionStart`/`SessionEnd` (code) | **covered** |
| Lines of code changed | `gemini_cli.lines.changed`; line counts on `tool_call` (docs) | none (code) | **derivable** from file-writing tool input |
| Commits and PRs, active time | Not documented | none | **not native** |
| Subagents | `gemini_cli.agent.start`/`finish`, `gemini_cli.agent.run.count` (docs) | Invoking an agent appears as a tool call of kind `delegate`; there is no subagent lifecycle (code) | **partial** |
| **Personal data** | `user.email` when authenticated, with no documented opt-out; `installation.id`; prompt **text by default** (docs) | None of these; prompt text is off by default (code) | otel-hook carries **less** |

**Recommendation: conditional yes, pending a capture.** Of the three
providers with a native exporter, Gemini CLI is the closest to parity: model
calls are visible to hooks, so tokens, model and request counts are covered.
The gaps are retries, tool decisions, lines changed and cache-read tokens. The
native exporter sends prompt text and email by default to a single endpoint.
That makes "otel-hook only" the better privacy default for a launcher that
does not need those gaps closed. Confirm with a capture before shipping it as
the default.

## Cursor

Native sources:

- <https://cursor.com/docs/enterprise/opentelemetry-export> (docs)
- <https://cursor.com/docs/enterprise/opentelemetry-export/wire> (docs; read
  to roughly 100k of its 129k characters)

Native exporter facts:

- **Enterprise only and server-side.** A team admin configures one destination.
- OTLP/HTTP protobuf, to `/v1/metrics` and `/v1/logs` only. No traces.
- Nothing runs on the developer's machine, so a launcher cannot switch it on or
  off.

otel-hook sources:

- [`src/providers/cursor/adapter.ts`](../src/providers/cursor/adapter.ts)
- [`src/providers/cursor/payload.ts`](../src/providers/cursor/payload.ts)

| Item | Native | otel-hook | Status |
| --- | --- | --- | --- |
| Tokens: input / output / cache read | `cursor.token.usage{cursor.token.type=input\|output\|cache_read}` (docs) | `stop` usage per generation, as a delta (code) | **covered** |
| Tokens: cache write | `cursor.token.type=cache_creation` (docs) | The hook reports `cache_write_tokens`, but the adapter drops it until its accounting is confirmed (code) | **derivable** |
| Reported cost | `cursor.cost.usage`, a best-effort estimate (docs) | none (code) | **derivable** |
| Model | `cursor.model.name` (docs) | `model` → `gen_ai.*.model` (code) | **covered** |
| API request count | `cursor.api.request` events (docs) | Per generation, not per request (code) | **impossible** |
| API latency, retries | Not documented | none | **not native** |
| Errors | `cursor.api.error` (docs) | Tool failures; `stop` status (code) | **partial** |
| Tool calls and result | `cursor.tool.calls{cursor.tool.status}` (docs) | `tool <name>` spans, shell and MCP included (code) | **covered** |
| Tool decision and duration | Not documented, except for Grok Bot (docs) | `permission_denied` → `permission_decision`; span duration (code) | **not native**: otel-hook adds them |
| Prompts and turns | `conversation.user_message` / `assistant_message`, only with team content opt-in (docs) | `beforeSubmitPrompt`; one generation per `generation_id` (code) | **covered** |
| Compaction, session start and end | Not documented | `preCompact`, `sessionStart`, `sessionEnd` (code) | **not native**: otel-hook adds them |
| Active time | Not documented | none (code) | **not native** |
| Lines of code, commits and PRs | `cursor.cloud_agent.commit` (with line counts) and `cursor.cloud_agent.pull_request`, **cloud agents only** (docs) | none (code) | **derivable** for local sessions, from `afterFileEdit` and shell commands |
| Subagents | Task-tool subagents are excluded (docs) | `subagentStart`/`subagentStop` are ignored, because the stop event carries no id to pair on (code) | **not native** |
| **Personal data** | `cursor.team.id` always; `cursor.user.id`, `cursor.user.account_id` and `cursor.user.email` optionally. Email is not sent for Privacy Mode (Legacy) teams. (docs) | The hook payload's `user_email` is parsed and never propagated; tests assert it does not reach a sink (code) | otel-hook carries **less** |

**Recommendation: yes for the local pipeline. Native is not a launcher
setting.** Cursor's exporter is a team-level, server-side Enterprise feature,
so "turn native off" is not a choice a launcher makes, and the two do not
compete for one endpoint. otel-hook is the only per-machine source, and it
already covers more local-session signals than the native export. Teams that
want billing-grade token and cost figures should keep the native export
alongside it.

## Antigravity

Native sources:

- <https://docs.cloud.google.com/gemini/enterprise/docs/ai-developer-tools-metrics>
  (docs). This is a Preview console dashboard (active users, daily tokens, API
  calls, tool calls, accepted tool calls) with no export pipeline.
- Feature request <https://github.com/google-antigravity/antigravity-cli/issues/366>
  for OTLP export. It was open on 2026-11-24.
- The `antigravity.google/docs` pages did not yield a telemetry page.

otel-hook sources:

- [`src/providers/antigravity/adapter.ts`](../src/providers/antigravity/adapter.ts)
- [`src/providers/antigravity/maturity.ts`](../src/providers/antigravity/maturity.ts)

| Item | Native | otel-hook | Status |
| --- | --- | --- | --- |
| Tool calls and result | No exporter | `PreToolUse`/`PostToolUse` → `tool <name>` spans; `invoke_subagent` becomes a `delegate` tool call (code; experimental) | **not native**: otel-hook is the only source |
| Every other item | No exporter | none: `PreInvocation`, `PostInvocation` and `Stop` are ignored until the promotion gates are cleared (code) | **not native** |
| **Personal data** | No exporter | None; `workspacePaths` are not exported (code) | n/a |

**Recommendation: otel-hook is the only option, and it is experimental.**
There is no native exporter to turn off. The adapter is gated as
`experimental` (see `otel-hook providers --json`, `promotionGates`).

## Personal data on the otel-hook side

What otel-hook sends that could identify a person or a place, by default:

- `session.id` and `gen_ai.conversation.id`: the provider's own session id.
- `otelhook.workspace.id`, `otelhook.target.workspace.id`,
  `otelhook.target.repository.id`: salted handles, never paths.
- `vcs.ref.head.name`: the branch name. A branch can carry a person's name,
  such as `jane/fix-login`.
- `service.name` and any resource attributes the operator configures.

It never sends email, account ids, org ids, host name, prompt, response, tool
or error text, unless the operator configures them. Content needs
`privacy.contentMode` and, for logs, `exporter.logs.includeContent`
([content disclosure](canonical-log-mapping.md#content-disclosure)). The
parity script flags personal-data keys on both sides, so a capture can confirm
this.

## Comparing captures

The comparison is scripted so it can be rerun whenever a provider changes:

- [`scripts/parity/capture-receiver.mjs`](../scripts/parity/capture-receiver.mjs):
  a loopback OTLP/HTTP receiver. It appends each request to a JSONL capture
  file and accepts protobuf or JSON, gzip or not. gRPC is not supported.
- [`scripts/parity/native-telemetry-parity.mjs`](../scripts/parity/native-telemetry-parity.mjs):
  decodes two captures and prints, per category, the observed verdict (`both`,
  `gap`, `otel-hook-only`, `neither`) next to the documented status. It also
  lists native names that no category claims, so a new or renamed provider
  signal surfaces, and lists personal-data attribute keys on each side, by key
  and count, never by value.
- [`scripts/parity/native-parity-categories.json`](../scripts/parity/native-parity-categories.json):
  the category-to-evidence mapping. Adding a provider or a renamed native
  metric is a data edit there.

```bash
node scripts/parity/native-telemetry-parity.mjs --provider claude-code \
  --native tests/fixtures/native-parity/claude-code.native.otlp.jsonl \
  --otel-hook tests/fixtures/native-parity/claude-code.otel-hook.otlp.jsonl
# --json for machine-readable output; --fail-on-gap to exit 1 on any native-only category
```

The fixtures in `tests/fixtures/native-parity/` are **synthetic** (see their
`PROVENANCE.md`). They test the script and do not confirm any table cell.
`tests/parity/native-telemetry-parity.test.ts` also runs the built otel-hook
binary and compares its real output, so the otel-hook half of the mapping
cannot drift from what otel-hook actually emits.

### Producing a real capture

1. Start two receivers, one per side:

   ```bash
   node scripts/parity/capture-receiver.mjs --port 4318 --out native.otlp.jsonl \
     --side native --provider claude-code --provider-version <agent version>
   node scripts/parity/capture-receiver.mjs --port 4319 --out otel-hook.otlp.jsonl \
     --side otel-hook --provider claude-code
   ```

2. Point the native exporter at port 4318 over HTTP:

   - **Claude Code:**
     ```bash
     CLAUDE_CODE_ENABLE_TELEMETRY=1
     OTEL_METRICS_EXPORTER=otlp
     OTEL_LOGS_EXPORTER=otlp
     OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
     OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
     OTEL_METRIC_EXPORT_INTERVAL=1000
     ```
     Optionally also set `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1` and
     `OTEL_TRACES_EXPORTER=otlp`.
   - **Codex:** in `config.toml`, set `[otel]` `exporter`, `trace_exporter` and
     `metrics_exporter` to `otlp-http` with `endpoint`s under
     `http://127.0.0.1:4318/v1/...`. Set `protocol` to `binary`.
   - **Gemini CLI:** in `settings.json`, set `telemetry.enabled: true`,
     `otlpEndpoint: "http://127.0.0.1:4318"` and `otlpProtocol: "http"`.
   - **Cursor:** the export is server-side, so a loopback receiver cannot get
     it. Capturing it needs an Enterprise admin destination that can reach the
     receiver, and the two sides must be joined on `cursor.conversation.id`.

3. Register otel-hook with an **explicit** endpoint and logs enabled:
   `otel-hook run --endpoint http://127.0.0.1:4319/v1/traces --logs`.
   Hook subprocesses inherit the agent's environment. Claude Code's
   `OTEL_EXPORTER_OTLP_ENDPOINT` would otherwise send otel-hook's output into
   the native capture.
4. Run one short session that exercises every category: a prompt, an edit, a
   shell command, a denied tool, a commit, a subagent, and `/compact`. Then exit
   the agent and stop both receivers with Ctrl-C.
5. Compare the two files with the script.

The agent lab (`npm run lab:claude`, `npm run lab:codex`) already runs the real
CLIs against local mock model servers. Adding the native-exporter variables to
its driver gives repeatable captures without an account. Such captures carry no
account attributes, so personal-data cells still need one authenticated run.

### Sanitizing before committing

A real capture holds real identifiers and possibly content. Before it goes
under `tests/fixtures/native-parity/`:

- Replace `user.email` (and any email-shaped value) with an address on
  `example.invalid`. Replace account, org and user ids with all-zero
  placeholders. Replace session ids, host names and paths.
- Drop or blank any prompt, response or tool content.
- Re-encode as OTLP/JSON `body` lines, so reviewers can read it.
- Set `"synthetic": false` in the meta line, record the agent and otel-hook
  versions, and note what was redacted. Add a row to the fixture
  `PROVENANCE.md`.
- Run the script. The personal-data section must list only the placeholder
  keys you expect, and `grep` must find no real value.

### Confirming a cell

A cell moves from docs/src/code to **capture** when:

1. a dual capture for that provider exists in the repository, sanitized as
   above;
2. the script's observed verdict for the category agrees with the table: a
   `covered` or `partial` row shows `both`, and an `impossible` or `derivable`
   row shows `gap`;
3. for `partial`, a reviewer has compared the values (for example, token totals
   reconcile) and the stated difference still holds.

Then update the cell's tag and status here, and `documented` in the mapping
file, in the same change, citing the capture file and agent version.

## Candidate follow-up issues ("missing but derivable")

No issues have been opened. These are proposals:

1. **Lines of code changed from edit tool calls.** Claude Code
   `Edit`/`Write`/`MultiEdit`, Gemini file-writing tools and Cursor
   `afterFileEdit` all expose the change. Native Claude Code and Gemini CLI
   report lines changed.
2. **Commits and pull requests from shell tool calls.** A successful
   `git commit` or `gh pr create` in a shell tool call is a heuristic match
   for Claude Code's commit and PR counters. It also fills the gap for Cursor's
   local sessions.
3. **Export provider-reported durations.** `durationMillis` on `tool.end`,
   `generation.end` and `session.end` (Codex and Cursor `duration_ms`) is
   parsed and then dropped. Today tool latency measures hook-to-hook time.
4. **Estimated cost from token usage.** Codex, Cursor and Gemini report tokens,
   and the native cost for Codex and Cursor is itself an estimate. The
   canonical model already has `cost`, but no mapping exports it.
5. **Claude Code tool permission decision.** Use `PermissionRequest` followed
   by a missing `PostToolUse` to mark the call denied or aborted, filling
   `otelhook.tool.permission_decision`.
6. **Cursor cache-write tokens.** Confirm how `cache_write_tokens` is accounted,
   then map it instead of dropping it.
7. **Gemini CLI turns from `AfterAgent`.** It marks turn completion and is
   ignored today.
8. **CLI active time.** Derive busy time from prompt-to-stop intervals (Claude
   Code, Codex, Cursor), as a counterpart to `active_time{type=cli}`.
9. **Record a dual capture per provider.** This is the method step of #55 and
   upgrades the tables above from reading to evidence. Claude Code, Codex and
   Gemini CLI first; Cursor needs an Enterprise destination.

Items marked **impossible** need a change on the provider's side, such as token
counters in Claude Code hooks, or a hook translator that keeps
`cachedContentTokenCount` in Gemini CLI. They are not otel-hook issues.
