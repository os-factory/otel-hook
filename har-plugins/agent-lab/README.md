# Inner HAR plugin: agent live lab

Local-only plugin for this repository. Do not publish it. HAR's own rule is:
custom check in one repo first; a published plugin when a second repo wants the
same install.

The plugin is **provider-agnostic**. Each host (Claude Code, Codex, later
Gemini) is a driver + scenario, not a separate plugin.

Install into a harnessed checkout:

```bash
har env add-plugin ./har-plugins/agent-lab --skip-ci
```

Run:

```bash
npm run lab:claude
npm run lab:codex
npm run lab:concurrency   # session context: many repos, slots, agents (needs har)
node har-plugins/agent-lab/scripts/run-lab.mjs --provider claude-code
node har-plugins/agent-lab/scripts/run-lab.mjs --provider codex
```

Each run also writes its OTLP capture (`<labRoot>/otlp-capture/`, via
`scripts/e2e-proof/otlp-receiver.mjs`) and reports the e2e proof evidence check
for it (`scripts/e2e-proof/check-evidence.mjs`, informational). Keep the lab
directory with `AGENT_LAB_KEEP=1` to read `evidence.md`. See
`docs/e2e-proof.md`.

See `.har/stages/AGENT-LAB.md` (after add-plugin) or the copy under
`har-plugins/agent-lab/.har/stages/AGENT-LAB.md`.
