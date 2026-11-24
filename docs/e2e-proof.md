# End-to-end proof of features per provider

This is the recipe for issue #56. A capability matrix (#18) says what each
adapter **claims**. This page says how to **prove** each claim with a real agent
session, launched by HAR 2.0 in a sandboxed slot, exporting to real backends.
The evidence for each provider is posted as one comment on #56, edited in place.

A cell in the matrix is ticked only with a link to its evidence. A cell can also
be marked "not supported", with a link to the limitation in #18 or the parity
doc.

What is in this repository:

| Piece | Path | Role |
|---|---|---|
| Disk receiver | `scripts/e2e-proof/otlp-receiver.mjs` | Local OTLP/HTTP endpoint that writes every request to disk |
| Evidence checker | `scripts/e2e-proof/check-evidence.mjs` | Checks the matrix rows that can be decided from a capture; prints JSON and a markdown snippet |
| Decoder | `scripts/e2e-proof/otlp-decode.mjs` | OTLP traces and logs, protobuf and JSON, shared with the agent lab |
| Agent lab | `har-plugins/agent-lab/` | Offline run of a real agent CLI against a mocked model API; writes a capture and runs the checker on it |
| Tests | `tests/e2e-proof/` | Receiver, checker (synthetic capture in `tests/fixtures/e2e-proof/`), and a miniature proof run through the built CLI |

What is **not** in this repository: HAR, `git factory`, Langfuse, the sandbox
repositories, and the evidence itself. Those belong to the proof runs.

## Setup

Mark anything you could not confirm as unverified in the evidence comment. Do
not guess a flag. The HAR 2.0 and `git factory` commands below are the ones
announced in os-factory/har#416 and in the factory-commits README; where a
command was not available when this page was written, it says so.

### 1. Tools

- **HAR 2.0**: `npm install -g @osfactory/har@next`.
  *Unverified:* when this page was written, the `next` dist-tag still pointed to
  `1.0.0-rc.2` and `latest` to a 1.x release. Check `har --version` reports
  2.x before you start, and record the exact version in the evidence.
- **`git factory`**: `npm install -g @osfactory/factory-proof`, then
  `git factory --version`. It is version 0.2.0 at the time of writing (Factory Commits v0.1).
- **otel-hook, built from the version under test**:

  ```bash
  git -C otel-hook checkout <ref under test>
  npm ci && npm run build
  npm pack                        # a tarball of exactly this build
  npm install -g ./osfactory-otel-hook-<version>.tgz
  otel-hook --version             # record this
  ```

  Install the tarball rather than linking the checkout, so the hooks run the
  build you recorded and not whatever the checkout holds later.

### 2. Destinations

Run all of them for every provider run:

1. **Local Langfuse in Docker**: follow Langfuse's self-hosting guide
   (docker compose). Create a project and an API key pair. The OTLP traces
   endpoint is `http://localhost:3000/api/public/otel/v1/traces`. Its auth
   header is `Authorization: Basic base64(<public key>:<secret key>)`.
   Langfuse ingests traces. Check what it does with OTLP logs before you rely on it.
2. **The disk receiver** (this repository):

   ```bash
   node scripts/e2e-proof/otlp-receiver.mjs \
     --capture-dir proof/<provider>/capture --port 4318
   # prints {"event":"listening","endpoint":"http://127.0.0.1:4318",...}
   # one line per request on stderr; Ctrl-C writes summary.json
   ```

   Add `--fail-first 1 --fail-signal traces` (or `logs`) for the spool replay
   row: the first matching request gets a 503, and the checker then proves that
   its records arrived in a later request. Use a separate run for this. A
   rejected first request changes what the first run's other rows see.
3. **A second destination, once #54 ships**: a second receiver on another port
   (`--capture-dir proof/<provider>/capture-b --port 4319`), configured as a
   second `exporter.destinations[]` entry. Until #54 ships, otel-hook sends to
   one endpoint, so the "Multiple destinations" half of that row stays pending.

Until #54 ships, one otel-hook process exports to one endpoint. To feed
Langfuse and the receiver in the same run, do one of these:

- run the provider twice (once per destination) with the same scripted task, or
- put an OpenTelemetry Collector in front of both and point otel-hook at it.
  The receiver then sees the Collector's re-encoded requests, not otel-hook's.
  Say so in the evidence.

### 3. Sandbox repository and HAR slot

- One sandbox repository per provider. Use a throwaway repository with
  no secrets, for example `<org>/otel-hook-proof-sandbox-<provider>`, initialized
  with a README and a small file the task can read. Use the same task text for
  every provider.
