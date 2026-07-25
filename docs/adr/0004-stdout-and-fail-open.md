# ADR 0004: stdout belongs to the host, and hooks fail open

- Status: accepted
- Date: 2026-07-25
- Milestone: M1 (core contract)

## Context

Coding agents invoke hooks as subprocesses and read stdout as protocol. Some
providers interpret stdout as JSON that can block a tool call, inject context, or
stop the agent. A telemetry library that prints anything to stdout — a log line,
a warning, a stack trace — can therefore change what the host agent does.

Similarly, a non-zero exit code from a hook can abort the host's work. Telemetry
that can break a developer's session will be uninstalled, and rightly so.

## Decision

1. **Nothing is written to stdout unless the provider's protocol requires it.**
   The default response is `SILENT_HOOK_RESPONSE`: no stdout, exit code 0. A
   provider that needs a structured response returns one via
   `hookResponse(...)`, marked `contract: "provider-protocol"`.
2. **`exitCode` is typed as the literal `0`.** The type system cannot express a
   failing hook, so no future change can introduce one by accident.
3. **All diagnostics go to stderr.** `createStderrLogger` writes only to stderr;
   log fields are attribute values, so a log line cannot serialize a payload.
4. **`ingest` never throws and never rejects.** Its result type has
   `ok: true` as a literal. Detection failures, adapter throws, state store
   failures, sink rejections, and unanticipated exceptions all become
   `diagnostics` entries. The caller inspects `attribution` to learn what
   happened.
5. **Two postures, named explicitly.** Each error code in `ERROR_TAXONOMY`
   declares one:
   - `fail-open` — telemetry may be incomplete; the host proceeds normally.
   - `fail-closed-attribution` — the observation is not attributed and its
     events are dropped rather than labelled with a guess.
6. `flush` and `shutdown` are also non-throwing, and `shutdown` is idempotent.

## Consequences

- A completely broken telemetry configuration degrades to "no telemetry", never
  to "broken agent". Tests cover a sink that throws from every method.
- Operators need stderr or the returned diagnostics to see failures; silence on
  stdout is intentional and not evidence of success.
- Because the exit code is a literal type, a provider adapter cannot express
  "block this tool call" through the telemetry path. If a provider protocol
  needs that, it is an explicit `stdout` payload, visible in review.

## Alternatives considered

- **Logging warnings to stdout when no protocol response is expected.**
  Rejected: "no response expected" is a per-provider assumption, and being wrong
  once means corrupting a hook protocol.
- **Exiting non-zero on export failure.** Rejected: it converts a collector
  outage into an agent outage.
- **Throwing from `ingest` and letting callers catch.** Rejected: hooks are often
  invoked from thin wrappers where an unhandled rejection kills the process.
