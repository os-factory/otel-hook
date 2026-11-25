# e2e proof capture fixtures — provenance

`passing-capture/` is a **synthetic** capture directory in the format written
by `scripts/e2e-proof/otlp-receiver.mjs` (`otel-hook.otlp-capture/v1`): one
`NNNN-<signal>.json` metadata file and one `NNNN-<signal>.body` raw body per
request. It was hand-built for this repository (a small generator, not a real
run), not captured from any real agent session, Langfuse instance or HAR slot.

- Bodies are OTLP/JSON (`application/json`) so the fixture stays reviewable;
  the receiver tests and `tests/e2e-proof/proof-run.test.ts` cover the
  protobuf path against the built CLI.
- Every id, session key, work unit (`synthetic-56`), branch and repository URL
  (`https://example.invalid/sandbox.git`) is invented. There are no local paths,
  emails, credentials or prompt text.
- Attribute names follow what otel-hook exports (`src/telemetry/`) and the
  Factory Commits telemetry profile's resource attributes (`factory.*`, `vcs.*`).

What it models: request 1 is an empty traces body (the #54 observation),
request 3 is rejected with an injected 503 and its tool span is redelivered in
request 4, the session span arrives last. Requests 7 to 9 are cumulative OTLP
metrics (issue #69): request 7 holds the session and tool call counters, request
8 adds the token usage and duration histograms, and request 9 re-sends request 8
byte for byte, as a spool replay would, so the checker must count it once. The checker passes it with
`--session-id har-synthetic-session-0001 --work-unit-id synthetic-56
--expect-tool Read --expect-usage input=200,output=8,cache_read=80`. Tests that
need protobuf metrics build them from `tests/e2e-proof/otlp-metrics.ts` with
the OpenTelemetry SDK's own serializer. Failing cases are derived
from it inside `tests/e2e-proof/check-evidence.test.ts` by mutating a temporary
copy, so every failure is one visible edit away from a passing capture.
