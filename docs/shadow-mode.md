# Shadow mode: running the parity differential harness safely

"Shadow mode" here means: run a pinned, third-party telemetry package
(`opentelemetry-hooks==0.14.0`) side by side with `@osfactory/otel-hook`,
purely to compare behavior, without either side affecting production state,
a real OTLP backend, or a host agent's stdout contract. This document is both
a description of how `tests/parity/**` does that today and a guide for anyone
running or extending the differential harness.

## The three invariants

1. **Never emits OTLP.** `scripts/parity/python-reference.mjs` always sets
   `OTEL_EXPORTER_OTLP_ENDPOINT: ""` before invoking the reference package.
   This matters more than it sounds: the package bootstraps a bundled example
   config into `$IDE_OTEL_HOOK_HOME/otel_config.json` on first use in any new
   state directory, and that bundled config defaults to
   `http://localhost:4317` — an empty-but-set env var is what prevents that
   default from taking effect. `IDE_OTEL_ENABLE_LOGS: "false"` additionally
   disables the package's separate logs pipeline, which (unlike its tracer
   pipeline) has no local-only bypass and otherwise always constructs a real
   OTLP gRPC log exporter.
2. **Never writes production state.** Every session runs inside a fresh
   `mkdtemp()` directory under the OS temp dir
   (`otel-hook-parity-home-<random>`), passed as `IDE_OTEL_HOOK_HOME`, and that
   directory is `rm -rf`'d in a `finally` block after the session — win or
   lose. The reference package's own persistent Python venv
   (`otel-hook-parity-venv-0.14.0`, also under the OS temp dir) is reused
   across runs deliberately: it's a build cache, not application state, and
   rebuilding it every invocation would make the harness spend most of its
   time re-running `pip install`.
3. **Never alters authoritative stdout.** Both sides run as ordinary
   subprocesses whose stdout is captured by the harness, not forwarded. On
   our own side, nothing in `tests/parity/**` or `scripts/parity/**` touches
   `@osfactory/otel-hook`'s actual hook path or its stdout contract
   ([ADR 0004](adr/0004-stdout-and-fail-open.md)) — the comparison mapper in
   `tests/parity/harness/canonical-mapping.ts` calls the same public
   `createEventFactory`/`createPrivacyService` functions a real adapter would,
   in-process, and returns canonical events as data, never through a hook
   invocation.

`tests/parity/shadow-mode.test.ts` asserts invariants 1 and 2 by inspecting
the runner script's source for the literal env var assignments and cleanup
call, so a future edit that silently drops one of them fails CI immediately
rather than only showing up as a flaky, hard-to-diagnose network call.

## Why a comparison mapper instead of a provider adapter

`tests/parity/harness/canonical-mapping.ts` maps synthetic, third-party-shaped
hook payloads (Claude Code's and Cursor's own documented hook JSON shapes) to
canonical events. It is explicitly **not** a `ProviderAdapter`: it is not
registered with `createProviderRegistry`, and it is not built into `dist/`.
This repository's parity/packaging/CI ownership area does not implement
providers or change the provider registry — that's a separate integration
task per provider. The mapper exists solely so the differential tests have
something to compare the pinned Python package's output *against*, using only
this library's already-public API.

## Reproducing a comparison run locally

```bash
# One-time (or whenever the pin changes): probe availability, which also
# creates/reuses the cached venv.
node scripts/parity/python-reference.mjs --probe

# Run one session's fixtures through the pinned reference and print its spans.
node scripts/parity/python-reference.mjs --provider claude-code \
  < <(node -e '
    const fs = require("node:fs");
    const files = ["session-start","user-prompt-submit","pre-tool-use","post-tool-use","pre-compact","post-compact","stop","session-end"];
    console.log(JSON.stringify(files.map(f => JSON.parse(fs.readFileSync(`fixtures/parity/claude-code/${f}.json`, "utf8")))));
  ')

# Run the actual differential assertions (skips cleanly if unavailable):
npx vitest run tests/parity
```

## What "when available" means

If `python3`/`python` isn't on `PATH`, or the pip install of the pinned
version fails (no network, registry outage), `isPythonReferenceAvailable()`
returns `{ available: false, reason }` and every `*.parity.test.ts` suite
skips itself via `describe.skipIf`, printing the reason to the console. This
is intentional: the differential harness is a *complement* to the canonical
model's own unit tests, not a dependency of them, so a contributor without
Python configured (or CI running fully offline) still gets a green `npm run
check`.

## Extending the harness

Adding a new comparison dimension:

1. Add a synthetic, provenance-documented fixture under `fixtures/parity/**`
   (see `fixtures/provenance.schema.json` and `npm run fixtures:validate`).
2. Extend the relevant mapper in `canonical-mapping.ts` if the fixture
   exercises a hook event type it doesn't yet handle.
3. If the Python reference's behavior turns out to genuinely diverge (not
   just differ in field names), add a new entry to
   `tests/parity/divergence-manifest.ts` with a citation back to the specific
   function/line in `otel_hook.py` you read, and assert it by name in a
   `*.parity.test.ts` file — `tests/parity/divergence-manifest.test.ts` fails
   if a manifest entry is ever added without a corresponding assertion.
