# Registration evidence

`otel-hook setup` writes into configuration files this project does not own. A
wrong guess there is not a failed install — it is a silently broken agent, or a
developer's `settings.json` rewritten into a shape their tool no longer reads.

So a planner ships only when this repository can point at the source that
established both halves of the contract:

1. **Where** the document lives (global and project scope), and
2. **What** shape it has, including which event names are registrable.

A provider that fails either test gets an explicit `unsupported` diagnostic
naming the blocker, not a plausible-looking file. This page is the record; the
machine-readable version is `PROVIDER_REGISTRATION_SUPPORT` in
`src/install/support.ts`, and `tests/install/registration.test.ts` asserts that
every unsupported entry carries a blocker.

Sources were read on 2026-07-26. The Gemini CLI row was re-verified against
upstream source on 2026-07-29, and the Cursor row on 2026-07-29.

## Verified

| Provider      | Global                       | Project                      | Document shape                                                                          | Source                                                                                             |
| ------------- | ---------------------------- | ---------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `claude-code` | `~/.claude/settings.json`    | `.claude/settings.json`      | `hooks.<Event>[] = { matcher?, hooks: [{ type: "command", command, timeout? }] }`          | [code.claude.com/docs/en/hooks][cc]; cross-checked against `o11y-dev/opentelemetry-hooks` v0.14.0    |
| `codex`       | `~/.codex/hooks.json`        | `.codex/hooks.json`          | same nested shape                                                                         | [learn.chatgpt.com/docs/hooks][cx] (`developers.openai.com/codex/hooks` redirects here); same cross-check |
| `cursor`      | `~/.cursor/hooks.json`       | `.cursor/hooks.json`         | `{ version: 1, hooks: { <event>: [{ command, type?, timeout?, matcher? }] } }` (flat)      | [cursor.com/docs/agent/hooks][cu]; same cross-check                                                  |
| `gemini-cli`  | `~/.gemini/settings.json`    | `.gemini/settings.json`      | same nested shape, plus `name` on each handler and `sequential` on each group             | [geminicli.com/docs/hooks/reference][gm]; cross-checked against `google-gemini/gemini-cli@3499c84` and `o11y-dev/opentelemetry-hooks` v0.14.0 `setup.sh` (`setup_gemini`) |
| `antigravity` | *not verified — see below*   | *not verified — see below*   | `hooks.<Event>[] = { command, matcher? }` (flat), recorded by this repository's adapter    | `src/providers/antigravity/payload.ts`                                                               |

### `timeout` is not one unit across these vocabularies

`timeout` is in **seconds** for Claude Code, the Codex CLI, and Antigravity, and
in **milliseconds** for the Gemini CLI — its reference states "Execution timeout
in milliseconds (default: 60000)", and `hookRunner` passes the value straight to
`setTimeout`. `--timeout-seconds 30` written verbatim into a Gemini
`settings.json` would kill the hook after 30 milliseconds, so
`mergeGeminiHookRegistration` takes seconds like every other planner and converts
at the boundary. `tests/install/registration.test.ts` pins both spellings against
one flag value.

### Two more things specific to the Gemini CLI

- **`"*"` is a real matcher, and the one this planner writes.**
  `HookPlanner.matchesContext` special-cases `""` and `"*"` as match-everything
  *before* compiling a matcher as a regex — which matters, because `new
  RegExp("*")` throws. The other planners omit the key instead; both spellings
  mean the same thing and `normalizeMatcher` compares them equal.
- **Not every key under `hooks` is an event.** `HOOKS_CONFIG_FIELDS` is
  `['enabled', 'disabled', 'notifications']`, so `hooks.enabled: true` sits beside
  the event arrays. Removal therefore names the event vocabulary explicitly rather
  than scanning the object's keys: a scan reads `hooks.enabled` as a malformed
  event list, reports a conflict, and abandons the whole uninstall.

Cursor also documents enterprise-managed locations — `/etc/cursor/hooks.json`,
`/Library/Application Support/Cursor/hooks.json`,
`C:\ProgramData\Cursor\hooks.json` — and a cloud-distributed team layer. None is
offered as a scope: they are MDM-owned, live outside any home directory, and a
tool that writes there is editing fleet policy, not a developer's setup.

