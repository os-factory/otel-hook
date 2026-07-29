# Gemini CLI fixture provenance

Every fixture in this directory is synthetic and hand-authored for this
repository. None of them were copied from a real Gemini CLI session, transcript,
or user prompt.

## Evidence gap, stated plainly

No real redacted capture of a Gemini CLI hook payload exists in this repository,
and none was available while these were written — the CLI was not installed on
the authoring machine. What replaces a capture here is the upstream source that
*produces* the payloads, which pins the shapes more precisely than a single
sampled session would: every field below was read from
`google-gemini/gemini-cli@3499c84f7b8e70c86600e7cd2c67a7c65a667f5e` (2026-07-28),
cross-checked against the published reference. A capture would still add value
for two things the source cannot settle — how often the API attaches
`usageMetadata` to a chunk in practice, and what a real `Notification.details`
object contains — so both are recorded as open rather than guessed.

Sources, all read on 2026-07-29:

- `packages/core/src/hooks/types.ts` — `HookEventName` (exactly the eleven events
  modelled here) and the per-event input interfaces.
- `packages/core/src/hooks/hookTranslator.ts` — `LLMRequest`/`LLMResponse`, the
  decoupled shapes `BeforeModel`/`AfterModel`/`BeforeToolSelection` carry.
- `packages/core/src/hooks/hookEventHandler.ts` — how each input is assembled.
- `packages/core/src/core/geminiChat.ts` — `AfterModel` firing per stream chunk.
- `packages/core/src/core/loggingContentGenerator.ts` — `lastUsageMetadata`,
  which is what establishes that a chunk's counters are cumulative.
- `packages/core/src/core/coreToolHookTriggers.ts` — the `Object.assign` that
  makes `AfterTool` echo a hook-rewritten `tool_input`.
- `packages/core/src/tools/definitions/base-declarations.ts`,
  `tool-names.ts`, `mcp-tool.ts` — built-in tool names and the
  `mcp_<server>_<tool>` naming rule.
- `docs/hooks/reference.md` and https://geminicli.com/docs/hooks/reference/ —
  the published contract, including the settings schema.

## Shapes these fixtures pin

- **`candidates[].content.parts` is `string[]`.** `toHookLLMResponse` filters to
  text parts and maps them to bare strings. The SDK's `[{ "text": … }]` spelling
  is what a *hook* writes back, not what one receives; the adapter reads both,
  and only the string form appears in these fixtures.
- **`usageMetadata` carries three counters.** The translator rebuilds it as
  exactly `{ promptTokenCount, candidatesTokenCount, totalTokenCount }`, dropping
  `cachedContentTokenCount` and `thoughtsTokenCount`. No fixture claims a cache
  or thought counter; that mapping is exercised in `usage.test.ts` and labelled
  there as forward-compatibility rather than a current shape.
- **A usage-bearing chunk need not be the last one.**
  `after-model-chunk-usage.json` and `after-model-final.json` carry the same
  `llm_request` and successive snapshots (512/40/552, then 512/136/648), so the
  pair is what proves the stream is billed once rather than twice.
- **`original_request_name` means a tail tool call.**
  `before-tool-tail-call.json`/`after-tool-tail-call.json` carry a
  `run_shell_command` that stood in for a `write_file`. The separate
  `*-input-rewritten.json` pair carries no `original_request_name`, because a
  hook rewriting `tool_input` does not set one.
- **Argument keys are Gemini's own**: `file_path` for `read_file`/`write_file`
  (`PARAM_FILE_PATH`), `command` for `run_shell_command`.
- **MCP tools are `mcp_<server>_<tool>`**, one underscore, with an `mcp_` prefix
  `generateValidName` enforces — not the doubled separator another CLI uses.
- **`tool_response.error` is `{ type, message }`**, with `type` drawn from
  `ToolErrorType` (`shell_execute_error` here).

## What is invented

Session ids, transcript paths, workspace paths, prompt and response text, token
counts, and tool arguments are placeholders (`ses_gemini_demo_1`,
`/workspace/demo-repo`, "Refactor the retry helper to use exponential
backoff."). `secrets-in-tool-input.json` intentionally embeds obviously fake
credentials (`AKIAFAKEFAKEFAKEFAKE`,
`sk-fake-not-a-real-key-000000000000`) to exercise the privacy service's
secret-key and secret-value redaction paths — neither is real and neither was
ever valid. It uses an MCP tool because MCP argument schemas are server-defined,
so an `env` map is plausible there; no Gemini built-in takes one.
