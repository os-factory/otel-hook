# Agent ${AGENT_ID} — Development Environment

> [`AGENTS.md`](../AGENTS.md) · [`.har/README.md`](./README.md) · [`stages.json`](./stages.json)

## Environment

| | |
|--|--|
| **Agent ID** | ${AGENT_ID} |
| **Work dir** | Fresh session worktree per launch — see the launch output or `.har/slots/agent-${AGENT_ID}.json` |
| **Stack** | Node ≥ 20, npm, TypeScript library + `otel-hook` CLI |
| **Infra** | None. No Docker, database, or HTTP server. |

**Never edit the main checkout** — launch FIRST, then make ALL file edits under the work dir from the launch output. An occupied slot always blocks a new launch — run `har env teardown <id>` (or `complete <id>`) first, then launch again.

```bash
./.har/agent-cli.sh ${AGENT_ID} status
```

## Readiness

This repository is agent-usable when:

1. **Infra ready** — nothing to start (`HARNESS_INFRA_SERVICES` is empty).
2. **Slot data ready** — `npm ci` in the worktree (launch). No per-slot database.
3. **Process ready** — not applicable; there is no long-running app.
4. **Agent usable** — `dist/cli.js` exists after `build`, `otel-hook --version` works, and `providers --json` lists adapters. That is the `readiness` stage.

No credentials, tenants, or sample users. Fixtures are synthetic and provenance-documented; never copy real transcripts.

## Definition of done

- [ ] Full verification returns `"status": "pass"` (`har env verify ${AGENT_ID} --full`, MCP `har_run_verification` with `full: true`, or `./.har/verify.sh ${AGENT_ID} --full`)
- [ ] That run is this repo's `npm run check` plus a CLI smoke: typecheck, lint, build, tests, fixture provenance, `dist/cli.js --version` / `providers --json`
- [ ] New behavior has automated tests; provider work includes fixtures, privacy assertions, and CLI E2E where applicable
- [ ] Changes committed **in the session worktree** with a Conventional Commit message (PR title becomes the release commit)
- [ ] Present session handoff (summary, branch — no preview URL) and **wait for user** before `complete`, push, or PR
- [ ] On user approval of the default: push + open PR (when `gh`/GitHub MCP available), then `har env complete ${AGENT_ID}`

### Session handoff

After full verify and commit, stop and propose next steps. Never autonomously run
`complete`, `teardown`, `git push`, or open a PR unless the user asked for a PR.
**Default recommendation:** when `gh` or GitHub MCP is available, complete the slot
**and** open a PR. Offer complete-only or something else as alternatives.

Quick loop: MCP `har_run_verification`, `har env verify ${AGENT_ID}`, or `./.har/verify.sh ${AGENT_ID}`

## Project commands

Use toolchain paths from `.env.agent.${AGENT_ID}` (`NPM_BIN`, `NODE_BIN`). Prefer
HAR stages over running these ad hoc.

```bash
${NPM_BIN:-npm} ci
${NPM_BIN:-npm} run typecheck
${NPM_BIN:-npm} run lint
${NPM_BIN:-npm} run build
${NPM_BIN:-npm} run fixtures:validate
${NPM_BIN:-npm} test                 # unit, e2e, parity, packaging
${NPM_BIN:-npm} run check            # typecheck && lint && build && test && fixtures:validate
${NODE_BIN:-node} dist/cli.js --version
${NODE_BIN:-node} dist/cli.js providers --json
```

## Do not

- Import HAR code or encode HAR slot concepts in the public model (`AGENTS.md`)
- Copy personal transcripts, credentials, home paths, or private prompts into fixtures
- Work around a failing harness command with ad-hoc setup — fix the harness or report the failure
- Edit `.env.agent.${AGENT_ID}` by hand
- Edit the main checkout — all edits go under the session work dir
- Change shared public contracts or the provider registry unless the task says so
