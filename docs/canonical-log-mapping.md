# Canonical log mapping

How canonical events become OTLP log records, what each record is permitted to
disclose, and which signals a provider can populate.

**Mapping version: 1** (`LOG_MAPPING_VERSION`). Every record carries it as
`otelhook.log.mapping_version`, so a consumer never has to infer which vocabulary
it is reading.

Compatibility rules, the same ones the canonical model follows:

- adding an attribute, or a new value to the `otelhook.log.signal` vocabulary,
  does **not** bump the version;
- changing what an existing attribute or signal *means* does.

## Why a second signal

A span reports that a tool call happened, how long it took, and whether it failed.
It cannot report what was in it: span attributes are a flat bounded map, one record
per span, exported once. A conversation turn is a *sequence* of distinct pieces of
content — a prompt, a response, reasoning, a tool input, a tool output — each with
its own role, its own length, and its own disclosure decision. That is a log
stream.

So the mapping emits **one record per content fact**, plus one record per event
that carries no content, so an event is never silently absent from the stream just
because the provider reported no text for it.

## Log signals

`otelhook.log.signal` is the coarse routing key: it lets an operator drop or route
a whole class with one collector rule instead of an enumeration of event types. The
fact's own `otelhook.content.kind` states precisely what the content is.

| Canonical event | Signal | Content facts mapped |
| --- | --- | --- |
| `session.start`, `session.end` | `session` | — |
| `prompt.submitted` | `prompt` | `content` |
| `generation.start` | `prompt` | `inputContent[]` |
| `generation.end` | `response`, or `reasoning` per fact | `outputContent[]` |
| `tool.start` | `mcp` \| `shell` \| `file-operation` \| `delegation` \| `tool` | `input` |
| `tool.end` | same, from the tool name only | `output` |
| `subagent.start`, `subagent.end` | `delegation` | — |
| `compaction.performed` | `compaction` | — |
| `error.raised` | `error` | `message` |

Tool refinement, first match wins:

1. `mcp` — the tool name matches `MCP_TOOL_NAME_PATTERN` (`mcp__…`);
2. `shell` — `toolKind` is `execute`;
3. `file-operation` — `toolKind` is `read` or `write`;
4. `delegation` — `toolKind` is `delegate`;
5. `tool` — anything else.

Two consequences worth stating outright, because both are deliberate
under-reporting rather than bugs:

- **`tool.end` refines less than `tool.start`.** A `tool.end` carries no
  `toolKind` — only the start edge does — so the same `Bash` call is `shell` on its
  start and `tool` on its end. The *span* for that scope is where the kind is
  authoritative, because the correlator recovered it from state.
- **MCP detection is a naming convention, not a declared fact.** The canonical
  model has no "this went through MCP" field, because no provider contract this
  package has verified carries one. What they carry is a tool name, and three of the
  four non-synthetic contracts (Claude Code, Codex, Gemini CLI) name MCP tools
  `mcp__<server>__<tool>`. A provider whose MCP names do not follow the convention
  classifies as `tool` — true, just less specific. The alternatives were
  per-provider branching inside the canonical layer, or a canonical field no adapter
  could populate from a verified contract; both are worse than under-reporting.

## Signal capability declarations

Which signals a provider *can* populate is **derived** from the `lifecycleEvents`
it already declares, by `logSignalsForLifecycleEvents`. It is not a second
hand-maintained list, and that is the point: a capability declaration that has gone
stale is worse than none, because a consumer cannot tell "this provider reports no
tool output" from "nobody updated the declaration".

| Declared lifecycle events | Signals declared |
| --- | --- |
| `session.start` / `session.end` | `session` |
| `prompt.submitted` | `prompt` |
| `generation.start` | `prompt` |
| `generation.end` | `response`, `reasoning` |
| `tool.start` / `tool.end` | `tool`, `shell`, `file-operation`, `mcp`, `delegation` |
| `subagent.start` / `subagent.end` | `delegation` |
| `compaction.performed` | `compaction` |
| `error.raised` | `error` |

