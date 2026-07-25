# @osfactory/otel-hook

Provider-neutral coding-agent hooks for OpenTelemetry.

This project exposes both an importable TypeScript library and the `otel-hook`
CLI. Provider adapters normalize coding-agent hook protocols into a versioned
canonical event model before lifecycle processing, privacy filtering, and OTLP
export.

## Status

Early development. Milestone M1 (the core contract) is implemented: the
canonical model, usage semantics, provider adapter boundary, privacy service,
error taxonomy, configuration resolution, and a minimal runtime orchestrator with
in-memory test doubles. No provider adapters and no OTLP exporter yet.

## Principles

- Independent of any telemetry consumer, including HAR
- Explicit, immutable per-invocation identity
- Provider-specific protocol adapters
- Fail-open hook execution and fail-closed attribution
- No conversation or tool content by default
- Replay-safe usage accounting

## Entry points

| Import                            | Contents                                                        |
| --------------------------------- | --------------------------------------------------------------- |
| `@osfactory/otel-hook`            | Everything below, re-exported                                    |
| `@osfactory/otel-hook/model`      | Canonical events, identity, usage, content facts, extensions      |
| `@osfactory/otel-hook/providers`  | `ProviderAdapter`, event factory, registry                        |
| `@osfactory/otel-hook/privacy`    | Privacy policy, privacy service, workspace derivation             |
| `@osfactory/otel-hook/config`     | Typed configuration, precedence, environment parsing              |
| `@osfactory/otel-hook/errors`     | Error taxonomy, error info, attribution outcomes                  |
| `@osfactory/otel-hook/runtime`    | `OtelHook`, ports, clock, ids, logger, in-memory implementations   |
| `@osfactory/otel-hook/testing`    | Test doubles, harness, synthetic reference adapter                |

## Canonical model

Every event carries `schemaVersion` (`CANONICAL_SCHEMA_VERSION`), identity,
provenance, workspace, a per-session `sequence`, and a timestamp. Lifecycle
coverage:

```text
session.start   session.end
prompt.submitted
generation.start generation.end
tool.start      tool.end
subagent.start  subagent.end
compaction.performed
error.raised
```

Usage is explicit about inclusive totals, subsets, cache-creation accounting,
provider totals, and delta/cumulative temporality — see
[docs/usage-semantics.md](docs/usage-semantics.md).

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
- Content must be described through `context.privacy` (`describeContent`,
  `describeStructured`). Events whose disclosure does not match the resolved
  policy are dropped with a `privacy-policy-violation` diagnostic.
- Sequences must be consecutive from `input.sequenceBase`; `createEventFactory`
  handles this, along with derived, replay-safe event ids.
- Events must carry the identity the core resolved. Mismatches are dropped.

## Testing an adapter

```ts
import { createTestHook, findDisclosureViolations, batchContains } from "@osfactory/otel-hook/testing";

const harness = createTestHook({ adapters: [createAcmeAdapter()] });
const outcome = await harness.hook.ingest({ payload, transport: "hook-stdin" });

expect(outcome.attribution).toBe("attributed");
expect(findDisclosureViolations(harness.sink.events())).toEqual([]);
expect(batchContains(harness.sink.events(), "a prompt fragment")).toBe(false);
```

The harness wires a deterministic clock, deterministic ids, an in-memory state
store and recording sink (both with fault injection), and a recording logger.
`createFixtureAdapter()` is a synthetic reference adapter over a documented,
invented payload format; use it as a template and to exercise the core.

## Runtime

```ts
const hook = createOtelHook({ sink, stateStore, config, registry, clock, ids, privacy, logger });
const outcome = await hook.ingest({ payload, transport: "hook-stdin" });
await hook.shutdown();
```

`ingest` never throws and always reports `ok: true`; `attribution` and
`diagnostics` describe what happened. Nothing is written to stdout unless a
provider's protocol requires it, and the hook exit code is always `0`
([ADR 0004](docs/adr/0004-stdout-and-fail-open.md)).

## Configuration

Precedence, lowest to highest: `defaults` → `file` → `environment` →
`inline-override`, merged per leaf field with per-field provenance. Configuration
carries exporter, privacy, detection, and diagnostics policy — and never
identity ([ADR 0001](docs/adr/0001-invocation-identity-isolation.md)).

```ts
const resolution = resolveConfig([
  { source: "file", patch: fileConfig, origin: "otel-hook.json" },
  { source: "environment", patch: parseEnvironmentConfig(process.env).patch },
]);
```

## Privacy

Content is omitted by default; only lengths and a stable salted hash are
recorded. Optional `mask` and `redact` modes exist, and `raw` additionally
requires `allowRawContent`. Secret-looking keys are replaced recursively at every
depth, and depth, string, array, object, and per-invocation event counts are all
bounded ([ADR 0005](docs/adr/0005-central-privacy-service.md)).

## Architecture decisions

See [docs/adr](docs/adr/README.md).

## Development

```bash
npm install
npm run check
```

Licensed under MIT.
