# Persisted state: layout, retention, and migration

A hook process lives for milliseconds. Everything that spans longer than one
process — the cumulative token baseline, the next sequence number, which
deliveries have been handled, and which lifecycle spans are open — lives in the
state store instead. This document says what is written, how long it survives,
what bounds it, and what happens when the shape changes.

See [ADR 0006](adr/0006-injected-state-and-telemetry.md) for why state is
injected rather than owned, and `AGENT.md` for the dependency direction.

## Where it lives

```text
<stateRootDir>/<providerId>/<installationId>/
  records/      one JSON file per key, named by a digest of the key
  quarantine/   records that failed to parse, moved aside rather than deleted
  locks/        one lock file per session
  spool/        export batches an unreachable collector refused
  spool-corrupt/
```

`<providerId>` and `<installationId>` are sanitized to safe path segments, so
no input can escape its namespace directory. Two providers, or two
installations, never share a directory: isolation is structural, not a runtime
check.

Records are written through a temp file plus `rename`, which POSIX makes atomic
within a directory. A process killed mid-write leaves an orphaned `.tmp-` file,
never a half-written record; readers skip `.tmp-` entries and the janitor
removes them by age.

## Key space

Keys are internal and deliberately unpublished — pinning them would freeze the
layout. As of the current version:

| Key                                                              | Holds                                            |
| ---------------------------------------------------------------- | ------------------------------------------------ |
| `sequence:<sessionId>`                                            | Next per-session event sequence number (reserved up front; gaps are expected) |
| `usage:<sessionId>:...`                                           | Cumulative usage baseline for delta computation  |
| `lifecycle:span:v2:<sessionId>:<providerId>:<scope>:<scopeKey>`    | One open or recently closed lifecycle span       |
| `lifecycle:dedup:v2:<deliveryScope>:<callbackId>`                 | A delivery id already claimed or completed       |
| `lifecycle:usage:<sessionId>:<scope>:<scopeKey>`                  | Running per-scope usage rollup                   |
| `lifecycle:epoch:<sessionId>:<scope>:<scopeKey>`                  | Rollup epoch, bumped when a provider counter resets |

The session segment leads so a whole session can be swept by prefix. The
provider segment sits under it so a start recorded by one provider is
physically unreachable from another provider's end, even when both are running
under the `unknown` provider placeholder and happen to reuse a session id.

Two properties of this space are load-bearing, because the store hashes a *whole
logical key* into one record:

- **Every variable segment is escaped.** `:` and `%` are percent-encoded, so a
  segment cannot forge the delimiter that follows it. Without that,
  `dedup(scope="a:b", id="c")` and `dedup(scope="a", id="b:c")` render the same
  key and collapse into one record — one delivery silently suppressing an
  unrelated one. It is reachable input: `--callback-scope` is host-supplied, and a
  provider-derived scope is literally `provider-session:<digest>`. Escaping is the
  identity function on ordinary segments, so keys already on disk keep their
  identity and no baseline is reset by it.
- **The two spaces whose layout has changed carry a version.** `span:v2` added the
  provider segment; `dedup:v2` re-scoped from a session id to a delivery scope.
  A v1 key must not be readable under v2 semantics — that would pair a span across
  providers, or suppress an unrelated callback. The *scoped* scan prefix includes
  the version; the bare prefix does not, so a sweep still reclaims records written
  by an earlier layout. Usage rollup keys are escaped but unversioned: their layout
  has not changed, and a version segment would orphan every cumulative baseline on
  disk to fix a bug escaping already fixes.

## The span correlation record

One record per lifecycle scope (`session`, `generation`, `tool`, `subagent`).
Values are flat primitives, because the state schema admits nothing else — a
nested object cannot be represented, so a provider payload cannot be smuggled
through state any more than it can through a span attribute.

| Field                          | Meaning                                                    |
| ------------------------------ | ---------------------------------------------------------- |
| `v`                            | Record shape version (`SPAN_RECORD_VERSION`)               |
| `providerId`                   | Provider that wrote the record                             |
| `startEventId` / `startedAt`   | The start edge, if it has been seen                        |
| `endEventId` / `endedAt`       | The end edge, if it has been seen                          |
| `parentFamily` / `parentScopeKey` | Where the span hangs, as recorded at start time         |
| `a:<attribute>`                | Span attributes only the start edge could supply           |

`a:` entries are an allowlist (`startOnlySpanAttributes`) capped at
`MAX_RECOVERED_START_ATTRIBUTES` and truncated to the attribute string bound, so
a record cannot grow with provider-controlled input.

Both halves of an edge are written together. A record carrying a timestamp with
no event id — or the reverse — is treated as corrupt rather than completed with
an invented half.

## Retention

| Bound                             | Default | Set by                                              |
| --------------------------------- | ------- | --------------------------------------------------- |
| Lifecycle record age              | 24h     | `HookRuntimeOptions.lifecycleMaxAgeMillis`          |
| Trusted age of an open span       | 24h     | `SpanCorrelatorDependencies.maxStartAgeMillis`      |
| Keys scanned per sweep, per component | 1,000 | `LifecycleJanitorOptions.maxEntriesPerComponent`  |
| Records scanned per `pruneStale`  | 5,000   | `FilesystemStateStore.pruneStale`                   |
| Session lock staleness            | 30s     | `FilesystemStateStoreOptions.lockStaleMillis`       |
| Session lock wait                 | 1s      | `HookRuntimeOptions.stateLockTimeoutMillis`         |
| Spool files                       | 500     | `DurableSpoolOptions.maxSpoolFiles`                 |

