# Agent guide

## Scope

`@osfactory/otel-hook` is an independent TypeScript library and CLI. Do not
import HAR code or encode HAR slot concepts in its public model.

## Architecture

Dependency direction:

```text
CLI / installers
  -> protocol
  -> provider adapters
  -> canonical model
  -> lifecycle
  -> state and telemetry sinks
```

Raw provider payloads must not escape provider adapters. Consumer attributes
are opaque, immutable invocation metadata.

## Safety

- Hook behavior fails open so telemetry cannot block the host agent.
- Attribution fails closed: unknown or conflicting identity is never guessed.
- Prompt, response, reasoning, error, and tool content is omitted by default.
- Do not introduce module-level mutable identity, session, tracer, or workspace.
- Do not scan arbitrary transcript directories from provider adapters.

## Branch names, CI, and releases

Git **branch names do not skip CI or releases**. Match the **squash-merge PR
title** to Conventional Commits — that title becomes the commit on `main` and
is what [semantic-release](./release.config.cjs) analyzes.

| Prefix | Release |
| ------ | ------- |
| `fix:` | Patch |
| `feat:` | Minor |
| `feat!:` / `BREAKING CHANGE:` | Major |
| `chore:`, `docs:`, `test:`, `refactor:`, `ci:` | No release |

Use `ci: …` for workflow-only PRs (this change). Add `[skip ci]` to the squash
message only when you also need to skip the Release verify job.

## Verification

Before committing:

```bash
npm run check
```

Provider changes require contract fixtures, replay tests, privacy assertions,
and actual CLI-to-captured-OTLP integration coverage where applicable.

<!-- har:agent-environment:start -->
## HAR / agent environment

This repository is a TypeScript library and CLI, not a web app. The harness is
**how you get an isolated worktree with Node and `npm ci`**. There is no Docker
stack, no preview URL, and no long-running server. Launch a slot with
`har env launch <id>` or `./.har/launch.sh <id>`; never invent a parallel
install path.

If a harness command fails, fix the harness (or report the failure) — do not quietly
fall back to ad-hoc commands.

### Before making changes

1. On the **main checkout**, switch to the intended base (usually `main`) — launch
   creates a worktree from that HEAD.
2. **Launch first** — MCP `har_launch_environment` / `har env launch 1`. Use the
   returned **work dir** for ALL edits (never the main checkout).
   **Bind tracker work** when the task names a durable issue or ticket (GitHub,
   Linear, etc.): pass a short repo-scoped `--work-id` / `workUnitId` (e.g.
   `widget-123`), `--work-source` / `source`, `--work-url` / `sourceUrl`, and
   `--work-title` / `title` when known. Skip binding for ad-hoc work with no
   tracker identity.
3. Read [`.har/README.md`](.har/README.md), [`.har/stages.json`](.har/stages.json), then
   [`.har/CLAUDE.agent.md`](.har/CLAUDE.agent.md) for definition of done.
4. There is no hot-reload or managed process. Rebuild with the `build` stage
   (or `${NPM_BIN:-npm} run build` in the worktree) after changing `src/`.

**Occupied slots always block.** Run `complete` / `teardown`, then `launch`. Resume
failed/starting launches with `--resume` / `recover`. Prefer a free slot (2+) over
sharing slot 1 across unrelated chats. Check `har_get_status` / `har env status` first.
Commit early — teardown keeps the branch, not uncommitted work.

### After making changes

Prefer MCP → CLI → shell. Quick verify for the loop; **full verify before done**.

- MCP: `har_run_verification` / `full: true`; finish with `har_complete_environment`
  (propose; wait for approval) or `har_teardown_environment`
- CLI: `har env verify 1`, `har env verify 1 --full`, `complete 1`, `teardown 1`
- Shell: `./.har/verify.sh 1`, `./.har/verify.sh 1 --full`, `./.har/teardown.sh 1`

Commit in the session worktree. Run JSON stays in the main checkout `.har/runs/`.

### Definition of done

- Full verify passes (`typecheck`, `build`, `fixtures-validate`, `lint`,
  `unit-tests`, CLI `readiness` smoke); edits only in the session worktree;
  tests cover new behavior; changes committed; then **session handoff** (below).
  There is no preview URL.

### Session handoff (required)

After full verify and commit, stop. Include summary and session branch
(`.har/slots/agent-<id>.json`). Wait — never autonomously complete, teardown,
push, or open a PR unless the user asked for a PR. **Default:** when `gh`/GitHub
MCP is available, recommend **Complete + open a PR** (still needs approval).
Alternatives: **Complete only**, or **Something else**. Without PR tooling,
recommend **Complete only** and give the session branch for a manual push.

### Commit gate

Full verify records a tree hash under `.har/validations/`. With `har hooks install`,
commits must match a passing full verify. Re-verify after any edit; `git add -A`.
Do not bypass (`--no-verify`, `HAR_SKIP_GATE=1`).

### Cursor IDE

If `.cursor/rules/har-workflow.mdc` exists, the same harness workflow is injected into
every Cursor agent session automatically. Run `har env init` or `har env maintain` to
create or refresh it.
<!-- har:agent-environment:end -->

## Project-specific notes

- Work only in the ownership area named in the task. Do not change shared public
  contracts or the provider registry unless the task asks for it.
- Use synthetic, provenance-documented fixtures. Never copy personal transcripts,
  credentials, home paths, or private prompts into the repository.
- `npm run check` is the human equivalent of `har env verify <id> --full` minus
  the CLI smoke (`readiness` runs `dist/cli.js --version` and `providers --json`).
- Full verify has no preview URL and starts no Docker.

