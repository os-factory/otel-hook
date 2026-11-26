# ADR 0009: Session context is a core step, and overrides the Resource

- Status: accepted
- Date: 2026-11-26

## Context

A harness that runs coding agents knows what a session is working on (a unit of
work, an attempt, a slot) and that this can change while the agent's process,
and so its environment and its OTLP Resource, stay the same. Records therefore
need a per-event source of these attributes that the harness can update at any
time, and that works on hooks whose environment the agent filters (Claude Code
strips `OTEL_*` variables from hook processes).

## Decision

1. The harness writes one JSON file per agent session,
   `<dir>/<agent-tool>/<session-id>.json`, holding time-bounded segments of
   attributes (`docs/session-context.md`). otel-hook reads attribute maps; it
   knows nothing about what they mean.
2. Reading it is a **core step** of the hook, next to target resolution and the
   payload enrichers: a `SessionContextReader` port, injected like the
   `WorktreeLocator` (ADR 0006), with a filesystem implementation. Adapters never
   see it (ADR 0003). The core reads the one file for the invocation's session
   (for a subagent, its parent's), bounded in size and time, never scanning.
3. Each canonical event is stamped with the attributes of the segment in force
   at its own `occurredAt`, as an optional, core-only `contextAttributes` field
   (an additive field, ADR 0002). Events stay self-describing, so every sink,
   including a host's own, sees the stamp.
4. Precedence: context overrides the same keys from the Resource, on records and
   on the Resource itself (only keys it already has) for each export of every
   signal and destination, so a backend reading either sees the same value.
   otel-hook's own per-event attributes (`session.id`, `otelhook.*`, trace ids,
   a resolved worktree target) stay above it, and `factory.local.*` is refused.
5. Configured by the config file (`sessionContext.dir`) or a flag
   (`--session-context-dir`), never an environment variable.
6. Fail-open (ADR 0004): any problem with the file means no stamp, never a
   failed hook.

## Consequences

- A harness can re-attribute a running session without restarting it, and every
  destination agrees on the attribution without a server to re-link it.
- A new context value starts new metric series, because the attributes are part
  of each data point's identity.
- otel-hook cannot tell that the work a segment describes has ended; the writer
  must close segments.

## Alternatives considered

- **Environment variables.** Rejected: filtered by some agents, and fixed for
  the life of the process.
- **Reading the file in provider adapters.** Rejected by ADR 0003.
- **Record attributes only, Resource untouched.** Rejected: a backend that reads
  the Resource would keep reporting the stale value.
