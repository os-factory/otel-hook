# Compatibility policy

## Node.js

`package.json` declares `"engines": { "node": ">=20" }`. CI verifies this on
every push/PR:

- Full matrix (typecheck, lint, test, build) on **Node 20 and 22, Linux**.
- A targeted, single-Node-version (22) pass on **macOS and Windows**, to catch
  OS-sensitive bugs (process spawning, path handling) without paying for a
  full matrix on every platform.

Dropping a Node major requires: (1) confirming no supported provider hosts
still require it, (2) a version bump documented in this file's changelog
section below, and (3) removing it from `.github/workflows/ci.yml`'s matrix in
the same PR.

## Canonical schema version

Every canonical event carries `schemaVersion` (`CANONICAL_SCHEMA_VERSION`,
currently `1`). Per [ADR 0002](adr/0002-versioned-canonical-model.md):

- **Adding an optional field** to an existing event type is non-breaking and
  does not require a version bump.
- **Re-interpreting an existing field's meaning** (not just adding to it)
  requires a version bump, because a consumer holding the old semantics would
  otherwise silently mis-total usage or mis-attribute an event.
- **Removing or renaming a field** requires a version bump.
- Consumers must treat an unknown `schemaVersion` as unreadable rather than
  guessing at its shape — this library will never ship a minor/patch release
  that silently changes what an existing `schemaVersion` means.

## Public API surface

The supported public surface is exactly what's re-exported from the entry
points listed in `package.json`'s `"exports"` map (`.`, `./model`,
`./providers`, `./privacy`, `./config`, `./errors`, `./runtime`, `./testing`)
and documented in the [README](../README.md)'s entry-point table.
`tests/public-api.test.ts` pins the exported names from the top-level entry
point; `tests/packaging/pack.test.ts` verifies every subpath actually resolves
and exposes exports once installed from a packed tarball, not just from
source.

- Removing an export, changing an exported function's parameter/return shape,
  or narrowing an exported Zod schema are all breaking changes.
- Adding a new export, or widening an accepted input type, is non-breaking.
- The provider adapter contract (`ProviderAdapter`, `ProviderContext`,
  `createEventFactory`, `createProviderRegistry`) is part of the public
  surface: a change here affects every provider integration, not just this
  package's own consumers, so it needs explicit sign-off from whoever owns
  the core contract (see `.github/CODEOWNERS`).

## Package shape

- ESM-only (`"type": "module"`, `"exports"` conditions expose `"import"`
  only). There is no CommonJS build and none is planned; a consumer on
  CommonJS needs a dynamic `import()`.
- Only `dist/`, `README.md`, and `LICENSE` are published (`package.json`'s
  `"files"`); `tests/packaging/pack.test.ts` fails CI if the packed tarball
  ever contains anything else, so source, tests, and fixtures never leak into
  a consumer's `node_modules`.
- The package stays `"private": true` until an integration owner promotes a
  release candidate — see [docs/release-checklist.md](release-checklist.md).

## Changelog

- 2026-07-25 — initial policy: Node >=20, schema version 1, ESM-only.
