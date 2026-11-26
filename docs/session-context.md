# Session context

A harness that runs coding agents often knows things about a session that the
agent's own process does not: which unit of work it is on, which attempt, which
checkout. A session can also move from one to another while its process, and
so its environment and its OTLP Resource, stay the same. Session context lets
the harness tell otel-hook, so that every record the session produces from then
on says so.

otel-hook is generic here. It knows nothing about work units or attempts. It
reads an attribute map from a file the harness writes, and puts it on records.

## Turning it on

Set the directory in the configuration file:

```json
{ "sessionContext": { "dir": "/home/dev/.har/sessions" } }
```

or on the hook command, where it overrides the file:

```bash
otel-hook run --provider claude-code --session-context-dir /home/dev/.har/sessions
```

The path must be absolute. There is deliberately **no environment variable**:
Claude Code strips `OTEL_*` variables from the hook processes it starts, so a
variable would silently do nothing there. Without `sessionContext.dir` nothing is
read.

`otel-hook doctor` reports the `session-context` check (off, or the file layout
it reads), and its configuration snapshot says `session_context.enabled`, never
the path.

## Layout

```text
<dir>/<agent-tool>/<session-id>.json
```

One file per agent session. `<session-id>` is the provider's own session id (the
one otel-hook exports as `otelhook.session.id`). `<agent-tool>` comes from the
detected provider:

| otel-hook provider id | `<agent-tool>` directory |
|-----------------------|--------------------------|
| `claude-code`         | `claude_code`            |
| `codex`               | `codex`                  |
| `cursor`              | `cursor`                 |
| `gemini-cli`          | `gemini_cli`             |
| `antigravity`         | `antigravity`            |

The first three are the names HAR writes. The table is
`SESSION_CONTEXT_AGENT_TOOLS`. A provider not in it has no session context.

A session id that cannot be a file name (separators, `..`, a leading dot, more
than 200 characters) is never looked up.

## File format (version 1)

```json
{
  "version": 1,
  "agentTool": "claude_code",
  "sessionId": "8f0c…",
  "segments": [
    {
      "from": "2026-11-25T10:02:11.000Z",
      "to": null,
      "reason": "launch",
      "attributes": {
        "factory.work_unit.id": "416",
        "factory.attempt.id": "2e622700-…",
        "factory.slot.id": "1",
        "vcs.ref.head.name": "next-77b6-har-agent-1-w9jz"
      }
    }
  ]
}
```

- `version` must be `1`. Any other value and the whole file is ignored.
- `from` and `to` are ISO-8601 instants with a zone (`Z` or `±hh:mm`). `to` is
  `null` while the segment is open.
- `reason` is for the writer and for people; otel-hook does not read it.
- `agentTool` and `sessionId` are optional. When present, they must match the
  directory and file name the file was read from, or the file is ignored.
- Unknown extra fields are tolerated.

The writer should replace the file atomically (write, then rename) and keep it
small; files over 256 KiB are ignored.

## What happens on each hook event

1. The core (never a provider adapter, ADR 0003) reads the one file for the
   invocation's session. A subagent's events belong to their parent session, so
   they use the parent's file. One bounded read, 100 ms at most; never a scan.
2. For each canonical event, it picks the segment in force at the event's time:
   `from <= t` and (`to` is `null` or `t < to`). Should segments overlap, the
   one that started last wins.
3. Its attributes are put on **every record** the event produces: spans, log
   records, and metric points.

Attributes are screened first. A key is dropped, on its own, when it is:

- `factory.local` or under `factory.local.*` (local-only in the Factory Commits
  telemetry profile);
- one otel-hook sets itself: `session.id`, anything under `otelhook.*`,
  `trace_id`, `span_id`, `parent_span_id`, `gen_ai.conversation.id`;
- `service.name` / `service.namespace`, malformed, or secret-like (the same key
  rules as custom resource attributes);
- not a string, a finite number, or a boolean; or a string over 2048 characters.

At most 64 attributes per segment are kept.

## Precedence

Session context overrides the same keys from the Resource. A session that moved
from attempt A to attempt B still has A in its environment; its records say B.

- **Records.** The context is layered over the Resource's passthrough
  namespaces (`har.*`, `factory.*`, `vcs.*`) on every span and log record, and
  is on every metric point. otel-hook's own per-event attributes stay on top:
  `session.id`, `otelhook.*`, `gen_ai.*`, the hex trace ids, and an event's
  resolved worktree target (ADR 0008), which still wins for the keys it sets,
  such as `vcs.ref.head.name`. Touching a file in a worktree does not change
  the work identity; the context does.
- **Resource.** For each export, a key the Resource already carries and the
  context sets is rewritten to the context's value, on traces, logs and metrics,
  for every destination, and in the retry spool. The context adds no new key to
  the Resource: the Resource describes the producer, and the context's keys are
  on every record already. If the events of one export disagree on a key (a
  segment boundary inside one callback), that key is left as it was on the
  Resource; each record still carries its own value.

Both halves are needed: some backends index only record attributes, others read
the Resource, and neither should see the stale value.

## Fail-open

No file, an unreadable or oversized one, invalid JSON, a wrong `version`, a
file naming another session, or no segment in force: nothing is added, and the
hook goes on as if session context were off. The hook never fails because of
it, and an event with no context exports exactly what it exported before.

otel-hook does not know whether the work a segment describes has ended. A
writer that ends that work must close the segment (set `to`); a segment left
open stays in force.

## Many sessions at once

Each hook process reads the one file of its own event's session, and each export
batch is built from one invocation's events, so sessions never share a stamp or a
Resource: two repositories on the same slot number, two agents in one slot, a
Claude Code and a Codex session that happen to share an id (separate agent-tool
directories), and batches replayed from a spool (each keeps the Resource it was
recorded with). The agent lab's concurrency scenarios check all of these on the
wire with real agents and HAR as the writer (`.har/stages/AGENT-LAB.md`).

What a writer should know:

- **Write atomically** (temp file + rename). A reader that opens a torn or
  momentarily missing file stamps nothing for that event; it never stamps from a
  half-written one.
- **A boundary is as precise as the write.** A writer picks an instant, then
  writes the file; a hook that reads in between still sees the previous segment
  open, so an event in that window (a few milliseconds) carries the previous
  segment. A writer that needs exact boundaries can set `from`/`to` slightly
  ahead of the write.
- **Read-modify-write is the writer's to serialize.** otel-hook only reads; two
  writer processes updating one session's file at once can lose a segment unless
  the writer locks.
- **Records before the first segment carry none.** A session that starts before
  its harness writes the file (an agent whose first act is to launch a slot)
  exports its first events with no context.

## Library

`createDirectorySessionContextReader({ dir })` is the filesystem reader the CLI
uses. A host embedding the library can pass its own `SessionContextReader` to
`createOtelHook({ sessionContext })` or `createHookRuntime({ sessionContextReader })`.
`parseSessionContextFile`, `segmentInForce` and `stampSessionContext` are the
pure pieces.
