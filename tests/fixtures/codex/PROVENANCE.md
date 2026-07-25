# Fixture provenance

Every fixture under `tests/fixtures/codex/` is synthetic. None of it is copied
from a real Codex session, transcript, or user. Field names and shapes are
drawn from the public Codex hooks reference and rollout/exec JSONL discussions
(`developers.openai.com/codex/hooks`, mirrored at `learn.chatgpt.com/docs/hooks`;
community documentation of the rollout and `codex exec --json` formats) as of
2026-07-25, not from any captured payload.

- `hooks/*.json` — hand-written Codex hook stdin payloads, one per lifecycle
  event this adapter supports. Session ids, working directories, prompts, tool
  arguments, and "secrets" are all invented strings chosen to exercise privacy
  and detection behavior (e.g. an obviously-fake API key shaped like a real
  one, to prove redaction works, never a working credential).
- `transcripts/*.jsonl` — hand-written rollout and `codex exec --json` lines
  covering `session_meta`, `turn_context`, `token_count`, `response_item`, and
  `item.*` exec events, plus deliberately malformed and oversized lines for
  bounded-parser tests.

Working directories in fixtures (e.g. `/workspace/demo-repo`) are placeholder
paths, never a real home directory or user-identifying path.
