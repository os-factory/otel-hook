# Release checklist

`@osfactory/otel-hook` releases are cut automatically from Conventional Commits
on `main`, the same way [`@osfactory/har`](https://github.com/os-factory/har)
does. Maintainers do **not** hand-tag or run `npm publish` locally for routine
releases.

## How a release happens

1. Open a PR whose **title** is a Conventional Commit subject
   (`feat: …`, `fix: …`, …). Squash-merge uses that title as the commit on
   `main` — that is what semantic-release analyzes.
2. The [PR title](../.github/workflows/pr-title.yml) workflow rejects
   non-conventional titles before merge.
3. On push to `main`, [Release](../.github/workflows/release.yml):
   - runs `npm run check`, pack smoke, and the license scan
   - runs `semantic-release` when the merge commit is releasable
   - creates `vX.Y.Z`, updates `CHANGELOG.md` / `package.json` / `src/version.ts`,
     and opens a GitHub Release
   - publishes `@osfactory/otel-hook@X.Y.Z` to npm with `--provenance`
   - attaches the packed tarball + SBOMs to the GitHub Release

If there is nothing to release (`docs:`, `ci:`, `chore:`, …), verify still runs
and publish is skipped. Release commits themselves carry `[skip ci]` so they do
not re-enter the pipeline.

## Semver rules (PR / commit title)

| Prefix | Release |
| ------ | ------- |
| `fix:` | Patch |
| `feat:` | Minor |
| `feat!:` / `BREAKING CHANGE:` footer | Major |
| `chore:`, `docs:`, `test:`, `refactor:`, `ci:`, `style:` | No release |
| any type with `(ci)` scope | No release |

Prefer `ci: …` / `docs: …` for those-only PRs — not `feat(docs):` (type `feat`
still releases unless the scope is `ci`).

## Maintainer secrets

No npm token. `publish-npm` uses npm **Trusted Publishing**: with
`id-token: write`, npm (>= 11.5.1, hence Node 24 in that job) exchanges the
job's GitHub OIDC identity for a short-lived publish credential, and signs
provenance. Nothing is stored that can expire.

Set up once:

1. A GitHub Environment named **`npm-publish`** on `os-factory/otel-hook`
   (both release jobs run in it).
2. On npmjs.com, `@osfactory/otel-hook` → **Settings → Trusted Publisher →
   GitHub Actions**: organization `os-factory`, repository `otel-hook`,
   workflow `release.yml`, environment `npm-publish`.

`GITHUB_TOKEN` is provided by Actions (contents write for tags/releases).

## Dry-run

From the Actions tab: **Release → Run workflow → Dry run**, or locally:

```bash
npm ci
GITHUB_TOKEN=… npx semantic-release --dry-run
```

## Manual emergency publish

Only if CI cannot publish (token rotation, registry outage). From a clean
checkout of the tagged commit:

```bash
npm ci
npm run build
npm publish --access public --otp=<code>
```

Prefer fixing the workflow and re-running the failed `publish-npm` job.
