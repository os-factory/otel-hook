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

| Provider id   | Agent              | Maturity     | stdout protocol | Usage temporality | Registration planner |
| ------------- | ------------------ | ------------ | --------------- | ----------------- | -------------------- |
| `claude-code` | Claude Code        | stable       | silent          | delta             | unsupported          |
| `codex`       | OpenAI Codex CLI   | stable       | silent          | cumulative        | unsupported          |
| `cursor`      | Cursor             | stable       | provider JSON   | delta             | unsupported          |
| `gemini-cli`  | Gemini CLI         | stable       | silent          | delta             | supported            |
| `antigravity` | Google Antigravity | experimental | silent          | delta             | supported            |

`antigravity` is registered but marked `experimental`: parts of its field and
lifecycle mapping are reconstructions pending confirmation against real captures.
Selecting it logs a warning to stderr, `providers` reports its open promotion
gates, and `--no-experimental` excludes it entirely.

## CLI

```bash
otel-hook run [--provider <id>] [options]   # process one hook payload from stdin
otel-hook doctor [--json]                   # configuration and delivery health
otel-hook providers [--json]                # adapters and their capabilities
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

No environment variable sets identity. `OTEL_HOOK_*` variables configure the
exporter, privacy, detection, and logging only.

Exporter and runtime policy (never identity):

```
--config-file --endpoint --protocol --service-name --service-namespace
--timeout-ms --no-export --content-mode --log-level --header name=value
--state-dir --installation-id --no-spool --flush-timeout-ms
--max-input-bytes --attr key=value --transport
```

Only header *names* enter the resolved-config snapshot that is logged and
reported; the values go straight to the exporter, so a snapshot cannot leak a
credential.

Delivery deduplication is opt-in and explicit:

```bash
otel-hook run --provider cursor --callback-id "$HOST_DELIVERY_ID"
```

A repeated `--callback-id` suppresses duplicate *telemetry* while still producing
the provider's protocol response, because a redelivered callback still expects
one. Without a host-supplied id, redelivery is not detectable — see
[Known limitations](#known-limitations).

### `doctor`

```bash
otel-hook doctor --json
```

Reports the version, an attribute-safe configuration snapshot, a real
write/read/delete probe of the state directory, spool depth, exporter
configuration, privacy mode, and the adapter count. Exits 1 when any check fails,
so CI can gate on it. Every check is local: `doctor` never sends a span.

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
  delivery: { callbackId: hostDeliveryId },
});

// Bounded: returns within flushTimeoutMillis even if the collector hangs.
await runtime.shutdown();
```

`process` never throws and `outcome.ingest.ok` is always `true`; inspect
`attribution`, `diagnostics`, and `usageRollups` to learn what happened. For the
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
| `@osfactory/otel-hook/install`     | Pure, idempotent hook-registration planners                                   |
| `@osfactory/otel-hook/testing`     | Test doubles, harness, synthetic reference adapter                            |

The subpaths are curated, not raw module barrels: on-disk key derivation, the
in-process lock, and span re-assembly are omitted so the state layout and the
canonical-event boundary stay free to change. A test asserts they stay out.

## Registration planners

Registration helpers are **pure**: they take the parsed contents of a provider's
configuration document and return the document to write back, plus whether
anything changed. Reading and writing the file is the caller's job
([ADR 0003](docs/adr/0003-provider-adapter-boundary.md)), and re-running with the
same options is a no-op.

```ts
import { planProviderRegistration } from "@osfactory/otel-hook/install";

const plan = planProviderRegistration({
  providerId: "gemini-cli",
  existing: JSON.parse(await readFile(settingsPath, "utf8")),
  options: { name: "otel-hook", command: "otel-hook run --provider gemini-cli" },
});
if (plan.status === "planned" && plan.changed) {
  await writeFile(settingsPath, `${JSON.stringify(plan.document, null, 2)}\n`);
}
```

