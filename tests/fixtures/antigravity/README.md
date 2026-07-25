# Antigravity fixtures — provenance

Every JSON file in this directory is **synthetic**: hand-written for this
package, not copied or derived from any real Google Antigravity session,
transcript, or credential.

Fields treated as verified come from the integration task that scoped this
provider: the five hook names (`PreInvocation`, `PostInvocation`,
`PreToolUse`, `PostToolUse`, `Stop`) and six field names (`conversationId`,
`workspacePaths`, `stepIdx`, `invocationNum`, `transcriptPath`,
`artifactDirectoryPath`). All other fields (`toolName`, `toolInput`,
`toolResponse`, `isError`, `fullyIdle`, `agentVersion`) are conservative
reconstructions needed to exercise the adapter; see
`../../../src/providers/antigravity/maturity.ts` for the gates that must be
cleared before this adapter is promoted out of `experimental`.

`workspacePaths` and `transcriptPath`/`artifactDirectoryPath` values below are
placeholder strings (e.g. `/workspace/example-repo`), not real home
directories or checkout paths. `toolInput`/`toolResponse` secret-shaped values
(`sk-...`, `token`, `api_key`) are fabricated for the privacy tests and are not
live credentials.

| File | Scenario |
| --- | --- |
| `pre-invocation-first.json` | First invocation of a conversation (`invocationNum: 0`) |
| `pre-invocation-subsequent.json` | A later invocation (`invocationNum: 3`) — no session-start fact |
| `post-invocation.json` | Post-invocation bookkeeping only |
| `pre-tool-use.json` / `post-tool-use.json` | A correlated tool-call pair (`stepIdx: 5`) |
| `pre-tool-use-subagent.json` / `post-tool-use-subagent.json` | `invoke_subagent` modeled as a delegated tool call |
| `post-tool-use-error.json` | A failed tool call (`isError: true`) |
| `stop-fully-idle.json` | Terminal `Stop` (`fullyIdle: true`) |
| `stop-not-idle.json` | Non-terminal `Stop` (`fullyIdle: false`) |
| `malformed.json` | Recognizable `hookEventName` but missing required fields |
| `unknown-fields.json` | Valid payload plus additive/unknown fields |
| `secrets-tool-input.json` | Tool input carrying secret-shaped keys and values |
