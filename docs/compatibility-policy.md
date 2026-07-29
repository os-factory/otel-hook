# Compatibility policy

## Node.js

`package.json` declares `"engines": { "node": ">=20" }`. CI verifies this on
every push/PR:

- Full matrix (typecheck, lint, test, build) on **Node 20 and 22, Linux**.
- A targeted, single-Node-version (22) pass on **macOS and Windows**, to catch
  OS-sensitive bugs (process spawning, path handling) without paying for a
  full matrix on every platform.

Dropping a Node major requires: (1) confirming no supported provider hosts
still require it, (2) a version bump documented in this file's changelog
section below, and (3) removing it from `.github/workflows/ci.yml`'s matrix in
the same PR.

## Canonical schema version

Every canonical event carries `schemaVersion` (`CANONICAL_SCHEMA_VERSION`,
currently `1`). Per [ADR 0002](adr/0002-versioned-canonical-model.md):

- **Adding an optional field** to an existing event type is non-breaking and
  does not require a version bump.
- **Re-interpreting an existing field's meaning** (not just adding to it)
  requires a version bump, because a consumer holding the old semantics would
  otherwise silently mis-total usage or mis-attribute an event.
- **Removing or renaming a field** requires a version bump.
- Consumers must treat an unknown `schemaVersion` as unreadable rather than
  guessing at its shape — this library will never ship a minor/patch release
  that silently changes what an existing `schemaVersion` means.

## Canonical log mapping version

Every exported OTLP log record carries `otelhook.log.mapping_version`
(`LOG_MAPPING_VERSION`, currently `1`). It is versioned separately from the
canonical schema because it describes a *projection* of the model, not the model:
a new event type changes what appears in the stream without changing what any
existing attribute means, and a consumer pinning the projection should not be
forced to re-read on every model addition.

- **Adding an attribute**, or a new value to the `otelhook.log.signal`
  vocabulary, does not require a bump.
- **Re-interpreting an existing attribute or signal value** requires a bump.
- **Removing or renaming an attribute** requires a bump.

The mapping table, the attribute vocabulary, and the per-adapter signal
capability declarations are in
[docs/canonical-log-mapping.md](canonical-log-mapping.md). Signal capabilities are
*derived* from an adapter's `lifecycleEvents`, so they are not a separately
versioned contract an adapter can let go stale.

## Public API surface

The supported public surface is exactly what's re-exported from the entry
points listed in `package.json`'s `"exports"` map (`.`, `./model`,
`./providers`, `./privacy`, `./config`, `./errors`, `./runtime`, `./testing`)
and documented in the [README](../README.md)'s entry-point table.
`tests/public-api.test.ts` pins the exported names from the top-level entry
point; `tests/packaging/pack.test.ts` verifies every subpath actually resolves
and exposes exports once installed from a packed tarball, not just from
source.

- Removing an export, changing an exported function's parameter/return shape,
  or narrowing an exported Zod schema are all breaking changes.
- Adding a new export, or widening an accepted input type, is non-breaking.
- The provider adapter contract (`ProviderAdapter`, `ProviderContext`,
  `createEventFactory`, `createProviderRegistry`) is part of the public
  surface: a change here affects every provider integration, not just this
  package's own consumers, so it needs explicit sign-off from whoever owns
  the core contract (see `.github/CODEOWNERS`).

## Package shape

- ESM-only (`"type": "module"`, `"exports"` conditions expose `"import"`
  only). There is no CommonJS build and none is planned; a consumer on
  CommonJS needs a dynamic `import()`.
- Only `dist/`, `README.md`, and `LICENSE` are published (`package.json`'s
  `"files"`); `tests/packaging/pack.test.ts` fails CI if the packed tarball
  ever contains anything else, so source, tests, and fixtures never leak into
  a consumer's `node_modules`.
- First public release is `0.1.0`. Subsequent promotions follow
  [docs/release-checklist.md](release-checklist.md).

## Changelog

- 2026-07-25 — initial policy: Node >=20, schema version 1, ESM-only.
- 2026-07-26 — **breaking change to the provider adapter contract.**
  `ProviderCapabilities` gained a required `deliveryIdentifier` field
  (`none | partial | all`), and `ProviderAdapter` gained an optional
  `deliveryIdentity` method. A third-party adapter must declare the capability to
  compile; declaring `"none"` reproduces the previous behaviour exactly. Rationale
  and alternatives in [ADR 0007](adr/0007-replay-stable-delivery-deduplication.md).
- **A lone `*.start` no longer produces an OTLP record.** A lifecycle span id is
  derived from its scope, so both edges computed the same id and exporting on both
  put two records with one identity on the wire — which OTLP cannot reconcile,
  since it has no span update. The end edge now exports the single completed span.
  A consumer that counted start-edge records will see fewer spans and correct
  durations; a span whose end never arrives is not exported at all, and the sweep
  counts those (`expiredOpen`). See
  [docs/state-retention.md](state-retention.md).
- **`HookIngestOutcome` gained `exportRejected`**, and `ingest` gained an optional
  `HookIngestOptions` second parameter. Both are additive for callers reading the
  outcome; an implementer of the `OtelHook` interface must supply the field.
- **`SpanCleanupResult` gained a required `expiredOpen`**, and `SpanStartResult`
  gained a `published` variant for a start whose scope was already exported.
- **`HookIngestOutcome` gained a required `durability`** (`DeliveryDurability`),
  and `DeliveryReport` gained `partialLoss`. A partially delivered callback is now
  *committed* rather than released, so a consumer that treated any rejection as
  retryable will see fewer retries and an explicit loss count instead.
- **Usage accounting moved after export.** `usageObservations` is empty for a
  callback whose telemetry was fully lost or suppressed, where it was previously
  populated regardless. The cumulative baseline is no longer advanced for those
  callbacks, which is what makes a retry recover the same difference.
- **`AsyncLock.run` cancels a queued operation whose caller timed out waiting.**
  Previously the operation still ran afterwards and its result was discarded. Any
  caller that relied on a timed-out write eventually landing must now treat the
  rejection as final — which is the point: state no longer changes after the caller
  has reported that it did not.
- **`SemanticMappingOptions` gained `correlationAvailable`.** Omitted, an unpaired
  start is deferred exactly as before; set to `false` it is exported as an
  explicitly labelled fallback under a discriminated span id, so a start that
  nothing recorded is never dropped silently.
  No canonical schema version bump: no event type or field changed.
- **An OTLP logs pipeline was added, off by default** (log mapping version 1).
  `ExporterPolicy` gained a required `logs` sub-object (`LogsPolicy`); a caller
  hand-building an `ExporterPolicy` without running it through the schema must
  supply it, and `DEFAULT_LOGS_POLICY` reproduces the previous behaviour exactly
  (nothing is exported on the logs signal). `HookRuntime` gained `logSink` and an
  optional `logSpool`; `HookRuntime.health()` now reports two telemetry subsystems,
  so `DeliverySubsystem` gained `telemetry-log-sink`. Enabling the signal is not
  enough to disclose content: `exporter.logs.includeContent` is a second gate on top
  of `privacy.contentMode`, and `raw` still requires `allowRawContent`.
  `HookIngestOutcome.emitted` and `exportRejected` now count records across *every*
  wired signal, so a run with logs enabled reports spans plus log records — which is
  what makes `durability` correct across them. Both were already record counts
  rather than event counts, and with logs off (the default) neither value changes.
  No canonical schema version bump: no event type or field changed. See
  [docs/canonical-log-mapping.md](canonical-log-mapping.md).