- Launch a HAR slot bound to the issue as the work unit:

  ```bash
  har env launch <slot> --work-id otel-hook-56 --work-source github \
    --work-url https://github.com/os-factory/otel-hook/issues/56 \
    --work-title "E2E proof: <provider>"
  ```

  `--work-id`, `--work-source`, `--work-url` and `--work-title` exist on HAR
  1.30. *Unverified for 2.0:* how HAR 2.0 points the hooks at destinations. It
  may be `har telemetry destination add` (os-factory/har#418) or the "direct
  mode" of #416. Neither was released when this page was written.
- **Session attribution.** The launcher's `session.id`, `factory.*` and `vcs.*`
  attributes must reach the hook process (Factory Commits telemetry profile:
  `session.id`, `factory.work_unit.id`, `factory.work_unit.source`,
  `factory.attempt.id`, `factory.producer.name`, `factory.producer.version`,
  `vcs.repository.url.full`, `vcs.ref.head.name`). The profile names
  `OTEL_RESOURCE_ATTRIBUTES` as the simplest carrier.
  **Observed:** Claude Code 2.1.331 does not pass `OTEL_*` variables from its
  own environment to hook processes. Other variables do get through. A profile
  set only in the agent's environment therefore never reaches otel-hook under
  Claude Code. Put it on the hook command instead (`otel-hook run
  --resource-attr session.id=<key> --resource-attr factory.work_unit.id=...`),
  or in an otel-hook config file (`--config-file`). Record which carrier HAR
  2.0 used. If the session span lacks the launcher's id, this is the first
  thing to check. The agent lab does the same with `--resource-attr`.
- **Auth.** otel-hook 0.6.0 sends the Authorization header from
  `OTEL_EXPORTER_OTLP_HEADERS`, from `OTEL_EXPORTER_OTLP_TRACES_HEADERS`, and
  from `--header`. All three were confirmed against the disk receiver, which
  records only the header's scheme. Under Claude Code, the environment
  variables run into the same `OTEL_*` filtering as above.

### 4. Scripted task

Run one deterministic task per provider, for example: *"Read `README.md` with
your file-reading tool, then append a line `proof: <provider>` to `PROOF.md`
and stop."* The task must cause at least one tool call, one model turn with
token usage, and one file change to commit. Record the agent's own token
totals: Claude Code's `--output-format json` `usage`, and Codex's
`turn.completed` totals. Pass them to `--expect-usage`. Without them, the
delta-vs-cumulative row can only be checked partly.

Then run `har env verify <slot> --full`, commit, and record the proof (below).

## Evidence required for each check

The issue requires all of this for every provider:

- otel-hook version (`otel-hook --version`), agent version, date
- the HAR slot, the work unit, and the verification run id
- the commit, and the output of `git factory show <commit>` (the proof digest
  and its level). *Unverified:* the factory-proof 0.2.0 README documents
  `setup`, `trailers`, `attest`, `note` and `verify`, but not `show`. If `show`
  is missing, use `git factory verify <commit> --json` (it gives the level and
  the problems) and `git notes --ref=factory show <commit>` (it gives the
  statement digest), and say so.
- the trace id, and a Langfuse link or screenshot of the session that shows
  `session.id` and `factory.work_unit.id` on the records
- the receiver capture, showing the expected attributes and **no**
  `factory.local.*` or local paths: the checker's output, below

## Checking a capture

```bash
node scripts/e2e-proof/check-evidence.mjs proof/<provider>/capture \
  --provider <provider id> \
  --session-id <the launcher's session id> \
  --work-unit-id otel-hook-56 \
  --expect-tool <tool the task used, e.g. Read> \
  --expect-usage input=<n>,output=<n>,cache_read=<n> \
  --forbid "$PWD" --forbid "$HOME" --forbid "$(git config user.email)" \
  --forbid "<the sandbox checkout's absolute path>" \
  --json-out proof/<provider>/evidence.json \
  --markdown-out proof/<provider>/evidence.md
# add a second capture directory as another positional argument for #54
```

- Exit code 0 means no check failed, 1 means at least one failed, 2 means a
  usage error.
- `--forbid` values must not appear in any request body. The report names them
  only by position and length, never by value.
- `--require-attr <key>` (repeatable) replaces the default list of profile keys
  that every record must carry: `factory.work_unit.id`,
  `vcs.repository.url.full` and `vcs.ref.head.name`.
- Each request is re-decoded from its raw `.body` file. The decoded copy in
  the metadata file is only there for people to read.
- The output never contains a forbidden value, an email address or a full local
  path, so the markdown can go straight into the issue comment.

### Capture format (`otel-hook.otlp-capture/v1`)

For each request, in arrival order:

- `NNNN-<traces|logs|unknown>.body`: the raw request body, byte for byte.
  It is 0 bytes when the request was empty.
- `NNNN-<signal>.json`: `seq`, `receivedAt`, `path`, `contentType`,
  `encoding`, `bytes`, `empty`, `responseStatus`, `injectedFailure`, header
  names, the scheme of `Authorization` (never its value), record counts, and
  the decoded spans or log records.

On exit, the receiver also writes `summary.json` (counts per signal, empty
bodies, statuses).

Empty bodies are recorded on purpose. When this tooling was added, the built
CLI (0.6.0) posted a zero-byte traces request for Claude Code's `SessionStart`
and `PreToolUse`. Those are start edges that close no span, so a traces batch
with nothing in it is still posted. When that empty request was rejected
with a 503, the spool replayed the empty batch on the next invocation. This may
explain the #54 observation (5 hook events, 3 requests, one empty). The checker
lists empty requests under `capture-integrity` and does not fail them.

## Matrix

Every cell is pending until a provider comment links its evidence.

| Feature | Claude Code | Codex | Cursor | Gemini CLI | Antigravity | How it is checked |
|---|---|---|---|---|---|---|
| Session span with the launcher's `session.id` | pending | pending | pending | pending | pending | `session-span` (mechanical) + Langfuse session view |
| Profile attributes (`factory.*`, `vcs.*`) on records | pending | pending | pending | pending | pending | `profile-attributes` (mechanical) + Langfuse record view |
| Tool spans | pending | pending | pending | pending | pending | `tool-spans` (mechanical) |
| Token usage (delta vs cumulative correct) | pending | pending | pending | pending | pending | `token-usage` (mechanical; needs `--expect-usage` for the cross-check) |
| Logs signal | pending | pending | pending | pending | pending | `logs-signal` (mechanical) |
| `OTEL_EXPORTER_OTLP_*_HEADERS` auth to Langfuse | pending | pending | pending | pending | pending | **manual**: the trace is in Langfuse. `headers-auth` only shows the header reached the receiver |
| Multiple destinations + spool replay | pending | pending | pending | pending | pending | `multi-destination` (two captures; needs #54) + `spool-replay` (a `--fail-first` run) |
| Privacy: no `factory.local.*`, no paths, no account identity | pending | pending | pending | pending | pending | `privacy` (mechanical, every destination, delivered and rejected requests) + a glance at Langfuse |
| Trace ↔ Factory Commits proof correlation | pending | pending | pending | pending | pending | **manual**: `git factory` output; `trace-proof` lists the session trace ids |

### What each check asserts

| Check | Passes when |
|---|---|
| `capture-integrity` | The capture holds at least one request and every body decodes. Empty bodies and duplicate records are listed, but do not fail the check. |
| `session-span` | A delivered span named `session` carries the expected `session.id`, on the resource or the span, and every delivered record carries it. The span's `otelhook.session.id` (the provider's own id) is reported too. Without `--session-id`, a single resource `session.id` is enough. |
| `profile-attributes` | Every delivered record has at least one `factory.*` key (other than `factory.local.*`) and at least one `vcs.*` key, on the resource or on the record, plus every required key, plus `factory.work_unit.id` equal to `--work-unit-id`. otel-hook copies only `har.*` resource attributes onto records, so `factory.*` keys are expected on the resource. |
| `tool-spans` | At least one span has `gen_ai.tool.name`, and every `--expect-tool` has one. Unpaired tool spans are reported. |
| `token-usage` | Usage is present. Every usage record has `otelhook.usage.temporality` set to `delta` or `cumulative`, and its counters are non-negative integers. A cumulative series never decreases, unless `otelhook.usage.reset_detected` is set. With `--expect-usage`, the session totals from generation spans equal the agent's own totals: deltas are summed, and a cumulative session counts its largest total once. If both deltas and running totals are present, the deltas never exceed the running total. |
| `logs-signal` | At least one delivered log record has `otelhook.event.type`. Event types are reported, and so is how many records share a trace id with a span. |
| `spool-replay` | Every record from a rejected (non-2xx) request arrives later in a successful request. The check is skipped when nothing was rejected, or when only empty bodies were. |
| `multi-destination` | Given two or more capture directories, each received the same set of delivered records. The check is skipped with one capture directory. |
| `privacy` | Across every request of every capture, delivered or rejected: no `factory.local.*` key and no `factory.local.` bytes; no attribute value, log body or span name that is an absolute path; no home-directory path in the raw bytes; no email address (except `git@`-style service users); no `user.*` or `enduser.*` identity key; no credentials inside a URL; no `--forbid` value. |
| `headers-auth` | Manual. Reports which `Authorization` schemes reached the receiver. |
| `trace-proof` | Manual. Lists the session trace ids to match against the proof. |

### Rows that need manual evidence

- **`OTEL_EXPORTER_OTLP_*_HEADERS` auth to Langfuse.** A Langfuse link or a
  screenshot of the session's trace, from a run where the header came only from
  the environment variable, not from `--header`. Show how the variable reached
  the hook (see the Claude Code caveat above).
- **Trace ↔ Factory Commits proof correlation.** The `git factory` output for
  the commit (level and statement digest), and the factory run id it names.
  Show that the same work unit (`factory.work_unit.id`) and the trace id appear
  on both sides. The proof predicate may carry `telemetry.traceId`, and the
  `Factory-Run` trailer may carry `trace=<id>` (Factory Commits telemetry
  profile).
- **Langfuse views** for the session and profile rows. They show that the
  backend shows what the capture holds.

## Offline rehearsal: the agent lab

Before a real run, rehearse with the agent lab. It runs the real agent CLI
against a mocked model API, so it needs no account:

```bash
npm run build
AGENT_LAB_KEEP=1 npm run lab:claude    # or lab:codex
# <labRoot>/otlp-capture/ is the capture, <labRoot>/evidence.md the checker's snippet
```

The lab puts a synthetic launcher profile on the hook command. Its report
includes the checker's result (informational: the lab's own pass/fail is
unchanged). When this page was written:

