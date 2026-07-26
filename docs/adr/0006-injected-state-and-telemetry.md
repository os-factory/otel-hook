# ADR 0006: State, telemetry, clock, ids, and logging are injected

- Status: accepted
- Date: 2026-07-25
- Milestone: M1 (core contract)

## Context

A hook process lives for milliseconds, but the facts it needs span a session:
what the previous cumulative token count was, and which sequence number comes
next. That demands state. It does not demand a daemon — and a background process
would be a much larger operational commitment than telemetry warrants.

Meanwhile, the pieces that make tests flaky are exactly the ambient ones: the
wall clock, random ids, the network, and the filesystem.

## Decision

1. Five narrow ports, all injected: `StateStore`, `TelemetrySink`, `Clock`,
   `IdGenerator`, `Logger`, plus the `PrivacyService`. `createOtelHook` takes
   them as dependencies; nothing is constructed implicitly except safe defaults
   (system clock, deterministic ids, null logger, privacy from config).
2. `StateStore` is deliberately minimal — `read`, `write`, `delete`, `keys` —
   nothing a file or a KV row cannot provide. Stored values are a validated
   union (`usage-cumulative`, `sequence`, `attributes`), so state stays
   inspectable and cannot become a second payload channel.
3. `TelemetrySink` receives canonical events only, never provider payloads, so an
   exporter cannot become an unaudited disclosure path.
4. `IdGenerator` takes **structured seeds**. The default implementation is a pure
   function of its seed, so replaying the same input produces the same ids and
   deduplication becomes the collector's job instead of requiring exactly-once
   delivery from a hook. A random generator is available for cases with no
   stable seed and is documented as not replay-safe.
5. `Clock` supplies both wall-clock and monotonic readings, so durations stay
   coherent when the wall clock jumps.
6. **No daemon.** Cumulative-to-delta conversion is done by reading a baseline
   from the state store, diffing, and writing the new baseline. A decreasing
   series is reported as a reset rather than a negative delta.
7. Every port failure is contained and reported. In particular, when a usage
   baseline cannot be read, the observation is **skipped** rather than emitted as
   a full snapshot, because emitting it would double-count.

## Consequences

- The whole pipeline is testable without a network, a filesystem, or real time.
  `@osfactory/otel-hook/testing` ships in-memory doubles with fault injection.
- Provider agents test against the same doubles the core is tested with, so a
  provider suite is reproducible on any machine.
- Hosts choose durability. An in-memory store means cumulative deltas restart
  per process; a file or KV store makes them span a session. The trade is
  explicit rather than assumed.
- Usage accounting is only as good as the state store. That is visible in
  diagnostics (`state-store-failure`) instead of being papered over.
- So is cross-process span pairing. The telemetry layer declares what it needs
  (`SpanCorrelation`, plain data) and the lifecycle layer resolves it from the
  store, so the sink never reaches into state itself. A host with no durable
  store still exports every span, each labelled with why it is unpaired
  (`otelhook.span.orphan`). Layout and retention: `docs/state-retention.md`.

## Alternatives considered

- **A background daemon holding session state.** Rejected: out of scope, and it
  turns a library into a service to install, supervise, and secure.
- **Deriving state from provider transcript files.** Rejected: it requires
  scanning arbitrary directories, which ADR 0003 forbids for good reason.
- **Random ids everywhere.** Rejected: hooks can be delivered more than once, and
  random ids turn every duplicate delivery into duplicate telemetry.
- **Clamping negative deltas to zero.** Rejected: a decreasing cumulative series
  means something real happened (a restart, a replay); naming it `resetDetected`
  keeps that visible.
