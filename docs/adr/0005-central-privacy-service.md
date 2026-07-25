# ADR 0005: One central privacy service, omitting content by default

- Status: accepted
- Date: 2026-07-25
- Milestone: M1 (core contract)

## Context

The data this library observes includes prompts, model responses, reasoning,
tool arguments, error messages, file paths, and repository URLs that may embed
credentials. Any of it can reach a shared collector, where it is retained,
indexed, and read by people who were never party to the conversation.

Privacy controls scattered across adapters fail predictably: each adapter
implements slightly different redaction, and a new adapter starts from zero.

## Decision

1. **Content is omitted by default.** `contentMode: "omit"` is the default
   policy. Every content fact still carries a stable salted hash and both
   character and byte lengths, so volume and repetition are measurable without
   the content.
2. **A ladder of explicit modes**, all producing a `ContentFact` whose
   `disclosure` field states what happened: `omit`, `mask` (shape-preserving),
   `redact` (secret-looking spans replaced), `raw` (verbatim).
3. **`raw` requires two switches.** `contentMode: "raw"` without
   `allowRawContent: true` is deterministically downgraded to `omit` with a
   recorded note, so one mistyped environment variable cannot start exporting
   prompts.
4. **Secret keys are handled recursively.** Keys matching the secret patterns
   have their values replaced at every depth, inside arrays and nested objects,
   *before* the value is inspected. `describeStructured` discloses the sanitized
   projection, so secret-keyed values stay hidden even in `raw` mode.
5. **Everything is bounded**: `maxStringLength`, `maxDepth`, `maxArrayLength`,
   `maxObjectKeys`, and `maxEventsPerInvocation`. Circular references are
   contained rather than overflowing the stack.
6. **Identifiers are hashes, not paths.** Workspace ids are opaque
   `<scheme>:<token>` handles; the schema pattern rejects filesystem paths by
   construction. Git remotes are canonicalized (credentials, scheme, port, and
   `.git` removed) before hashing, so equivalent spellings agree.
7. **Error messages are vocabulary, not prose.** `OtelHookErrorInfo.message` is
   derived from the code and phase; a thrown exception contributes only its class
   name and a boolean for "had a message".
8. **The boundary is enforced, not trusted.** The orchestrator drops any event
   whose content disclosure does not match the resolved policy, and reports
   `privacy-policy-violation`.

## Consequences

- Default-mode telemetry contains no conversation text. Tests assert that
  prompt fragments and secrets are absent from the entire serialized batch.
- Hashes are correlatable across events, which is the point: they let a consumer
  see that the same prompt was retried without seeing the prompt. A per-tenant
  `hashSalt` makes them non-correlatable across deployments.
- Redaction heuristics are documented as heuristics. They reduce accidental
  disclosure in `redact` mode; they are not a substitute for `omit`.
- Adapters get privacy for free but cannot opt out: a fact they build by hand is
  dropped at the boundary.

## Alternatives considered

- **Per-adapter redaction.** Rejected: inconsistent, and every new adapter
  reintroduces the risk.
- **Truncating content instead of omitting it.** Rejected: a prefix of a prompt
  is still the prompt, and secrets frequently appear early.
- **Hashing without a salt option.** Rejected: cross-deployment correlation of
  content hashes is a real disclosure vector in a shared collector.