- **Claude Code 2.1.331**: every mechanical row passed. The usage totals
  matched the scenario's frozen numbers.
- **Codex**: `session-span` failed, because no `session` span is exported
  (Codex has no session-end hook, so the session span never closes). Its
  generation span carries `cumulative` usage, and the totals matched Codex's
  own report. Decide in #18 whether the session row is "not supported" for
  Codex, or needs another closing edge.

Only Claude Code and Codex have lab drivers. Cursor, Gemini CLI and
Antigravity each need a driver under `har-plugins/agent-lab/scripts/providers/`
(a mock of the provider's model API, an isolated config home, and argv for a
non-interactive run) and a scenario JSON, following the two existing ones. A
scenario is cheap; the mock API is not. Until then, their proof runs go
straight to the real recipe above.

## Per-provider evidence comment template

Post one comment per provider on #56 and edit it in place.

````markdown
## <Provider> — e2e proof

| | |
|---|---|
| otel-hook | `<otel-hook --version>` (built from `<commit or tag>`) |
| Agent | `<agent> <version>` |
| HAR | `<har --version>` · slot `<id>` · work unit `otel-hook-56` · verification run `<run id>` |
| Date | YYYY-MM-DD |
| Sandbox | `<sandbox repo>` @ `<commit>` |
| Commit | `<sha>` |
| Proof | `git factory show <sha>` → level `<L0/L1/L2>`, digest `<sha256:…>` (or `verify --json` + `git notes --ref=factory show`, see recipe) |
| Trace | `<trace id>` · Langfuse: <link or screenshot> |
| Agent-reported usage | input `<n>`, output `<n>`, cache read `<n>` |

