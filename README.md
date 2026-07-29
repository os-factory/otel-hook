# @osfactory/otel-hook

Provider-neutral coding-agent hooks for OpenTelemetry.

`otel-hook` is a CLI you register as a hook in a coding agent, and a TypeScript
library you can embed. Provider adapters normalize each agent's hook protocol
into a versioned canonical event model, which is then screened for privacy,
accounted for usage, and exported over OTLP.

## Status

**Private, unreleased.** `package.json` sets `"private": true` and the version is
`0.0.0`; publishing requires an explicit release promotion, not just a green
build. See [docs/release-checklist.md](docs/release-checklist.md) and
[Known limitations](#known-limitations) — several of those entries are release
blockers, not footnotes.

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
| `codex`       | OpenAI Codex CLI   | stable       | silent          | cumulative        | `setup` (global and project) |
| `cursor`      | Cursor             | stable       | provider JSON   | delta             | unsupported                  |
| `gemini-cli`  | Gemini CLI         | stable       | silent          | delta             | `setup` (global and project) |
| `antigravity` | Google Antigravity | experimental | silent          | delta             | `setup --settings-file`      |

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
  would file one agent's telemetry under another's id. Cursor and Antigravity
  payloads, which are camelCase, auto-detect cleanly.

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
records as unclaimed, so a redelivery re-exports it. Deterministic span ids make
that duplicate identifiable at the collector — the same trace and span id, so a
backend can drop it — which is the recovery this design offers instead of a
guarantee it cannot keep. See
[Crash semantics](#crash-semantics-and-what-deduplication-does-not-cover).

A host-supplied delivery id, unique by construction because only the host knows
it:

```bash
otel-hook run --provider cursor --callback-id "$HOST_DELIVERY_ID"
```

Or, with no flag at all, one normalized from payload fields the selected adapter
vouches for — a `tool_use_id`, a `turn_id`, a `generationId`, a
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
`--require-callback-id` reports each callback that could not be deduplicated,
naming the provider and the missing capability:

```bash
otel-hook run --provider claude-code --require-callback-id
# stderr: delivery-identifier-unavailable  "provider.delivery_identifier":"partial"
#         "delivery.reason":"callback-not-identifiable"
```

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

`staleClaimMillis` — how long an uncommitted claim is respected before a later
delivery may assume the holder died — is raised automatically to cover this
installation's own worst-case work (state lock wait + every permitted export
attempt + the bounded flush). A window shorter than that is not a smaller
guarantee but the opposite of one: a peer would declare a *live* process abandoned
and export the same callback twice. Raising it is logged.

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
| `@osfactory/otel-hook/telemetry`   | OTLP sink, durable spool, canonical-event-to-span mapping                      |
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

Planners exist for `claude-code`, `codex`, `gemini-cli`, and `antigravity`. For
`cursor` the result is `{ status: "unsupported", reason }`: its `hooks.json` shape
*is* documented, but this package's Cursor payload contract is synthetic, so a
registration would fire a hook whose every payload the adapter rejects. Writing a
guessed shape — or a verified shape into an adapter that cannot read the result —
is worse than shipping no installer. `PROVIDER_REGISTRATION_SUPPORT` carries the
reason and the `evidenceBlocker` per provider;
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

## Privacy

Content is omitted by default; only lengths and a stable salted hash are
recorded. `mask` and `redact` modes exist, and `raw` additionally requires
`allowRawContent`. `WorkspaceIdentity` has no path field at all, so a filesystem
path cannot reach an event regardless of content mode. Secret-looking keys are
replaced recursively at every depth, and depth, string, array, object, and
per-invocation event counts are bounded
([ADR 0005](docs/adr/0005-central-privacy-service.md)).

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

The first is chosen deliberately. A duplicate is identifiable and removable: span
ids are derived from `(provider, session, family, scopeKey)`, so the re-export
carries the *same* trace and span id and a backend can drop or overwrite it. A
silent loss is neither identifiable nor recoverable — nothing downstream can tell
that an observation was supposed to exist.

So, precisely:

- **Export is at-least-once.** A callback whose telemetry the collector accepted may
  be exported again if this process dies before committing the claim.
- **Local accounting is at-most-once**, because it is committed under the same lock
  as the claim it depends on — but see the rollup caveat below.
- **A partial batch is terminal**, and its loss is reported rather than retried.
- **`staleClaimMillis` is a floor, not a proof.** If a real installation exceeds it,
  a peer reclaims a live claim; the commit then detects the mismatched owner token,
  refuses, and raises `delivery-claim-superseded` rather than silently double
  counting. That diagnostic means the window needs raising.

Usage rollups are applied in a second critical section after the baseline advance,
because the accumulator takes the same non-reentrant session lock. A crash between
the two under-counts one rollup increment; the baseline is correct, so the *next*
observation is unaffected. Making the rollup idempotent by delivery identity would
need the rollup and the claim in one atomic write, and this store has no multi-key
transaction — inventing one across keys would be a pseudo-transaction that fails in
ways harder to reason about than the window it closes, so it is documented instead.

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
   committed re-exports on redelivery. Deterministic span ids make the duplicate
   identifiable and droppable at the collector, which is the mitigation; it is not a
   guarantee. See
   [Crash semantics](#crash-semantics-and-what-deduplication-does-not-cover).

   *Coverage.* No adapter identifies every callback, and the Gemini CLI identifies
   none. Each refuses the callbacks
   where a stable-looking field would suppress a *genuine* second firing rather
   than a redelivery. `--require-callback-id` reports these per callback, and a
   host-supplied `--callback-id` closes any of them. Neither `invocationId` nor
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
   - **Cursor** — `preCompact`, and the dedicated shell, MCP, file-edit, and
     file-read callbacks when `toolCallId` is absent, because the only remaining
     distinguishing fields are the command line and the file path.
   - **Gemini CLI** — *everything*, declared `deliveryIdentifier: "none"`. The
     protocol carries no request, turn, or tool-call id at all. The only candidate
     is the provider-recorded `timestamp`, and a millisecond reading repeats on
     redelivery without *separating* two genuine firings. `session_id` does not
     rescue the session edges either: `SessionStart` carries
     `source: "startup" | "resume" | "clear"` and fires again under the *same*
     `session_id` on resume and clear, so keying on it would suppress every restart
     after the first. `--callback-id` is the only deduplication available for this
     provider.
   - **Antigravity** — `PreInvocation`, `PostInvocation`, `Stop`. `Stop` can fire
     twice per invocation, and the only field separating those firings
     (`fullyIdle`) is an unconfirmed reconstruction, not something to build an
     at-most-once guarantee on. None of the three produce canonical events anyway.

   A process killed between claiming a callback and completing it leaves an
   uncommitted claim; a later delivery reclaims it once `staleClaimMillis`
   (default 60,000ms) has passed, so a crash costs a delayed export rather than a
   permanently lost one. Asserted in `tests/integration/delivery-dedup.test.ts`,
   `tests/providers/delivery-identity.test.ts`, and
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
7. **Cursor's payload contract is synthetic (release blocker).**
   `src/providers/cursor/payload.ts` documents its shape as invented for this
   repository. Cursor parity therefore runs through a documented envelope bridge
   (`ADAPTER-NOTE-005`), and Cursor cannot be claimed as verified upstream support
   until the contract is replaced with a captured one. This is also why
   `otel-hook setup --provider cursor` refuses: the `hooks.json` shape is known,
   but the adapter would reject the payloads a registration caused Cursor to send
   (see [docs/registration-evidence.md](docs/registration-evidence.md)).
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
    rather than from the payload — host-dependent, and wrong for a replayed
    payload. `tests/parity/codex-gemini.parity.test.ts` establishes our own
    semantics and pins the divergence instead of asserting agreement.
10. **Only OTLP HTTP/protobuf traces are exported.** `http/json` falls back to a
    disabled sink with a warning, and there is no metrics or logs pipeline.

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
