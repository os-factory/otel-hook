# Gemini CLI fixture provenance

Every fixture in this directory is synthetic and hand-authored for this
repository. None of them were copied from a real Gemini CLI session, transcript,
or user prompt.

Shapes follow the public Gemini CLI hooks documentation:

- https://geminicli.com/docs/hooks/reference/
- https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/writing-hooks.md
- https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/index.md

Session ids, workspace paths, prompt text, and tool arguments are invented
placeholders (e.g. `ses_gemini_demo_1`, `/workspace/demo-repo`, "Refactor the
retry helper to use exponential backoff."). `secrets-in-tool-input.json`
intentionally embeds an obviously fake credential
(`AKIAFAKEFAKEFAKEFAKE`, `sk-fake-not-a-real-key-000000000000`) to exercise the
privacy service's secret-key and secret-value redaction paths — it is not a real
credential and was never valid.