## Writing into a file this project does not own

Three safety properties, each protecting something a failed install cannot undo:

- **The managed marker is validated before any document is opened.** Ownership is
  recognized by substring match against a hook's command, and `"".includes(x)` is
  true for every command — so an empty `--managed-marker` would make `uninstall`
  delete every hook the developer had configured, from every tool. Markers are
  refused when empty, under 3 characters, over 200, untrimmed, or free of any
  letter or digit, and the refusal covers every target in the run rather than
  arriving after the first file was already rewritten.
- **An atomic replace preserves the file's mode.** `rename` swaps the inode, so
  the mode travels with the temp file and an atomic write silently re-permissions
  the destination unless the original mode is carried across. An existing document
  keeps exactly the mode it had; a document this tool creates gets `0600` rather
  than whatever the umask allowed, because a hook command line can carry an
  `--endpoint` token and these files live in home directories that are often
  group-readable. The temp file is owner-only for its whole life.
- **The config-file lock carries an ownership token.** A holder slow enough to be
  declared stale would otherwise have its lock reclaimed by a waiter and then
  unlink the *successor's* lock on its way out, leaving the file unprotected while
  the successor still believed it held it. Release and stale-reclaim are both
  compare-by-token, so a lock can only be removed by the process that owns it.

Asserted in `tests/install/document-safety.test.ts`.

Two decisions follow from the sources rather than from convenience:

- **No `matcher` key is written by default.** Both references define an omitted
  matcher as "match every occurrence", and Claude Code documents
  `UserPromptSubmit` and `Stop` as taking no matcher at all. Omitting it is the
  one spelling valid for every event this tool registers.
- **Codex's `config.toml` is never edited.** The reference states hooks are
  *enabled by default* and that `[features] hooks = false` turns them off, so
  there is nothing to enable. `diagnose` reads that flag and reports an explicit
  opt-out; it never writes TOML.

### Events deliberately not registered

Registration is limited to events the adapter turns into telemetry. A hook that
fires and emits nothing is a process spawn per occurrence for no data.

| Provider      | Skipped             | Why                                                                                    |
| ------------- | ------------------- | -------------------------------------------------------------------------------------- |
| `claude-code` | `PermissionRequest` | reported on the paired `tool.end`; nothing distinct to telemeter                        |
| `claude-code` | `PreCompact`        | compaction is reported once it completes, at `PostCompact`                              |
| `codex`       | `PermissionRequest` | as above                                                                                |
| `codex`       | `SessionEnd`        | documented by Codex, but **not modelled by this adapter** — the payload would be rejected |
| `gemini-cli`  | `AfterAgent`        | marks turn completion; the canonical model has no event for it distinct from `generation.end` |
| `gemini-cli`  | `BeforeToolSelection` | carries tool-choice configuration only                                                 |
| `gemini-cli`  | `Notification`      | observability-only in this protocol; no canonical event type corresponds                 |
| `cursor`      | `afterAgentResponse` | `stop` reports the same generation *and* the same token snapshot; both would double-count |
| `cursor`      | `beforeShellExecution`, `afterShellExecution`, `beforeMCPExecution`, `afterMCPExecution` | one call fires the generic pair *and* the dedicated pair — see below                     |
| `cursor`      | `beforeReadFile`    | no completion callback exists, so a `tool.start` here would never close                  |
| `cursor`      | `subagentStart`, `subagentStop` | `subagentStop` carries no subagent id, so the pair cannot be correlated       |
| `cursor`      | `afterAgentThought` | a reasoning notification with no canonical event type; its text is never exported         |
| `cursor`      | `beforeTabFileRead`, `afterTabFileEdit`, `workspaceOpen` | not agent-session hooks; `workspaceOpen` carries no `conversation_id` at all |

`--event` overrides the default set in either direction.

The Gemini exclusions earn more than they usually would: `AfterModel` fires once
per streaming chunk, so a Gemini session already spawns this hook far more often
than the others do. Every event that emits nothing is worth not registering.

### Why Cursor's shell and MCP callbacks are not registered

