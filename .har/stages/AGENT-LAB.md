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
