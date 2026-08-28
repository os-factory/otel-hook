# Inner HAR plugin: agent live lab

Local-only plugin for this repository. Do not publish it. HAR's own rule is:
custom check in one repo first; a published plugin when a second repo wants the
same install.

The plugin is **provider-agnostic**. Each host (Claude Code, later Codex,
Gemini) is a driver + scenario, not a separate plugin.

Install into a harnessed checkout:

```bash
har env add-plugin ./har-plugins/agent-lab --skip-ci
```

Run:

```bash
npm run lab:claude
node har-plugins/agent-lab/scripts/run-lab.mjs --provider claude-code
```

See `.har/stages/AGENT-LAB.md` (after add-plugin) or the copy under
`har-plugins/agent-lab/.har/stages/AGENT-LAB.md`.
