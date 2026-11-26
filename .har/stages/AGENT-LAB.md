# Agent live lab

Inner HAR plugin (not published). It runs a **host agent CLI** against a
**scripted LLM mock**, registers **otel-hook** hooks, and checks that lifecycle
events and frozen token counters show up on the OTLP wire.

Claude Code and Codex are wired. Gemini should get a driver under
`har-plugins/agent-lab/scripts/providers/` and a scenario JSON — not a
second plugin.

HAR's plugin manifest requires a non-empty `verificationStages` list, so
install adds `agent-lab` there. This repository then **removes it** from
`.har/stages.json` `verificationStages` so `har env verify` stays the
typecheck/build/test pipeline. The stage stays registered; invoke it
explicitly.

## Why a wrapping harness

Some hosts (Claude Code 2.1.x) do not put token counters on hook stdin
(`docs/claude-code-usage-contract.md`). Usage lives on the transcript; the
adapter must not read `transcript_path`. The lab wrapper attaches the mock's
last `usage` object onto the stop event so otel-hook can normalize the same
numbers the mock emitted. A bare Claude install will emit the events and omit
usage — that is the contract, not a lab failure of the adapter.

## Commands

From the repository root, with HAR already initialized (`har env init --profile cli`):

```bash
har env add-plugin ./har-plugins/agent-lab --skip-ci
```

`--skip-ci` is correct: this check needs a local host CLI and must not gate
GitHub Actions.

```bash
npm run lab:claude
npm run lab:codex
# or, after add-plugin:
./.har/stages/agent-lab.sh
./.har/stages/agent-lab.sh --provider claude-code
./.har/stages/agent-lab.sh --provider codex
```

Skip: `AGENT_LAB=0`. Keep the temp dir: `AGENT_LAB_KEEP=1`.

## What the Claude scenario asserts

- Hooks: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SessionEnd
- OTLP logs: session.start, prompt.submitted, tool.start, tool.end,
  generation.start, generation.end, session.end
- Tool span `Read`
- Frozen Stop usage on the generation span matches `scripts/scenarios/claude-read-then-ready.json`
- Synthetic secret from `widget.txt` is absent from OTLP bytes and hook dumps
- Default privacy: prompt.submitted log has no body

## What the Codex scenario asserts

- Hooks: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop
  (Codex has no modelled SessionEnd)
- OTLP logs: session.start, prompt.submitted, tool.start, tool.end, generation.end
- Tool span `Bash` (Codex hook stdin names `exec_command` as `Bash`)
- Frozen Stop usage on the generation span matches
  `scripts/scenarios/codex-read-then-ready.json` (`canonicalStopUsage`)
- Those numbers are the session-lifetime cumulative snapshot after both mock
  turns (100+180 input, 24+8 output) and match Codex's own `turn.completed`
  print totals. Live Codex 0.146 does not put counters on hook stdin; the
  wrapper attaches the mock cumulative. Fixture replay covers two-Stop
  session-lifetime deltas.
- Synthetic secret from `widget.txt` is absent from OTLP bytes and hook dumps
- Default privacy: prompt.submitted log has no body

## Isolation

The runner points `HOME`, the host config dir, the mock base URL, and a dummy
API key at a temp directory. For Claude it never uses `--bare` (that flag skips
hooks). Codex uses an isolated `CODEX_HOME`, `--dangerously-bypass-hook-trust`,
and a custom `wire_api = "responses"` provider. Do not copy personal
transcripts or credentials into this plugin.

## E2E proof capture and evidence (issue #56)

The lab's collector is the e2e proof receiver
(`scripts/e2e-proof/otlp-receiver.mjs`): every OTLP request is written to
`<labRoot>/otlp-capture/` (raw body plus decoded JSON, empty bodies recorded).
The hook command carries a synthetic launcher profile (`--resource-attr
session.id=agent-lab-<provider>-session`, `factory.work_unit.id=agent-lab`,
`vcs.*`), and the report's `evidence` field (plus `<labRoot>/evidence.md`) is
the output of `scripts/e2e-proof/check-evidence.mjs` for the same run. It is
informational and does not change the lab's pass/fail. See
`docs/e2e-proof.md` for what each check means and for what was observed when
it was added (Claude Code passes every mechanical row; Codex exports no
`session` span because it has no session-end hook).

The profile is on the hook command rather than in the agent's environment
because Claude Code 2.1.x was observed not to pass `OTEL_*` variables through
to hook processes.

## Concurrency scenarios (session context)

```bash
npm run lab:concurrency
node har-plugins/agent-lab/scripts/run-lab.mjs --scenario concurrency [--only s1,s4]
./.har/stages/agent-lab.sh --scenario concurrency
```

Checks `sessionContext.dir` (`docs/session-context.md`) with many repositories,
slots and agents at once. Needs `claude`, `codex` and `har` (HAR 2.x, the
writer of the context files) on PATH; `AGENT_LAB_HAR` points at another `har`
(a command, or a `.js` entry run with node). Skips when one is missing.

- **HAR is the writer.** Every `har` command runs with a sandbox `HOME` inside
  the lab directory and telemetry off (no Mission Control is contacted), on
  throwaway repositories with a `cli` profile harness. The lab gives `har` the
  session env var an agent gives every command it runs
  (`CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`), which is all HAR reads to find
  the session, so `har env launch` / `work-bind` write the same files as when an
  agent's shell tool runs them. Scenario 5 needs 200 rewrites in a second, so it
  uses a writer that mirrors HAR's (temp file + rename) plus a deliberately torn
  one.
- **Real agents, mocked models.** Claude Code (`--session-id` preset) and Codex
  run against their scripted mocks; Codex hooks are registered at user level
  (`CODEX_HOME/hooks.json`) because Codex does not load project hooks from a
  linked worktree. The wrapper's `--gate-dir` holds a hook (`hold.<Event>`)
  until the lab has run a `har` command, to bind a Codex session as it starts or
  move a session between two tool hooks.
- **Assertions on the wire.** One collector per scenario. Every span, log record
  and metric point is mapped to its session (`otelhook.provider.id` +
  `otelhook.session.id` / `session.id`) and compared with that session's context
  file: attempt and every other context key from one of its own segments; a log
  record carries the segment in force at its time; a span the segment at its
  start or end; nothing after a segment's `to` keeps its attempt; the Resource
  of a batch (stale `factory.attempt.id` / `vcs.*` put there on purpose) is
  either the stale value or exactly what every record of the batch says.
  A record within 100 ms after a boundary that still carries the previous
  segment is counted as `boundarySkew` (the writer's own write latency), not
  failed.

| Id | Scenario |
| -- | -------- |
| s1 | Two repositories, both slot 1, one Claude Code session each, in parallel |
| s2 | Claude Code and Codex in one slot; Codex joins with `har env work-bind` |
| s3 | Claude Code in slot 1, Codex in slot 2 of one repository, in parallel |
| s4 | One Claude Code session moves slot 1 -> slot 2 between PreToolUse and PostToolUse |
| s5 | The context file rewritten 200 times while 50 hook processes read it (atomic and torn writers) |
| s6 | One session id under `claude_code` and `codex`; two `har` processes launching one session at once |
| s7 | 20 concurrent hook processes over 4 sessions (start and end of one tool at the same instant): latency with and without context, with one destination down, then concurrent drains: every record once, Resource intact |

Scenario 8 (exporter isolation) is the Resource check above, applied to every
scenario's live wire and to the batches replayed from the spool in s7.
