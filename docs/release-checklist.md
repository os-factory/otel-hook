# Release checklist

`.github/workflows/release.yml` prepares a reviewable, provenance-attested
release candidate on every `v*` tag push — it never runs `npm publish`.
Promoting a candidate to a real npm release is a deliberate, separate action
taken by an integration owner. First public release: `0.1.0`.

## What the release workflow already did for you

For a given tag, check the workflow run for:

- [ ] `npm run check` passed (typecheck, lint, unit+parity+packaging tests, build).
- [ ] The pack/install/API/binary smoke test passed
      (`scripts/packaging/pack-smoke-test.mjs`) — every subpath export
      resolves and the CLI binary runs, from a tarball, not from source.
- [ ] The dependency license scan passed
      (`scripts/security/check-licenses.mjs`).
- [ ] A draft GitHub release exists for the tag, with:
  - [ ] the packed tarball (`osfactory-otel-hook-<version>.tgz`)
  - [ ] `sbom.cdx.json` (CycloneDX) and `sbom.spdx.json` (SPDX)
  - [ ] a build provenance attestation (visible under the release's
        "Attestations" / via `gh attestation verify`)

## What the integration owner does before promoting

1. **Read the differential parity report.** `tests/parity/*.parity.test.ts`
   only assert divergences already named in
   `tests/parity/divergence-manifest.ts`. If a run surfaced a *new*, unnamed
   divergence from the pinned `opentelemetry-hooks` reference, that's a
   signal something changed in our own canonical behavior (or the pin needs
   bumping) — resolve it before promoting, don't just re-run.
2. **Decide whether this release changes the public surface** per
   [docs/compatibility-policy.md](compatibility-policy.md). If so, confirm the
   version bump matches semver for that change and `CANONICAL_SCHEMA_VERSION`
   was bumped if the canonical model's meaning changed, not just its shape.
3. **Verify provenance.** Download the tarball from the draft release and:
   ```bash
   gh attestation verify osfactory-otel-hook-<version>.tgz --repo <org>/<repo>
   ```
4. **Flip the publish gate.** In a dedicated PR:
   - Remove (or set `false`) `"private": true` in `package.json`.
   - Confirm `files`/`exports`/`bin` in `package.json` still match what
     `tests/packaging/pack.test.ts` verified.
5. **Publish.** From a clean checkout of the tagged commit, after the PR in
   step 4 is merged:
   ```bash
   npm ci
   npm run build
   npm publish --provenance --access public
   ```
   `--provenance` requires running from a CI environment with OIDC available
   (GitHub Actions), not a local machine — consider adding a manually
   `workflow_dispatch`-triggered publish job once this package is ready for
   its first real release, gated on the same draft-review step above.
6. **Un-draft the GitHub release** once `npm publish` succeeds, and link the
   npm package page in the release notes.

## Rolling back

Because nothing is published until step 5, rolling back before that point is
just: don't promote, delete the tag if it was created in error, and address
the finding through a new PR. npm itself does not support un-publishing a
version once other packages may depend on it, so treat step 5 as the actual
point of no return.