### Matrix

| Feature | Result | Evidence |
|---|---|---|
| Session span with the launcher's `session.id` | ☐ | checker `session-span` + Langfuse session |
| Profile attributes (`factory.*`, `vcs.*`) on records | ☐ | checker `profile-attributes` + Langfuse record |
| Tool spans | ☐ | checker `tool-spans` |
| Token usage (delta vs cumulative correct) | ☐ | checker `token-usage` with `--expect-usage` |
| Logs signal | ☐ | checker `logs-signal` |
| `OTEL_EXPORTER_OTLP_*_HEADERS` auth to Langfuse | ☐ | Langfuse link; how the variable reached the hook |
| Multiple destinations + spool replay | ☐ | checker `multi-destination` (two captures) + `spool-replay` (`--fail-first` run) |
| Privacy: no `factory.local.*`, no paths, no account identity | ☐ | checker `privacy` (forbidden: cwd, home, git email, sandbox path) |
| Trace ↔ Factory Commits proof correlation | ☐ | `git factory` output + trace id |

<details><summary>Receiver capture check</summary>

<!-- paste proof/<provider>/evidence.md here -->

</details>

Command: `node scripts/e2e-proof/check-evidence.mjs <capture> --provider … --session-id … --work-unit-id … --expect-tool … --expect-usage … --forbid …`
````

Use "not supported" instead of a tick, with a link to #18 or to the parity
doc, when a provider cannot support a row.