The tool refinements are reported whenever an adapter emits tool events at all,
because which of them a given callback produces depends on the payload rather than
on the adapter. So this is a statement about what *may* appear, not what always
will — the same distinction the usage capabilities draw.

`otel-hook providers --json` prints each adapter's `lifecycleEvents`; the signals
follow from the table above.

## Record shape

Identity, identical to the span mapping and derived from the same fields:

| Attribute | Meaning |
| --- | --- |
| `session.id` | provider session id |
| `otelhook.invocation.id` | one hook invocation |
| `otelhook.provider.id`, `otelhook.provider.version` | attributed provider |
| `otelhook.workspace.id` | opaque `<scheme>:<token>` handle; never a path |

Event framing:

| Attribute | Meaning |
| --- | --- |
| `otelhook.event.type` | canonical event type |
| `otelhook.event.id` | canonical event id, so a redelivered record is identifiable |
| `otelhook.event.sequence` | per-session ordering key |
| `otelhook.log.signal` | the routing key above |
| `otelhook.log.mapping_version` | this document's version |

`eventName` is `otelhook.<canonicalEventType>`. `severityNumber` is `INFO`, except
`WARN` for a `denied`/`cancelled`/`aborted` outcome or a warning-severity error, and
`ERROR` for an `error`/`timeout` outcome or an error-severity error.
`timeUnixNano` and `observedTimeUnixNano` are both the event's `occurredAt`: this
mapping is pure and has no clock, so reporting the occurrence time twice is honest
where inventing a second timestamp would not be.

Per-signal attributes reuse the span vocabulary wherever one exists —
`gen_ai.tool.name`, `gen_ai.tool.call_id`, `gen_ai.request.model`,
`gen_ai.response.model`, `gen_ai.system`, `error.type`, plus `otelhook.outcome`,
`otelhook.tool.kind`, `otelhook.delegation_depth`, `otelhook.compaction.trigger`,
and the rest.

## Trace correlation

Every record carries a `spanContext` whose ids are the *same derived ids* the span
mapping computes for that event (`canonicalEventTraceIdentities`):

- `traceId = H(providerId, sessionId)`
- `spanId` — the lifecycle span for the event's scope, or the standalone span id for
  a point-in-time event

Two properties this buys:

- **A record on a `*.start` edge points forward.** That edge exports no span at all
  (the state store holds the start; the end edge publishes the one complete span),
  so the record names a span id that does not exist yet and will. Asserted across
  two real processes in `tests/integration/log-trace-correlation.test.ts`.
- **No cross-session contamination.** Both ids come from the event's own
  `(providerId, sessionId)`, never from a batch-level or module-level value, so two
  sessions in one batch derive two trace ids. There is no trace state to leak.

Correlation is resolved **once per batch**, shared by both sinks via
`shareCorrelationPerBatch`. `SpanCorrelator.correlateBatch` is not a read — it
records the start edge, marks a scope published, and takes the session lock to do
it — so a second call would see the first's writes and report a start it just
recorded as a duplicate, leaving the two signals pointing at different span ids for
one scope.

## Content disclosure

Three gates. A body appears only when all three are open.

| Gate | Default | Where |
| --- | --- | --- |
| `privacy.contentMode` ≠ `omit` | `omit` | the central privacy service, upstream |
| `exporter.logs.includeContent` | `false` | the logs pipeline's own switch |
| `privacy.allowRawContent`, for `raw` only | `false` | the pre-existing verbatim opt-in |

`includeContent` exists as a separate switch because **spans carry no content in
any content mode**. An installation that set `contentMode` to get a hash and a
length has never had content on the wire; reusing that setting to also mean "publish
prompts" would change what an existing configuration discloses without anybody
editing it.

`allowRawContent` is re-checked at the mapping even though `resolvePrivacyPolicy`
already downgrades `raw` without it. A fact reaching the sink with
`disclosure: "raw"` came from outside that path, and the wire is the last place to
refuse — the opt-in is a property of the bytes, not of one code path.

When a body is withheld, the record says so:

