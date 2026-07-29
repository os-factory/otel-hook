# @osfactory/otel-hook

Provider-neutral coding-agent hooks for OpenTelemetry.

`otel-hook` is a CLI you register as a hook in a coding agent, and a TypeScript
library you can embed. Provider adapters normalize each agent's hook protocol
into a versioned canonical event model, which is then screened for privacy,
accounted for usage, and exported over OTLP.

## Status

**Published on npm.** Install with `npm install -g @osfactory/otel-hook` or
`npx @osfactory/otel-hook`. Releases are cut automatically from Conventional
Commit PR titles on `main` — see [docs/release-checklist.md](docs/release-checklist.md).
[Known limitations](#known-limitations) document what a given release
intentionally does and does not claim.

## Principles

- Independent of any telemetry consumer
- Explicit, immutable per-invocation identity; no ambient session state
- Provider-specific protocol adapters behind one contract
- Fail-open hook execution, fail-closed attribution
- No conversation or tool content by default
- Replay-safe usage accounting, no daemon

## Supported providers

`otel-hook providers` prints this table for your installed version, with the full
capability matrix. Adapter behaviour is *declared* rather than inferred, because
"this provider reports no cached tokens" and "this session used no cache" are
indistinguishable in the data.

| Provider id   | Agent              | Maturity     | stdout protocol | Usage temporality | Registration                 |
| ------------- | ------------------ | ------------ | --------------- | ----------------- | ---------------------------- |
| `claude-code` | Claude Code        | stable       | silent          | delta             | `setup` (global and project) |
| `codex`       | OpenAI Codex CLI   | stable       | silent          | cumulative[^1]    | `setup` (global and project) |
| `cursor`      | Cursor             | stable       | provider JSON   | delta             | `setup` (global and project) |
| `gemini-cli`  | Gemini CLI         | stable       | silent          | cumulative        | `setup` (global and project) |
| `antigravity` | Google Antigravity | experimental | silent          | delta             | `setup --settings-file`      |

[^1]: Codex's counters are cumulative over the **whole session**, not per turn:
    every usage-bearing hook stamps the rollout's running `total_token_usage`.
    Deltas are therefore diffed against the session's previous snapshot rather
    than per `turn_id`, which is what keeps a three-turn session from billing its
    first turn three times. `otel-hook providers` prints this as
    `usage temporality  cumulative (series: session-lifetime)`; see
    [docs/usage-semantics.md](docs/usage-semantics.md#which-series-a-cumulative-report-continues).

`antigravity` is registered but marked `experimental`: parts of its field and
lifecycle mapping are reconstructions pending confirmation against real captures.
Selecting it logs a warning to stderr, `providers` reports its open promotion
gates, and `--no-experimental` excludes it entirely.

## CLI

```bash
otel-hook run [--provider <id>] [options]   # process one hook payload from stdin
otel-hook doctor [--json]                   # configuration and delivery health
otel-hook providers [--json]                # adapters and their capabilities
otel-hook setup --provider <id> [options]   # register this hook in a provider's config
otel-hook diagnose [--json]                 # report what is registered where
otel-hook uninstall --provider <id>         # remove this hook from a provider's config
otel-hook --version
```

### `run`

Reads **exactly one** JSON value from stdin, bounded by `--max-input-bytes`
(default 1 MiB). Writes to stdout **only** what the selected provider's protocol
requires — for four of the five providers, nothing at all. Every diagnostic goes
to stderr as one JSON object per line.

**`run` always exits 0.** Unreadable stdin, malformed JSON, an unknown provider,
an ambiguous detection, conflicting identity, an unreachable collector, an
unwritable state directory: all become stderr diagnostics
([ADR 0004](docs/adr/0004-stdout-and-fail-open.md)). A telemetry hook that can
fail its host agent is a liability.

```bash
# Register this as the hook command; the payload arrives on stdin.
otel-hook run --provider claude-code \
  --endpoint https://collector.example/v1/traces \
  --header "authorization=Bearer $COLLECTOR_TOKEN"
```

Provider selection:

- `--provider <id>` is **preferred and recommended.** It is the only way to reach
  `exact` detection confidence for a payload with no self-identifying provider
  field, and it makes ambiguity structurally impossible.
- Without it, auto-detection requires a **unique** recognizer: if more than one
  registered adapter recognizes the payload, the invocation is refused with a
  diagnostic naming the candidates. There is no default provider and no tie-break
  by registration order.

  This matters in practice. Claude Code, the Codex CLI, and the Gemini CLI share a
  PascalCase hook vocabulary (`SessionStart`, `PreToolUse`, `PostToolUse`, `Stop`,
  `PreCompact`, `SubagentStop`). Measured against this repository's own fixtures, a
  real Claude Code `SessionStart` payload is claimed by the Gemini adapter at
  `exact` and by the Codex adapter at `strong`. Confidence is self-reported per
  adapter and is *not* comparable across providers, so taking the highest score
  would file one agent's telemetry under another's id. Cursor payloads, whose
  `hook_event_name` values are camelCase (`preToolUse`, `beforeSubmitPrompt`), and
  Antigravity's camelCase envelope both auto-detect cleanly.

Invocation identity — immutable, per invocation, never from the environment
([ADR 0001](docs/adr/0001-invocation-identity-isolation.md)):

```
--session-id --invocation-id --parent-invocation-id --root-session-id
--agent-instance-id --identity-file <path>
```

`--identity-file` accepts a JSON object with any of those fields plus `startedAt`
and a `workspace` identity, validated strictly. Flags and the file are *separate*
claims at equal confidence, so if they disagree — or if either disagrees with the
provider payload — the result is an identity **conflict**: attribution is declined
and nothing is exported, rather than one assertion silently winning.

No environment variable sets identity. The `OTEL_HOOK_*` variables and the
standard `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`, and
`OTEL_RESOURCE_ATTRIBUTES` configure the exporter, privacy, detection, and
logging only.

Exporter and runtime policy (never identity):

```
--config-file --endpoint --protocol --service-name --service-namespace
--timeout-ms --no-export --content-mode --log-level --header name=value
--resource-attr key=value --state-dir --installation-id --no-spool
--flush-timeout-ms --max-input-bytes --attr key=value --transport
```

Only header *names* enter the resolved-config snapshot that is logged and
reported; the values go straight to the exporter, so a snapshot cannot leak a
credential.

`--resource-attr` and `--attr` are different channels and never mix.
`--resource-attr` sets an OTLP **resource** attribute — a fact about this
deployment, attached to every exported span. `--attr` sets an opaque
**consumer** attribute carried on one invocation's identity. See
[Resource attributes](#resource-attributes).

Delivery deduplication suppresses a redelivered callback across process restarts,
because the identity it keys on is recomputed from durable inputs rather than
remembered in memory. Two identities can carry it.

**It is at-least-once, not exactly-once, and cannot be made exactly-once.** The
collector is a separate system: a batch is accepted over HTTP and the claim is then
committed to local state, and there is no transaction spanning those two. A process
killed in between leaves a callback the collector has *taken* and local state still
records as unclaimed, so a redelivery re-exports it. The re-export is **labelled,
not silent**: it lands in the same trace and carries
`otelhook.span.orphan="already-closed"`, because the span correlator finds the scope
already closed and refuses to republish under the accepted span's id. That is the
recovery this design offers instead of a guarantee it cannot keep. See
[Crash semantics](#crash-semantics-and-what-deduplication-does-not-cover).

A host-supplied delivery id, unique by construction because only the host knows
it:

```bash
otel-hook run --provider cursor --callback-id "$HOST_DELIVERY_ID"
```

Or, with no flag at all, one normalized from payload fields the selected adapter
vouches for — a `tool_use_id`, a `turn_id`, a `generation_id`, a
provider-recorded timestamp:

```bash
otel-hook run --provider cursor            # redelivered tool callbacks dedupe
otel-hook providers --json                 # per-adapter "deliveryIdentifier"
```

Either way, a redelivery suppresses duplicate *telemetry* while still producing
the provider's protocol response, because a redelivered callback still expects
one. Deduplication is scoped by provider, installation, and the provider's own
session, and the pair that reaches state is a digest — a provider's session id or
tool-call id is never written to disk or logged as a side effect of deduplicating
on it. Adapters report identifier-shaped *components*, never content: prose and
filesystem paths cannot satisfy the contract's component guard, so a delivery id
derived from a prompt or a home directory is a rejected claim rather than a
privacy incident.

No adapter identifies *every* callback. Coverage is declared per provider
(`deliveryIdentifier: none | partial | all`) rather than left to be inferred, and
`--require-callback-id` reports each callback that could not be deduplicated —
naming the **callback**, not only the provider, because the provider id and the
capability are identical for every callback of that provider and so identify
nothing an operator can act on:

```bash
otel-hook run --provider claude-code --require-callback-id
# stderr: delivery-identifier-unavailable  "provider.delivery_identifier":"partial"
#         "delivery.reason":"callback-not-identifiable"
#         "delivery.source_event_name":"Stop"
#         prompt_id is not a delivery identity here: Claude Code can fire Stop
#         more than once per prompt when a hook continues the turn
```

The explanation comes from the adapter's own gap table, so it names the protocol
field whose absence is the gap — which is the one thing a host or a provider owner
can actually change. Gap reasons are validated on the way out like any other
adapter output: a reason carrying a filesystem path or a newline is dropped rather
than printed.

A suppressed redelivery is parsed but changes nothing: no export, no advance of
the session sequence counter, and no rewrite of a cumulative usage baseline. Both
of those are canonical state — the sequence seeds every event's derived id — so
advancing them for a callback that is not a new observation would renumber the
next genuine event and change its id.

A claim is committed only once the batch is somewhere durable, and the test is
**any** rather than **all** — `outcome.ingest.durability`:

| Fate | Meaning | Claim |
| --- | --- | --- |
| `nothing-to-deliver` | Suppressed, or no events to export | committed |
| `delivered` | Every span reached the collector or the spool | committed |
| `partial` | Some reached it, some did not | committed, `delivery.partialLoss` set |
| `lost` | Nothing reached it | released, `delivery.retryable` set |

A successful spool enqueue counts as delivered, because a later invocation drains
it. `lost` releases the claim, so redelivering retries instead of being suppressed
— committing there would be an at-most-*zero* guarantee: the telemetry gone and
the claim saying never to try again.

`partial` is **terminal**: it is not retried. Retrying would re-export every span
the collector already accepted, turning a reported loss into a silent double-count,
and a duplicated span corrupts a total nobody can reconstruct while a reported loss
is a number somebody can act on.

Usage accounting is part of that commit, not of parsing. Deltas are derived and the
cumulative baseline advanced **after** delivery is known and only for a committed
callback, so a lost callback leaves the baseline exactly where its retry needs it —
otherwise the retry would diff the advanced snapshot against itself and report zero.
Sequence numbers are the one thing reserved up front, so a failed callback leaves a
harmless gap in the numbering rather than a reused number.

Rollup application is **idempotent by delivery identity**. It is the one piece of
accounting outside `ingest`'s own transaction — the accumulator takes the same
non-reentrant session lock, so it runs in a second critical section — which makes it
the only place a reclaimed or superseded delivery could apply its numbers twice.
That matters most for a delta-reporting provider: a delta needs no baseline, so a
retry has nothing to diff against and would simply add the same tokens again. The
marker naming the last delivery folded in rides *inside* the rollup record, so the
check and the write are one atomic operation and no multi-key pseudo-transaction is
invented. Only the most recent delivery per rollup key is recognizable, which is the
retry window and nothing beyond it.

`staleClaimMillis` — how long an uncommitted claim is respected before a later
delivery may assume the holder died — is raised automatically to cover this
installation's own worst-case work (state lock wait + every permitted export
attempt + the bounded flush). A window shorter than that is not a smaller
guarantee but the opposite of one: a peer would declare a *live* process abandoned
and export the same callback twice. Raising it is logged.

Retention defers to the same window. `deliveryRetentionMillis` expires *handled*
callbacks, but the sweep will not drop an uncommitted claim until it is older than
the effective `staleClaimMillis` too —
otherwise tightening retention would delete a claim while its holder is still
exporting, and the concurrent redelivery would see a *fresh* callback. Records kept
back for that reason are reported as `cleanup.dedup.retainedInFlight`, and a
retention shorter than the stale window is logged. An abandoned claim is still
reclaimed once past both, so a crash costs a delayed export rather than a permanent
one.

It stays fail-open: an unidentifiable callback is still exported and still
accounted. Losing a real observation is unrecoverable, exporting a possible
duplicate is not. `--no-derive-callback-id` opts out of derivation entirely and
deduplicates only against `--callback-id`. See
[Known limitations](#known-limitations) for what each adapter cannot identify.

### `doctor`

```bash
otel-hook doctor --json
```

Reports the version, an attribute-safe configuration snapshot, a real
write/read/delete probe of the state directory, spool depth, exporter
configuration, privacy mode, and the adapter count. Exits 1 when any check fails,
so CI can gate on it. Every check is local: `doctor` never sends a span.

### `setup`, `diagnose`, `uninstall`

```bash
otel-hook setup --provider claude-code --dry-run   # exactly what would be written
otel-hook setup --provider claude-code             # project scope: .claude/settings.json
otel-hook setup --provider codex --scope global    # ~/.codex/hooks.json
otel-hook diagnose --json                          # what is registered, in both scopes
otel-hook uninstall --provider claude-code
```

`setup` writes into a configuration file this project does not own, so it is
conservative by construction:

- **Idempotent.** Re-running with the same options rewrites nothing — byte for
  byte, not merely semantically.
- **Upgrade-safe.** A registration written by an *earlier* version (recognized by
  the `--managed-marker` substring, `otel-hook` by default) is rewritten in place
  rather than duplicated, and pre-existing duplicates are collapsed. Two
  registrations of one hook means two spans per event.
- **Reversible.** `uninstall` removes exactly what `setup` added, including the
  structure it created, so a document that had no `hooks` key before has none
  after. Asserted byte for byte in `tests/install/lifecycle.test.ts`.
- **Non-destructive.** Other tools' hooks, matchers a developer narrowed by hand,
  unrelated settings keys, and the file's own indentation, line endings, and
  trailing newline all survive. A document that does not parse, or whose `hooks`
  value is not the documented shape, is **reported and left untouched** — never
  overwritten to make the installer succeed.
- **Atomic and locked.** Writes land through a temp file plus `rename` (atomic on
  POSIX and on Windows), and the read-merge-write sequence holds a lock file
  beside the target, so two concurrent setups cannot lose each other's work. A
  lock left behind by a crashed process is reclaimed after 30s.
- **Read-only when it says so.** `diagnose` and `--dry-run` take no lock and
  create no directories; `--dry-run` prints the exact bytes a real run would
  write.

`--scope` is `project` by default for `setup` and `uninstall` (writing into a home
directory is the surprising choice) and `all` for `diagnose`. Only events the
adapter turns into telemetry are registered; `--event` overrides that.

`diagnose` exits 1 on anything an operator should act on — a partial
registration, duplicate entries, an unparseable document — so CI can gate on
`otel-hook diagnose --json`.

Which providers this works for, and why not the others, is recorded in
[docs/registration-evidence.md](docs/registration-evidence.md).

## Library

```ts
import { createHookRuntime } from "@osfactory/otel-hook/integration";
import { createDefaultProviderRegistry } from "@osfactory/otel-hook/providers";
import { DEFAULT_CONFIG } from "@osfactory/otel-hook/config";

const runtime = createHookRuntime({
  config: { ...DEFAULT_CONFIG, exporter: { ...DEFAULT_CONFIG.exporter, endpoint } },
  registry: createDefaultProviderRegistry({ includeExperimental: false }),
  stateRootDir: "/var/lib/otel-hook",
  installationId: "prod",
  providerNamespace: "claude-code",
});

const outcome = await runtime.process({
  payload,
  transport: "hook-stdin",
  providerHint: "claude-code",
  // Optional. Omit it and the adapter's own replay-stable identifier is used
  // where the payload carries one.
  delivery: { callbackId: hostDeliveryId },
});

// Bounded: returns within flushTimeoutMillis even if the collector hangs.
await runtime.shutdown();
```

`process` never throws and `outcome.ingest.ok` is always `true`; inspect
`attribution`, `diagnostics`, and `usageRollups` to learn what happened, and
`outcome.delivery` to learn whether deduplication actually applied
(`deduplicated`, `origin`, `outcome`, and — when it did not — `reason` and the
adapter's declared `capability`). For the
lower-level orchestrator without the filesystem and lifecycle wiring, use
`createOtelHook` from `@osfactory/otel-hook/runtime`.

### Entry points

| Import                             | Contents                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| `@osfactory/otel-hook`             | Everything below, re-exported                                                 |
| `@osfactory/otel-hook/model`       | Canonical events, identity, usage, content facts, extensions                   |
| `@osfactory/otel-hook/providers`   | Adapter contract, event factory, registry, the five adapters, default factory  |
| `@osfactory/otel-hook/privacy`     | Privacy policy, privacy service, workspace derivation                         |
| `@osfactory/otel-hook/config`      | Typed configuration, precedence, environment parsing                          |
| `@osfactory/otel-hook/errors`      | Error taxonomy, error info, attribution outcomes                              |
| `@osfactory/otel-hook/runtime`     | `OtelHook`, ports, clock, ids, logger, in-memory implementations               |
| `@osfactory/otel-hook/lifecycle`   | Span correlator, callback deduplicator, usage accumulator, janitor             |
| `@osfactory/otel-hook/state`       | Filesystem and bounded-memory state stores, session locking                    |
| `@osfactory/otel-hook/telemetry`   | OTLP trace and log sinks, durable spools, canonical-event-to-span and -to-log mappings |
| `@osfactory/otel-hook/diagnostics` | Delivery health tracking and summaries                                        |
| `@osfactory/otel-hook/integration` | `createHookRuntime`: state + lifecycle + OTLP wired for short-lived hooks       |
| `@osfactory/otel-hook/install`     | Pure hook-registration planners, plus the locked/atomic apply lifecycle       |
| `@osfactory/otel-hook/testing`     | Test doubles, harness, synthetic reference adapter                            |

The subpaths are curated, not raw module barrels: on-disk key derivation, the
in-process lock, and span re-assembly are omitted so the state layout and the
canonical-event boundary stay free to change. A test asserts they stay out.

## Registration planners

`@osfactory/otel-hook/install` is two layers. The **planners** are pure: they take
the parsed contents of a provider's configuration document and return the
document to write back, plus what changed. Reading and writing the file is the
caller's job ([ADR 0003](docs/adr/0003-provider-adapter-boundary.md)), and
re-running with the same options is a no-op.

```ts
import { planProviderRegistration } from "@osfactory/otel-hook/install";

const plan = planProviderRegistration({
  providerId: "claude-code",
  existing: JSON.parse(await readFile(settingsPath, "utf8")),
  options: { command: "otel-hook run --provider claude-code" },
});
if (plan.status === "planned" && plan.changed) {
  await writeFile(settingsPath, `${JSON.stringify(plan.document, null, 2)}\n`);
}
```

A plan can also come back `conflict` (the document is not the shape the provider
documents — do not write), `invalid` (the options cannot produce a registration),
or `unsupported`.

The **lifecycle** layer — `runRegistrationLifecycle`, what the CLI's `setup`,
`diagnose`, and `uninstall` call — does the file handling described above:
locking, formatting preservation, atomic writes, and refusing rather than
clobbering.

Planners exist for `claude-code`, `codex`, `cursor`, `gemini-cli`, and
`antigravity`. Cursor's `hooks.json` is the one *flat* document among them —
`{ version: 1, hooks: { "<event>": [{ command }] } }` — and its default event set
deliberately omits `beforeShellExecution`/`afterShellExecution` and the MCP pair,
because one shell call fires those *and* `preToolUse`/`postToolUse`, and only the
generic pair carries a `tool_use_id` to correlate the two edges. `antigravity` is
the remaining gap, and it is a *location* gap rather than a shape one: `setup`
requires `--settings-file`. `PROVIDER_REGISTRATION_SUPPORT` carries the reason and
the `evidenceBlocker` per provider;
[docs/registration-evidence.md](docs/registration-evidence.md) is the long form.

## Canonical model

Every event carries `schemaVersion` (`CANONICAL_SCHEMA_VERSION`), identity,
provenance, workspace, a per-session `sequence`, and a timestamp:

```text
session.start   session.end
prompt.submitted
generation.start generation.end
tool.start      tool.end
subagent.start  subagent.end
compaction.performed
error.raised
```

Canonical event types are provider-neutral; the provider's own name for an event
is preserved separately in `provenance.sourceEventName` and never translated into
another provider's vocabulary. Usage is explicit about inclusive totals, subsets,
cache-creation accounting, provider totals, and delta/cumulative temporality —
see [docs/usage-semantics.md](docs/usage-semantics.md).

## Spans and cross-process correlation

A coding-agent hook fires once per lifecycle edge, usually as a separate
short-lived process for the `*.start` and for the `*.end`. Spans are therefore
built from *derived* identity rather than in-process context:

- `traceId = H(providerId, sessionId)` — one trace per session per provider, so
  an end emitted minutes later joins its start's trace, and two providers that
  reuse a session id never merge.
- `spanId = H(providerId, sessionId, family, scopeKey)` — stable across
  processes and idempotent under redelivery, so the process that closes a span
  computes the same id the process that opened it would have.
- Parents are recorded at start time, so an end process that never saw the
  generation id still hangs its tool span in the same place.

**One OTLP record per span.** Because the span id is derived from the scope, a
`*.start` edge and its later `*.end` edge compute the *same* id — and OTLP has no
notion of updating a span, so exporting on both edges would put two records with
one identity on the wire, which collectors variously drop, keep the older of, or
show twice. So a `*.start` with no end in its batch exports **nothing**: it is
recorded in the state store, and the end edge exports the single completed span
with a real duration. The two cases where a second record is legitimate get their
own span id, derived with an extra discriminator rather than colliding:

- a second, *distinct* end for a scope already closed
  (`otelhook.span.orphan=already-closed`).

The consequence worth knowing: **a span whose end never arrives is never
exported.** That is standard OpenTelemetry behaviour for a span that never ends,
and the alternative — inventing an end time — would report a wrong duration
instead of no duration. The state record expires on the retention window, and the
sweep counts what it dropped, so the cost is visible rather than silent:
`lifecycle.expired_open_spans` in the janitor's report and a warning on the log.

The end process recovers the start time, duration, parent, and start-only
attributes (tool kind, requested model, delegation depth, agent name) from the
state store. Whether that succeeded is always explicit on the span:

| Attribute                | Values                                                        |
| ------------------------ | ------------------------------------------------------------- |
| `otelhook.span.paired`   | `true` when both edges are known                              |
| `otelhook.span.pairing`  | `in-batch` \| `cross-process` \| `unpaired`                    |
| `otelhook.span.orphan`   | `none` \| `missing-start` \| `missing-end` \| `expired-start` \| `already-closed` \| `provider-mismatch` \| `state-incompatible` \| `state-corrupt` \| `state-unavailable` |

Correlation is an enrichment, never a precondition: unreadable, locked, or
absent state costs a span its pairing, never the export. Retention, bounds, and
what happens when the record shape changes are in
[docs/state-retention.md](docs/state-retention.md).

## Logs

A span reports that a tool call happened and whether it failed. It cannot report
what was *in* it — span attributes are a flat bounded map, one record per span. A
conversation turn is a sequence of distinct pieces of content, each with its own
role, length, and disclosure decision, so there is an optional OTLP logs pipeline
alongside the traces one.

**Off by default.** An installation that upgrades must not silently start sending a
second stream to a collector whose receivers and quotas were sized for traces:

```bash
otel-hook run --provider claude-code --endpoint http://localhost:4318/v1/traces --logs
# or: OTEL_HOOK_LOGS_ENABLED=1
```

One record per content fact, plus one per event that carries none, keyed by
`otelhook.log.signal`:

```text
session  prompt  response  reasoning
tool  shell  file-operation  mcp  delegation
compaction  error
```

Which signals a provider can populate is *derived* from the `lifecycleEvents` it
already declares, not maintained as a second list — a stale capability declaration
is worse than none, because a consumer cannot tell "reports no tool output" from
"nobody updated it". The mapping is versioned (`LOG_MAPPING_VERSION`, carried on
every record as `otelhook.log.mapping_version`).

Records carry the same identity attributes as spans and the **same derived trace and
span ids**, so a record lands in its span's trace without either signal knowing about
the other. Both ids come from the event's own `(providerId, sessionId)`, so two
sessions in one batch derive two trace ids — cross-session contamination is
structurally impossible rather than checked for. A record on a `*.start` edge points
*forward* to the span id the end edge will publish, since that edge exports no span
at all.

**Content is disabled by default, behind three gates.** All three must be open for a
body to appear:

| Gate | Default |
| --- | --- |
| `privacy.contentMode` ≠ `omit` | `omit` |
| `exporter.logs.includeContent` (`--logs-content`) | `false` |
| `privacy.allowRawContent`, for `raw` only | `false` |

`includeContent` is a separate switch because spans carry no content in *any* mode:
an installation that set `contentMode` to get a hash and a length has never had
content on the wire, and reusing that setting to also mean "publish prompts" would
change what an existing configuration discloses without anybody editing it. A
withheld body says which gate stopped it (`otelhook.content.withheld`:
`privacy-policy` | `logs-content-disabled` | `raw-not-permitted`) rather than being
a bare absence. The measurable description — length, byte length, salted hash,
secrets-redacted count — is present in every mode.

Delivery mirrors the trace sink: HTTP/protobuf, bounded batching, retries, bounded
flush, idempotent shutdown, and a **separate** durable spool at
`spool-logs`, so a logs outage cannot consume the capacity the primary signal's
retries need. The endpoint is derived from `--endpoint` (a trailing `/v1/traces`
becomes `/v1/logs`) unless `--logs-endpoint` states one. Health is reported per
signal, because a collector with no logs receiver leaves traces perfectly healthy.

The full mapping table, attribute vocabulary, bounds, and durability matrix are in
[docs/canonical-log-mapping.md](docs/canonical-log-mapping.md).

## Privacy

Content is omitted by default; only lengths and a stable salted hash are
recorded. `mask` and `redact` modes exist, and `raw` additionally requires
`allowRawContent`. `WorkspaceIdentity` has no path field at all, so a filesystem
path cannot reach an event regardless of content mode. Secret-looking keys are
replaced recursively at every depth, and depth, string, array, object, and
per-invocation event counts are bounded
([ADR 0005](docs/adr/0005-central-privacy-service.md)).

Spans carry no content in any content mode. The only pipeline that can carry it is
the optional [logs](#logs) one, and only with its own `includeContent` switch also
set — one policy, one privacy service, two gates.

The CLI additionally narrows the environment adapters can observe to an
allow-list of `OTEL_*` and agent-specific prefixes, minus the OTLP `*_HEADERS`
variables that carry credentials — a hook inherits the developer's whole
environment, and the adapter contract would otherwise hand all of it to every
adapter.

## Writing a provider adapter

```ts
import {
  createEventFactory,
  providerDetectionSchema,
  SILENT_HOOK_RESPONSE,
  type ProviderAdapter,
} from "@osfactory/otel-hook/providers";

export const createAcmeAdapter = (): ProviderAdapter => ({
  id: asProviderId("acme"),
  version: "1.0.0",
  capabilities: {
    /* declare what the provider actually reports */
  },

  // Cheap, side-effect free. Return `none` rather than guessing.
  detect: (input) => providerDetectionSchema.parse({ ... }),

  // Contribute claims; the core arbitrates and may decline attribution.
  identify: (input, context) => [ ... ],

  // The only place that reads the payload.
  parse: (input, context) => {
    const factory = createEventFactory({
      identity: input.identity,
      sequenceBase: input.sequenceBase,
      context,
    });
    factory.build({ type: "session.start", sessionKind: "interactive" });
    return { status: "parsed", events: factory.events() };
  },

  hookResponse: () => SILENT_HOOK_RESPONSE,
});
```

Rules the core enforces, not just documents:

- Raw payloads must not escape `parse`. Extensions and attributes accept only
  primitives, so a nested payload cannot be attached.
- Content must be described through `context.privacy`. Events whose disclosure
  does not match the resolved policy are dropped with a diagnostic.
- Sequences must be consecutive from `input.sequenceBase`; `createEventFactory`
  handles this, along with derived, replay-safe event ids.
- Events must carry the identity the core resolved. Mismatches are dropped.
- Adapters get no filesystem and no network, and must hold no cross-invocation
  state.

Pass the adapter to `createDefaultProviderRegistry({ additional: [...] })` to use
it alongside the built-ins.

## Testing an adapter

```ts
import { createTestHook, findDisclosureViolations, batchContains } from "@osfactory/otel-hook/testing";

const harness = createTestHook({ adapters: [createAcmeAdapter()] });
const outcome = await harness.hook.ingest({ payload, transport: "hook-stdin" });

expect(outcome.attribution).toBe("attributed");
expect(findDisclosureViolations(harness.sink.events())).toEqual([]);
expect(batchContains(harness.sink.events(), "a prompt fragment")).toBe(false);
```

The harness wires a deterministic clock and ids, an in-memory state store and
recording sink (both with fault injection), and a recording logger. Nothing reads
the wall clock, the environment, or the filesystem.

## Configuration

Precedence, lowest to highest: `defaults` → `file` → `environment` →
`inline-override`, merged per leaf field with per-field provenance. An unusable
layer is rejected rather than partially applied, and the CLI then falls back to
`DEFAULT_CONFIG` with a diagnostic rather than exiting.

### The logs signal

`exporter.logs` is its own sub-object, merged per leaf like everything else, so a
file may enable the signal while the environment sets only the endpoint:

| Field | Default | Flag | Variable |
| --- | --- | --- | --- |
| `enabled` | `false` | `--logs` / `--no-logs` | `OTEL_HOOK_LOGS_ENABLED` |
| `endpoint` | derived from `endpoint` | `--logs-endpoint` | `OTEL_HOOK_LOGS_ENDPOINT`, then `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` |
| `includeContent` | `false` | `--logs-content` | `OTEL_HOOK_LOGS_INCLUDE_CONTENT` |
| `maxBatchSize` | `128` | — | — |

Everything else — protocol, headers, timeout, service identity, resource
attributes — is shared with the traces signal, which is why `logs` is nested under
`exporter` rather than being a second top-level section that could drift.

Two combinations are reported as notes rather than errors, because both are things
an operator lands on by setting one switch and forgetting the other: logs enabled
with no endpoint and none derivable, and `includeContent` set while `contentMode` is
`omit` (so there is nothing disclosed to carry — the symptom, every body withheld,
otherwise looks like a bug).

### Resource attributes

`exporter.resourceAttributes` adds custom attributes to the OTLP Resource every
exported span carries. Three sources feed it, merged **per attribute key** with
the usual precedence:

| Source                                    | Layer             |
| ----------------------------------------- | ----------------- |
| `"exporter": {"resourceAttributes": {…}}`  | `file`            |
| `OTEL_RESOURCE_ATTRIBUTES`                | `environment`     |
| `--resource-attr key=value` (repeatable)  | `inline-override` |

```bash
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment=staging,deployment.note=a%2Cb"
otel-hook run --provider claude-code --resource-attr team.name=core
```

Each key is its own leaf, so the union of all three layers is exported and the
highest layer wins only the keys it names. Precedence is an override relation,
not a replacement one: a higher layer cannot *remove* a key a lower layer set.

`OTEL_RESOURCE_ATTRIBUTES` is parsed as the specification defines it — W3C
Baggage. Comma-separated `key=value` pairs, optional surrounding whitespace, an
ignored `;`-delimited metadata suffix, optional surrounding quotes, and
**percent-encoded values**, so `deployment.note=a%2Cb` is one attribute whose
value is `a,b` rather than two malformed entries. An unusable entry is reported
and skipped; the rest of the variable still applies.

Bounds and refusals, all enforced in every layer:

- at most 64 attributes, keys ≤ 255 characters, values ≤ 2048 characters;
- keys must start with a letter and use only letters, digits, and `_ . - /`;
- values are a single string, number, or boolean — never an array, which no
  environment variable can express;
- a key matching the privacy policy's secret-name patterns (`api_key`,
  `*.token`, `authorization`, …) is dropped. A resource attribute rides on
  *every* span, so this would be the most durable possible leak.

**`service.name` is never set by a resource attribute.** It is typed exporter
policy with its own precedence, so a map that could also write it would make the
winner depend on merge order inside the exporter. `--resource-attr
service.name=…` and a `service.name` key in a config file are refused outright,
naming `--service-name` instead. A `service.name` (or `service.namespace`) inside
`OTEL_RESOURCE_ATTRIBUTES` — the shape a migrating deployment already has — is
honoured, but as the *weakest* source of that field:

```
OTEL_HOOK_SERVICE_NAME  >  OTEL_SERVICE_NAME  >  service.name in OTEL_RESOURCE_ATTRIBUTES
```

A disagreement between those variables is warned about, naming the variables and
not their values.

Attributes survive the durable retry spool: the whole resolved resource is
persisted with the batch and replayed as recorded, because it describes the
invocation that made the observation rather than the one that drained the spool.
Custom attributes are re-checked on the way out, so a hand-edited spool file
cannot inject one the live path would have refused.

Diagnostics report resource attribute **names** only — `doctor --json` shows
`exporter.resource_attribute_names`. A name is already on the wire in every
exported resource; a value is not disclosed anywhere a name would do.

## Crash semantics, and what deduplication does not cover

Two systems are involved and only one of them is transactional. Local state — the
sequence counter, the usage baseline, the delivery claim — lives in a filesystem
store this package controls. The collector does not. There is no protocol that
commits an OTLP export and a local state write together, so every ordering leaves a
window:

| Order | Crash window | Consequence |
| --- | --- | --- |
| export, then commit (**chosen**) | accepted by the collector, claim not yet committed | a redelivery **re-exports**: at-least-once |
| commit, then export | claim committed, export never happened | the observation is **lost**, silently |

The first is chosen deliberately. A duplicate is *identifiable*; a silent loss is
neither identifiable nor recoverable — nothing downstream can tell that an
observation was supposed to exist. Precisely how identifiable is worth being exact
about, because there are two cases and only one of them is droppable by span id:

| Re-export | When | What the collector sees |
| --- | --- | --- |
| byte-identical | the redelivery derives the **same** event id | the same trace and span id; the span correlator replays the facts already on disk, so a backend drops or overwrites |
| labelled duplicate | the redelivery derives a **different** event id | the same trace, a discriminated span id, and `otelhook.span.orphan="already-closed"` with `otelhook.span.paired=false` |

The second is the common case for a reclaimed claim, because most adapters seed each
hook firing with a distinct invocation — so the re-export cannot reuse the accepted
span's id without overwriting a published observation, and it is classified instead.
That attribute does not *prove* duplication (a genuine second close of one scope
carries it too), but it does mean the duplicate never arrives indistinguishable from
a first observation, which is what makes at-least-once survivable downstream. Both
paths are pinned in `tests/integration/delivery-dedup.test.ts`.

So, precisely:

- **Export is at-least-once.** A callback whose telemetry the collector accepted may
  be exported again if this process dies before committing the claim.
- **Local accounting is at-most-once**, because it is committed under the same lock
  as the claim it depends on, and the rollup — the one part outside that lock — is
  idempotent by delivery identity.
- **A partial batch is terminal**, and its loss is reported rather than retried.
- **`staleClaimMillis` is a floor, not a proof.** If a real installation exceeds it,
  a peer reclaims a live claim; the commit then detects the mismatched owner token,
  refuses, and raises `delivery-claim-superseded` rather than silently double
  counting. That diagnostic means the window needs raising.

Usage rollups are applied in a second critical section after the baseline advance,
because the accumulator takes the same non-reentrant session lock. Two windows sit
there and they are not the same shape:

- **Double-application is closed.** The record carries the last delivery folded into
  it, so a reclaimed or superseded delivery re-applying its own delta is a no-op.
  This lives in one key rather than being simulated across two, which is what makes
  it a real atomic check instead of a pseudo-transaction.
- **Under-application stays open.** A crash *between* the baseline advance and the
  rollup write loses one rollup increment. The baseline is correct, so the next
  observation is unaffected, and baseline-first is chosen precisely so this window
  under-counts a rollup rather than letting the next diff over-count.

This is why known limitation 2 stays open: deduplication is a real suppression
mechanism with a real gap, not an exactly-once guarantee.

## Known limitations

Release blockers are marked. Each limitation is asserted by a named test, so
fixing one means updating that test rather than discovering a silent change.

1. **Auto-detection cannot separate the PascalCase provider family.** Claude
   Code, Codex, and Gemini CLI payloads are refused by auto-detection whenever
   more than one adapter recognizes them; `--provider` is required for those
   agents. Asserted in `tests/cli/detection.test.ts` and `tests/e2e/cli.test.ts`.
2. **Delivery deduplication is incomplete, and is at-least-once (release blocker).**
   Two separate gaps, both open:

   *Crash window.* OTLP export and local state cannot be committed together, so a
   process killed after the collector accepted a batch but before the claim was
   committed re-exports on redelivery. The re-export is labelled rather than silent —
   `otelhook.span.orphan="already-closed"`, or byte-identical when the redelivery
   derives the same event id — which is the mitigation; it is not a guarantee. See
   [Crash semantics](#crash-semantics-and-what-deduplication-does-not-cover).

   *Coverage.* No adapter identifies every callback, and the Gemini CLI identifies
   none. Each refuses the callbacks
   where a stable-looking field would suppress a *genuine* second firing rather
   than a redelivery. `--require-callback-id` reports these per callback — naming the
   callback and the protocol field whose absence is the gap — and a host-supplied
   `--callback-id` closes any of them. Neither `invocationId` nor
   `eventId` can substitute: some adapters seed the former with a clock reading,
   and the latter is seeded with a session sequence number that has already
   advanced by the time a redelivery arrives. What each adapter cannot identify:
   - **Claude Code** — `StopFailure`, `SessionStart`, `SessionEnd`, `PreCompact`,
     `PostCompact`, plus any `Stop` or `SubagentStop` that fired because a hook
     continued the turn. Claude Code can fire `Stop` more than once per prompt, so
     `prompt_id` alone is not a delivery identity; the `stop_hook_active` flag
     separates the once-per-prompt stop (`false`, deduplicated — it carries the
     turn's usage) from a continuation (`true`, deliberately left unidentifiable,
     because two continuations are indistinguishable and suppressing one would lose
     real tokens).
   - **Codex** — `SessionStart`, `PreCompact`, `PostCompact`, and any tool
     callback whose optional `tool_call_id` is absent (`tool_name` is not a
     substitute: two calls to the same tool in one turn would collapse into one).
   - **Cursor** — `preCompact`, `afterAgentResponse`, `afterAgentThought`, both
     subagent callbacks, and the dedicated shell, MCP, file-edit, and file-read
     callbacks, none of which carry a `tool_use_id` at all: the only remaining
     distinguishing fields are the command line and the file path, and
     `generation_id` would be worse than nothing, since one generation runs many
     shell commands.
   - **Gemini CLI** — *everything*, declared `deliveryIdentifier: "none"`. The
     protocol carries no request, turn, or tool-call id at all. The only candidate
     is the provider-recorded `timestamp`, and a millisecond reading repeats on
     redelivery without *separating* two genuine firings. `session_id` does not
     rescue the session edges either: `SessionStart` carries
     `source: "startup" | "resume" | "clear"` and fires again under the *same*
     `session_id` on resume and clear, so keying on it would suppress every restart
     after the first. `--callback-id` is the only deduplication available for this
     provider.
   - **Antigravity** — `Stop` only. The invocation and tool edges are identified
     from `invocationNum` and `stepIdx`, both on the verified field list. `Stop` can
     fire twice per invocation (idle, then fully idle), and the only field separating
     those firings (`fullyIdle`) is an unconfirmed reconstruction — so keying it on
     `invocationNum` would suppress the second, *real* firing rather than a
     redelivery.

   A process killed between claiming a callback and completing it leaves an
   uncommitted claim; a later delivery reclaims it once `staleClaimMillis`
   (default 60,000ms) has passed, so a crash costs a delayed export rather than a
   permanently lost one, and the sweep will not expire such a claim before then
   however short retention is set. Asserted in
   `tests/integration/delivery-dedup.test.ts`,
   `tests/providers/delivery-identity.test.ts`,
   `tests/runtime/lifecycle-dedup.test.ts`,
   `tests/runtime/lifecycle-usage-accumulator.test.ts`, and
   `tests/integration/hook-runtime.test.ts`.
3. **Cross-process span pairing needs a shared, durable state root.** A `*.end`
   fired as its own process carries its start time, duration, parent, and
   start-only attributes because the `SpanCorrelator` read them back from the
   state store. Point two invocations at different `--state-dir`s, disable the
   exporter, or let the record age past the retention window, and the end is
   exported as an explicitly classified orphan
   (`otelhook.span.orphan=missing-start` / `expired-start`) rather than merged
   on a guess. Asserted in `tests/e2e/cli.test.ts` and
   `tests/integration/span-correlation.test.ts`; see
   [docs/state-retention.md](docs/state-retention.md).
4. **Claude Code hook field aliases are normalized at the adapter boundary.**
   Current `reason` / `trigger` fields and legacy `end_reason` /
   `compact_trigger` wrappers map to the same canonical session and compaction
   events.
5. **Claude Code reports no reasoning-token counter and no provider total.**
   Confirmed against real captures at 2.1.220 — 0 of 4,999 `usage` objects carried
   either — so `reportsReasoningOutput: false` and `reportsProviderTotal: false`
   are settled exclusions rather than open questions, and a consumer can tell
   "this provider does not report reasoning tokens" from "this turn used none".
   Cache read and cache creation *are* reported, at
   `usage.cache_read_input_tokens` and `usage.cache_creation_input_tokens` (whose
   TTL split is a breakdown, reconciled and never added). No hook callback carries
   a token counter at all, so `usage` is read only when a wrapping harness
   attaches it. A harness that attaches an excluded counter anyway is told which
   field was declined. `ADAPTER-NOTE-001`; see
   [docs/claude-code-usage-contract.md](docs/claude-code-usage-contract.md).
6. **`contextTokensBefore` is an explicit exclusion for Claude Code.** Neither
   compaction callback reports a context size upstream (`PreCompact` carries
   `trigger` and `custom_instructions`; `PostCompact` carries `trigger` and
   `compact_summary`), so there is no provider-stated figure for injected state to
   carry across the boundary. Both figures are emitted when one harness attaches
   them to `PostCompact`, which carries both ends in a single callback; a
   `context_tokens_before` on `PreCompact` alone is declined explicitly rather
   than dropped silently. `compact_summary` is never read — it is conversation
   content. `ADAPTER-NOTE-002`.
7. **Cursor sends no timestamp, and four of its facts rest on capture rather than
   documentation.** The contract is derived from Cursor's published hooks
   reference plus four real redacted capture runs (Cursor IDE 3.12.17 and CLI
   2026.07.17); `src/providers/cursor/payload.ts` cites both, and
   `tests/parity/cursor.parity.test.ts` replays the fixture bytes through the
   shipped adapter with no envelope bridge — which is what retired
   `ADAPTER-NOTE-005`. Four residual limits, each a consequence of what Cursor
   does or does not send:
   - **No timestamp field exists** on any Cursor hook, in the reference or in any
     captured payload's key list, so `occurredAt` is a clock reading. Replay
     stability comes from `deliveryIdentity` instead, not from `invocationId`.
   - **Token accounting is partly undocumented.** `input_tokens`,
     `output_tokens`, `cache_read_tokens`, and `cache_write_tokens` appear on
     `stop` and `afterAgentResponse` in capture and nowhere in the reference.
     `input_tokens` is read as the canonical *inclusive* total with
     `cache_read_tokens` as a subset — the reading all three captured samples are
     consistent with — and a payload that contradicts it loses the breakdown
     rather than being reinterpreted. `cache_write_tokens` is not mapped at all:
     canonical usage needs an explicit cache-creation accounting, and nothing
     establishes whether Cursor bills those tokens inside or beside
     `input_tokens`, so a non-zero value produces a warning instead of a guess.
     See `CURSOR_USAGE_INCLUSIVITY_NOTE`.
   - **Two callbacks report no outcome.** `afterShellExecution` and
     `afterMCPExecution` carry no exit code and no status field, so their
     `tool.end` reports `outcome: "unknown"` rather than assuming success. The
     generic `postToolUse`/`postToolUseFailure` pair does distinguish the two,
     which is why it is the pair `setup` registers.
   - **Subagents and compaction are partial.** `subagentStop` carries no subagent
     id — the reference gives `subagent_id` to `subagentStart` only — so both are
     ignored rather than emitting a delegation that never closes, and
     `emitsSubagentEvents` is `false`. Cursor exposes no post-compaction
     callback, so `compaction.performed` carries `contextTokensBefore` and never
     `contextTokensAfter`.

   Delivery also differs by surface: `stop` and `afterAgentResponse` fired in the
   captured IDE runs and in neither CLI run, while `sessionEnd` fired in both CLI
   runs and in neither IDE run — from the same `hooks.json`. See
   [docs/registration-evidence.md](docs/registration-evidence.md).
8. **Antigravity is experimental (release blocker for that provider).** It maps
   only `tool.start`/`tool.end`; `PreInvocation`, `PostInvocation`, and `Stop` are
   ignored rather than mapped to invented session or generation identities. Its
   open promotion gates are printed by `otel-hook providers`. Its hook-file
   *shape* is recorded but no install *path* has been verified, so `setup`
   requires an explicit `--settings-file` and `diagnose` does not sweep it.
9. **No Python parity is claimed for Codex or Gemini CLI.** The pinned
    `opentelemetry-hooks==0.14.0` reference rewrites Gemini's `BeforeTool` into
    Claude Code's `PreToolUse` (`DIVERGENCE-007`), and reads Codex's
    `gen_ai.client.version` from whichever `codex` binary is on the *host's* PATH
    rather than from the payload's own `codex_version` — host-dependent, and wrong
    for a replayed payload (`DIVERGENCE-010`).
    `tests/parity/codex-gemini.parity.test.ts` establishes our own semantics and
    pins both divergences instead of asserting agreement.
10. **Only OTLP HTTP/protobuf is exported, for traces and logs.** `http/json` falls
    back to a disabled sink with a warning, and there is no metrics pipeline. The
    logs pipeline is off by default; see [Logs](#logs).
11. **Gemini CLI cache and reasoning tokens never reach a hook.** The CLI's hook
    translator rebuilds `usageMetadata` as exactly
    `{ promptTokenCount, candidatesTokenCount, totalTokenCount }`, so
    `cachedContentTokenCount` and `thoughtsTokenCount` — both present on the SDK
    response it reads — are dropped before any hook runs. The adapter declares
    `reportsCachedInput: false` and `reportsReasoningOutput: false` accordingly,
    and still maps both counters in case a later translator version stops
    stripping them. Unblocking this needs a change upstream, not here.

    Relatedly, `AfterModel` fires once **per streaming chunk**, and a chunk's
    counters are a snapshot of the response so far rather than that chunk's
    increment — the CLI's own `loggingStreamWrapper` keeps `lastUsageMetadata`
    and never sums. The adapter therefore reports `cumulative` temporality, so
    several usage-bearing chunks of one stream diff against a single
    generation-scoped baseline and are billed once in total. Asserted in
    `tests/providers/gemini/usage.test.ts`,
    `tests/providers/gemini/integration.test.ts`, and
    `tests/parity/codex-gemini.parity.test.ts`.
12. **MCP tool calls are recognized by a naming convention, not a declared fact.**
    The `mcp` log signal is assigned when a canonical tool name matches `mcp__…`,
    which is the shape Claude Code, Codex, and Gemini CLI payloads carry. Cursor's
    dedicated MCP callbacks produce `<server>:<tool>` names and therefore classify as
    `tool` — under-reporting, never a wrong claim. Fixing it properly needs a
    canonical field an adapter can populate from a *verified* contract, which is
    blocked on the same Cursor evidence gap as limitation 7. Asserted in
    `tests/runtime/telemetry-log-records.test.ts`.
13. **A `tool.end` log record cannot refine past `tool`.** Only the start edge
    carries `toolKind`, so the same `Bash` call is signal `shell` on its start and
    `tool` on its end. The span for that scope *does* carry the kind, recovered from
    state by the correlator, so the detail is available — just not on that record.

## Architecture decisions

See [docs/adr](docs/adr/README.md), and `AGENT.md` for the dependency direction
and safety rules contributors are held to.

## Development

```bash
npm install
npm run check          # typecheck, lint, build, full test suite, fixture validation
npm run test:e2e       # drive the built CLI binary as a child process
npm run test:parity    # differential suite against the pinned Python reference
npm run test:packaging # pack, install into a scratch consumer, exercise every export
```

The parity suite builds a cached virtualenv under the OS temp directory on first
run and skips itself if no Python interpreter is available.

Licensed under MIT.