Every sweep is bounded, so cleanup costs a hook invocation a known amount of
work rather than however much has accumulated. `createHookRuntime` runs one
sweep opportunistically when a session ends (`sweepOnSessionEnd`); a host that
never ends a session cleanly should schedule `janitor.runOnce()` itself.

Ages are measured against a record's own `updatedAt`, taken from the injected
clock at write time, never the filesystem mtime — a host or a test with its own
time authority would otherwise be compared against an unrelated time source.

An open span that outlives the retention window is not merely deleted: when its
end finally arrives, the end is exported as an explicit orphan
(`otelhook.span.orphan=expired-start`) rather than with a duration that really
measures a machine suspend or a reused identifier.

## Write ordering within one callback

State is written in two phases around the export, not one:

1. **Before export**, under the session lock: the sequence range is read and
   reserved. Reservation is never rolled back, so a callback that fails leaves a
   **gap** in the numbering. A gap is invisible to a collector; a reused number is a
   corrupted trace, because event ids are derived from it.
2. **After export**, under the session lock again, and only for a callback whose
   telemetry actually survived: the cumulative usage baseline is advanced and the
   rollups applied.

Usage sits in the second phase because advancing a baseline destroys the difference
the callback represented. A lost callback that had already advanced it would release
its delivery claim, and the retry would diff the same snapshot against itself and
report zero — the tokens gone rather than delayed. Delta usage fails the mirror
image: it needs no baseline, so a retry accumulates it twice. Both are avoided by
treating accounting as a commit.

The baseline read, diff, and write-back share one critical section, so two
concurrent processes cannot diff against the same snapshot. The rollup apply is a
separate one, so a crash between them under-counts a rollup; that order is chosen
deliberately, because the reverse leaves the *next* diff to over-count.

## What a record's absence means

Correlation is best-effort by design, and every way it can fail is reported on
the span rather than guessed at:

| `otelhook.span.orphan` | Cause                                                        |
| ---------------------- | ------------------------------------------------------------ |
| `none`                 | Both edges known                                             |
| `missing-end`          | An open span; its end has not arrived (**not exported** — see below) |
| `missing-start`        | An end with no recorded start                                |
| `expired-start`        | The start aged past the retention window                     |
| `already-closed`       | A second, distinct end for a span already closed             |
| `provider-mismatch`    | The record names a different provider than the caller        |
| `state-incompatible`   | The record's `v` is not this version                         |
| `state-corrupt`        | The record could not be understood                           |
| `state-unavailable`    | State could not be consulted at all                          |

The last four never fail the export: telemetry fails open, so the observation
still leaves the process, labelled with why it is unpaired.

### An open span is recorded, not exported

A lifecycle span id is derived from `(providerId, sessionId, family, scopeKey)`,
so both edges of a scope compute the *same* span id — and OTLP has no operation
for revising an exported span. Emitting on the start edge and again on the end
edge would therefore publish two records with one identity, which collectors
variously drop, keep the older of, or display twice.

So the start edge exports nothing. It writes this record, and the end edge exports
the one completed span using the times read back out of it. Consequences worth
stating plainly:

- **A span whose end never arrives is never exported at all.** That is the
  standard OpenTelemetry outcome for a span that never ends. The alternative —
  synthesizing an end time at sweep time — reports a wrong duration instead of no
  duration, which is worse for anyone reading the data.
- The cost is counted rather than hidden. The sweep reports `expiredOpen`: records
  dropped that held a start and never got an end. A non-zero count means real
  activity went unreported, and the runtime logs it as
  `lifecycle.expired_open_spans`.
- A start the store could **not** record is not deferrable — deferring means "the
  store is holding this", and the store is exactly what failed. It is exported
  instead, flagged `otelhook.span.orphan=state-unavailable`, under a span id
  discriminated by the start's own event id so it cannot claim the id a later end
  will publish for the same scope. Dropping it would be worse than noisy: the
  export would report zero rejections, and a caller keying its commit decision on
  rejections would mark the callback handled forever.
- Once a scope's span has been published, the record remembers that
  (`exported`). A start that arrives *after* its own end was already exported
  completes the record — so a redelivered end still replays identical facts — but
  publishes nothing itself, because the id is already on the wire.
- A second, genuinely distinct end for a closed scope is a real observation, so it
  is exported — under a span id derived with an extra discriminator, never
  colliding with the first.

## Migration

There is no migration script, and there is deliberately not going to be one.

**On read**, a record whose `v` does not match `SPAN_RECORD_VERSION` is deleted
and classified `state-incompatible`. Interpreting an unknown layout is exactly
the kind of silent mis-attribution this library refuses to do, and the cost of
refusing is bounded: at most one lifecycle edge per open scope is exported as an
orphan, once, immediately after an upgrade.

**On key-space changes**, records under the old key simply become unreachable.
They are not read, not matched, and not counted; the janitor's age sweep (or
`pruneStale`) removes them within the retention window. Version 2 moved span
records from `lifecycle:span:<sessionId>:<scope>:<scopeKey>` to
`lifecycle:span:<sessionId>:<providerId>:<scope>:<scopeKey>`, so every span
record written before cross-process correlation is orphaned this way.

**To skip the transition entirely**, delete `<stateRootDir>` while no hook is
running. Nothing in it is a source of truth: state is a cache of facts a
previous process observed, and losing it costs at most the pairing of spans
currently in flight.

## What is never persisted

Prompt, response, reasoning, tool, and error content. Content facts are
described, not embedded ([ADR 0005](adr/0005-central-privacy-service.md)), and
the state schema's flat-primitive restriction is a containment boundary that
holds even if a future field forgot to be careful. Header values, credentials,
and raw filesystem paths are equally absent: workspace identity is a salted
handle before it ever reaches an event, let alone a record.
