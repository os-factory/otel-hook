# Contributing

Thanks for looking at `@osfactory/otel-hook`. This document covers the
mechanics of contributing; read [AGENT.md](AGENT.md) first for the
architecture and safety invariants a change must respect regardless of who
(human or agent) makes it.

## Getting started

```bash
npm install
npm run check   # typecheck, lint, test, build — must pass before you open a PR
```

`npm test` also runs `tests/parity/**` and `tests/packaging/**`. The parity
suite tries to install a pinned Python package into an isolated temp venv on
first run (see [docs/shadow-mode.md](docs/shadow-mode.md)); if that's
unavailable in your environment (no network, no `python3`), those tests skip
themselves cleanly rather than failing — you don't need Python configured to
contribute.

## Ownership areas

This repository is worked on by multiple contributors/agents with distinct,
non-overlapping ownership areas (see `.github/CODEOWNERS`). Before editing a
file, check which area it falls under:

| Area                                                              | Owns                                                                 |
| ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `src/model/**`, `src/privacy/**`, `src/runtime/**`, `src/config/**`, `src/errors/**`, `src/providers/adapter.ts`, `src/providers/builder.ts`, `src/providers/registry.ts` | Core contract (canonical model, privacy service, runtime, error taxonomy, provider adapter boundary) |
| `src/providers/*` (individual adapters, once they exist)          | Provider integration owners, one per provider                        |
| `tests/parity/**`, `tests/packaging/**`, `scripts/**`, `.github/**`, `fixtures/**`, release/security docs | Parity, packaging, CI, and release hardening (this area)             |

A change that only touches your area doesn't need sign-off from the others,
but a change to a **shared public contract** — anything re-exported from
`src/index.ts` or a subpath entry point, or the provider registry — needs
review from whoever owns the core contract, even if you're touching it from
inside your own area's tests.

## Fixtures: synthetic and provenance-documented only

Never copy a real transcript, credential, home path, or private prompt into
this repository, in a fixture, a test literal, or a commit message. Every file
under `fixtures/**` must have a sibling `<name>.provenance.json` validated by
`npm run fixtures:validate` (schema: `fixtures/provenance.schema.json`),
stating what protocol the fixture's shape is modeled on, how it was
sanitized, and its license basis. If you're adding a fixture that models a
real provider's hook protocol, base it on that protocol's *publicly
documented field names*, not on anything captured from an actual session.

## Commit style

Conventional commit prefixes (`feat:`, `fix:`, `chore:`, `docs:`, `test:`,
`ci:`) scoped to what changed, e.g. `test(parity): add cursor MCP fixture`.
Keep a commit's changes inside one ownership area where possible so review
stays scoped.

## Pull requests

- Run `npm run check` locally first; CI re-runs it plus cross-platform and
  security jobs (see `.github/workflows/`), but a failing `check` locally will
  fail there too.
- Describe *why*, not just *what* — especially for anything touching privacy
  defaults, usage semantics, or the provider adapter boundary, where the
  "why" is usually a specific failure mode being closed off (see the ADRs
  under `docs/adr/`).
- If your change affects compatibility (supported Node versions, a canonical
  schema version bump, a removed export), update
  [docs/compatibility-policy.md](docs/compatibility-policy.md) in the same PR.