This one is worth stating separately because it comes from a capture rather than
from a reference. In the Cursor CLI capture below, a single `printenv` invocation
fired **four** hooks — `fired.log` records `preToolUse`,
`beforeShellExecution`, `afterShellExecution`, `postToolUse` in that order, with
`afterShellExecution` and `postToolUse` reporting the identical `duration` of
169.812. Registering both pairs reports one tool call twice.

The generic pair wins the tie: `preToolUse`/`postToolUse` carry a `tool_use_id`
that correlates the two edges, and `postToolUseFailure` gives the call an error
channel. `afterShellExecution` and `afterMCPExecution` carry neither an id nor
any exit status. The adapter still *models* all four, so `--event` can opt in.

## The Cursor payload half, and how it was settled

Cursor was blocked for the reverse of the usual reason: its *configuration* was
verified before its *payloads* were, so a registration would have succeeded,
fired, and had every event dropped by an adapter targeting an invented envelope.

That is resolved, from two sources rather than one:

1. **The published reference** — [cursor.com/docs/agent/hooks][cu] and
   `cursor.com/docs/hooks.md` (two URLs serving the same document, read
   2026-07-29). Source of the event list, the shared envelope, each event's stdin
   fields and stdout response, the `hooks.json` schema, exit-code semantics, and
   the statement that `duration`/`duration_ms` are milliseconds.
2. **Real redacted captures** — `colinsurprenant/director`, under
   `hack/canary/cursor-cli/findings/`: two Cursor CLI runs (`2026.07.17-3e2a980`,
   2026-07-21 and 2026-07-22) and two Cursor IDE runs (`3.12.17`, 2026-07-21),
   each registering the full agent-hook set and recording the exact key list of
   all 54 payload files it saved.

The captures are what settled four things the reference does not state:

- **There is no timestamp field.** Not in the reference, and not in any captured
  payload's key list — so `occurredAt` comes from the injected clock.
- **Token counters exist.** `afterAgentResponse` and `stop` carry
  `input_tokens`, `output_tokens`, `cache_read_tokens`, and
  `cache_write_tokens`, none of which the reference mentions.
- **Event delivery is surface-dependent.** `stop` and `afterAgentResponse` fired
  in the IDE runs and in neither CLI run; `sessionEnd` fired in both CLI runs and
  in neither IDE run — from the same `hooks.json`.
- **`duration` really is milliseconds.** A captured `printenv` reports 169.812,
  which is 170ms, not 170s. The pinned Python reference disagrees; that is
  `DIVERGENCE-008`.

The redacted fixtures under `fixtures/parity/cursor/` restate the captured shapes
with synthetic values, and each provenance sidecar names this capture set. No
real path, address, transcript, prompt, or credential is copied into this
repository. `src/providers/cursor/payload.ts` carries the field-level detail, and
`tests/parity/cursor.parity.test.ts` asserts the shipped adapter validates the
fixture bytes directly — the assertion that retired `ADAPTER-NOTE-005`.

What the captures do **not** settle is recorded as such: whether Cursor's
`input_tokens` already includes `cache_read_tokens` is undocumented, so the
adapter reads it as inclusive (the reading all three captured samples are
consistent with) and drops the breakdown rather than reinterpret a payload that
contradicts it. `cache_write_tokens` is not mapped at all. See
`CURSOR_USAGE_INCLUSIVITY_NOTE` and known limitation 7 in the README.

## Blocked

### `antigravity` — planner verified, location not

The hook-file *shape* is recorded by the adapter and the planner is supported,
but no path has been verified. `o11y-dev/opentelemetry-hooks` v0.14.0 lists
Antigravity as a "manual hook command, runner-defined" integration and writes no
file for it, and this repository has no other source.

`setup --provider antigravity` therefore refuses until given
`--settings-file <path>`, and a bare `diagnose` does not sweep it — there is
nowhere to look.

**To unblock:** a published Antigravity hook-file path, or a documented
convention for the runner in use.

[cc]: https://code.claude.com/docs/en/hooks
[cx]: https://learn.chatgpt.com/docs/hooks
[cu]: https://cursor.com/docs/agent/hooks
[gm]: https://geminicli.com/docs/hooks/reference/