| `otelhook.content.withheld` | Meaning |
| --- | --- |
| `privacy-policy` | the policy produced no text at all (the default posture) |
| `logs-content-disabled` | content is disclosed elsewhere, but not to this pipeline |
| `raw-not-permitted` | verbatim text without the opt-in |

Stated rather than left as an absence, because "this prompt was empty", "this
deployment omits content", and "this deployment discloses content but not to logs"
are three different operational facts that all look like a missing body.

What is always present, in every mode, is the measurable description — which is
what makes the omission a policy rather than a gap:

`otelhook.content.kind`, `.role`, `.disclosure`, `.character_length`,
`.byte_length`, `.hash` (salted `sha256:…`), `.truncated`, `.secrets_redacted`,
`.label`.

Secret handling is the privacy service's, unchanged: secret-looking keys are
replaced recursively at every depth before a value is ever inspected, so a
secret-keyed tool input stays redacted even in `raw` mode; secret-looking *spans* in
free text are replaced in `redact` mode.

## Bounds

| Bound | Value | Why |
| --- | --- | --- |
| `MAX_LOG_BODY_CHARACTERS` | 8192 | a record's size, distinct from the policy's disclosure bound (up to 64Ki) |
| `MAX_LOG_RECORDS_PER_EVENT` | 64 | matches `contentFactsSchema`; a backstop for a hand-built event, not a routine cut |
| `MAX_LOG_RECORDS_PER_BATCH` | 2048 | the real ceiling on one invocation |
| `exporter.logs.maxBatchSize` | 128 | records per OTLP request |

A body cut at the record bound sets `otelhook.content.body_truncated`, kept separate
from the fact's own `truncated` so "the privacy policy shortened this" and "the log
record shortened this" stay distinguishable. Truncation is by code point, so a
multi-byte character is never split.

Records a bound dropped are **counted and reported**
(`LogMappingResult.droppedFacts`, logged as `logs.dropped_facts`): a caller that saw
only "accepted" would read a clipped batch as a complete one.

## Delivery

HTTP/protobuf, mirroring the trace sink: bounded batching, the exporter's own
retries, a bounded flush, an idempotent shutdown, and a durable spool for what a
down collector refused.

The endpoint resolves highest-first:

1. `exporter.logs.endpoint`, used verbatim;
2. the trace endpoint with a trailing `/v1/traces` swapped for `/v1/logs`;
3. the trace endpoint as a base URL with `/v1/logs` appended.

If none can be derived, the sink reports `no-endpoint` and disables itself rather
than posting an `ExportLogsServiceRequest` at a traces receiver — a rejection whose
cause is a configuration mistake reads as a collector fault.

The spool is a **separate queue** at
`<stateRoot>/<provider>/<installation>/spool-logs`, and only created when logs are
enabled. Separate because the two signals hold different encodings, so one mixed
queue would have each sender quarantining the other's perfectly deliverable
batches — and because a logs outage must not consume the capacity the primary
signal's retries need. Everything read back off disk is re-validated at the live
path's bounds: record count, string and body lengths, attribute count, and trace and
span ids held to their hex forms, with correlation all-or-nothing.

Durability is summed across signals, which is what gives `classifyDurability` the
right inputs:

| Traces | Logs | Durability | Consequence |
| --- | --- | --- | --- |
| delivered | delivered | `delivered` | commit |
| lost | lost | `lost` | release the claim; a retry cannot duplicate anything |
| delivered | lost | `partial` | terminal: commit and report the loss |
| lost | delivered | `partial` | terminal, for the same reason |

A **disabled** log sink reports zero accepted *and* zero rejected, so an
installation with logs off has its commit-or-retry decision made entirely by
traces — exactly as it was before logs existed. This is the one place the two sinks
differ, and it has to be: a disabled signal claiming to have accepted the batch
would make a total trace loss look like a partial delivery, and the callback would
commit instead of being retried.

Health is reported per signal (`telemetry-sink`, `telemetry-log-sink`) because they
fail independently; a single combined verdict would make an operator bisect which one
is broken. `otel-hook doctor` reports the same verdict without building an exporter,
and passes when logs are simply off.
