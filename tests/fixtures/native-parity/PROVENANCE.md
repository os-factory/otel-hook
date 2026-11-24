# Native telemetry parity fixtures: provenance

Every file in this directory is **synthetic**. Each was written by hand on
2026-11-24 for `scripts/parity/native-telemetry-parity.mjs`. None is copied
from, or derived from, a capture of a real session, account, or machine. Each
file's first line is a `{"meta": {...}}` record with `"synthetic": true`, and
the script prints `[SYNTHETIC]` next to any capture marked that way.

| File | Stands in for | Shape drawn from |
| --- | --- | --- |
| `claude-code.native.otlp.jsonl` | Claude Code's own exporter (`CLAUDE_CODE_ENABLE_TELEMETRY=1`), metrics and events, in OTLP/JSON | Metric, event, and attribute names from the public monitoring docs (`code.claude.com/docs/en/monitoring-usage`), read on 2026-11-24 |
| `claude-code.otel-hook.otlp.jsonl` | otel-hook 0.6.0 traces and logs for the same invented session | `src/telemetry/semconv.ts`, `src/telemetry/log-records.ts`, and `docs/canonical-log-mapping.md` |

All values are invented:

- Account values are placeholders: all-zero UUIDs, an all-zero hex `user.id`,
  and an email address on the reserved `example.invalid` domain. They are there
  so the script's personal-data flagging has something to find.
- The session id is `synthetic-session-0001`. The model is `synthetic-model`.
- Token counts, cost, and durations are arbitrary numbers.
- Workspace ids are all-zero handles. There are no paths, prompts, or content.

These fixtures test how the script decodes, matches, and reports. They are
**not evidence** of what either side really emits: a matching category here
does not confirm anything in `docs/native-telemetry-parity.md`. Real
comparisons need real captures; that doc explains how to record and sanitize
them. A sanitized real capture added here must get its own row in the table
above, with `"synthetic": false`, the agent and otel-hook versions in its meta
line, and a note of what was redacted.
