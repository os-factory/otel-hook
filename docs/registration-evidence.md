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

Sources were read on 2026-07-26, and the Gemini CLI row was re-verified against
upstream source on 2026-07-29.

## Verified

| Provider      | Global                       | Project                      | Document shape                                                                          | Source                                                                                             |
| ------------- | ---------------------------- | ---------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `claude-code` | `~/.claude/settings.json`    | `.claude/settings.json`      | `hooks.<Event>[] = { matcher?, hooks: [{ type: "command", command, timeout? }] }`          | [code.claude.com/docs/en/hooks][cc]; cross-checked against `o11y-dev/opentelemetry-hooks` v0.14.0    |
| `codex`       | `~/.codex/hooks.json`        | `.codex/hooks.json`          | same nested shape                                                                         | [learn.chatgpt.com/docs/hooks][cx] (`developers.openai.com/codex/hooks` redirects here); same cross-check |
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

`--event` overrides the default set in either direction.

The Gemini exclusions earn more than they usually would: `AfterModel` fires once
per streaming chunk, so a Gemini session already spawns this hook far more often
than the others do. Every event that emits nothing is worth not registering.

## Blocked

### `cursor` — payload contract, not configuration shape

Unusually, the *configuration* half is verified: `~/.cursor/hooks.json` and
`.cursor/hooks.json`, shaped `{ "version": 1, "hooks": { "<event>": [{ "command": … }] } }`
([cursor.com/docs/agent/hooks][cu], and `o11y-dev/opentelemetry-hooks` v0.14.0
writes exactly that). The blocker is the *payload* half, which would make a
successful registration worse than none: the hook would fire on every event and
the adapter would drop all of it.

`src/providers/cursor/payload.ts` states in its own header that every shape in
it is invented for this repository. Against the published event list, two
concrete mismatches:

1. **Tool event names.** The adapter models `beforeToolUse`, `afterToolUse`, and
   `toolUseFailed`. Cursor documents `preToolUse`, `postToolUse`, and
   `postToolUseFailure`. (The other fifteen names do coincide.)
2. **Envelope.** The adapter's current-shape envelope is camelCase
   (`hookEventName`, `conversationId`, `timestampMillis`), and its snake_case
   fallback resolves only snake_case *event names* (`before_tool_use`, …). A real
   payload keyed `hook_event_name: "preToolUse"` matches neither path, so
   `normalizeCursorPayload` returns `undefined` and the event is refused.

**To unblock:** capture real Cursor hook payloads into `fixtures/parity/cursor`
with provenance, re-derive `src/providers/cursor/payload.ts` from them, and
confirm the adapter parses each captured event. The planner can then reuse the
already-verified `hooks.json` shape — no new configuration evidence is needed.
Tracked as known limitation 7 in the README.

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