Planners exist only for `gemini-cli` and `antigravity`, whose configuration
contracts this repository has recorded. For `claude-code`, `codex`, and `cursor`
the result is `{ status: "unsupported", reason }` — writing a guessed settings
shape into a developer's real configuration is worse than shipping no installer.
`PROVIDER_REGISTRATION_SUPPORT` states the reason per provider.

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

## Known limitations

Release blockers are marked. Each limitation is asserted by a named test, so
fixing one means updating that test rather than discovering a silent change.

1. **Auto-detection cannot separate the PascalCase provider family.** Claude
   Code, Codex, and Gemini CLI payloads are refused by auto-detection whenever
   more than one adapter recognizes them; `--provider` is required for those
   agents. Asserted in `tests/cli/detection.test.ts` and `tests/e2e/cli.test.ts`.
2. **Redelivery is only detectable with a host-supplied `--callback-id`.** Some
   adapters derive `invocationId` from a clock reading (Claude Code documents each
   hook firing as a distinct invocation), and `eventId` is seeded with a session
   sequence number that has already advanced by the time a redelivery arrives.
   Neither is replay-stable, so the runtime does not pretend to dedupe without an
   explicit delivery id. Asserted in `tests/integration/hook-runtime.test.ts`.
3. **Cross-process span pairing is not applied to exported spans.** The
   `SpanCorrelator` is wired and exposed, and can distinguish a matched end from
   an orphaned one, but the OTLP mapping pairs `*.start` with `*.end` only within
   one batch. A lone edge is exported flagged `otelhook.span.paired=false` rather
   than merged using a duration read from state.
4. **Claude Code hook field aliases are normalized at the adapter boundary.**
   Current `reason` / `trigger` fields and legacy `end_reason` /
   `compact_trigger` wrappers map to the same canonical session and compaction
   events.
5. **Claude Code usage is read only from a nested Anthropic-shaped `usage`
   object.** Top-level `cache_read_input_tokens` / `reasoning_output_tokens` and
   `usage.total_tokens` are outside that contract and are not surfaced. This is
   consistent with the adapter's declared capabilities
   (`reportsReasoningOutput: false`, `reportsProviderTotal: false`) — which is
   exactly what capability declarations are for — but it means Claude Code cache
   and reasoning figures are unavailable until the provider owner confirms where
   the fields really live. `ADAPTER-NOTE-001`.
6. **`contextTokensBefore` is lost across the compaction boundary.** The adapter
   ignores `PreCompact` and cannot hold cross-invocation state, so only
   `contextTokensAfter` reaches `compaction.performed`. Carrying it forward would
   have to be done by the integration layer through the state store.
   `ADAPTER-NOTE-002`.
7. **Cursor's payload contract is synthetic (release blocker).**
   `src/providers/cursor/payload.ts` documents its shape as invented for this
   repository. Cursor parity therefore runs through a documented envelope bridge
   (`ADAPTER-NOTE-005`), and Cursor cannot be claimed as verified upstream support
   until the contract is replaced with a captured one.
9. **Antigravity is experimental (release blocker for that provider).** It maps
   only `tool.start`/`tool.end`; `PreInvocation`, `PostInvocation`, and `Stop` are
   ignored rather than mapped to invented session or generation identities. Its
   open promotion gates are printed by `otel-hook providers`.
10. **No Python parity is claimed for Codex or Gemini CLI.** The pinned
    `opentelemetry-hooks==0.14.0` reference rewrites Gemini's `BeforeTool` into
    Claude Code's `PreToolUse` (`DIVERGENCE-007`), and reads Codex's
    `gen_ai.client.version` from whichever `codex` binary is on the *host's* PATH
    rather than from the payload — host-dependent, and wrong for a replayed
    payload. `tests/parity/codex-gemini.parity.test.ts` establishes our own
    semantics and pins the divergence instead of asserting agreement.
11. **Only OTLP HTTP/protobuf traces are exported.** `http/json` falls back to a
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
