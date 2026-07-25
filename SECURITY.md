# Security policy

## Supported versions

`@osfactory/otel-hook` is pre-1.0 and currently unpublished (`"private": true`
in `package.json`). Until a 1.0 release, only the latest commit on `main` and
the most recent tagged release candidate receive security fixes.

| Version                          | Supported          |
| --------------------------------- | ------------------- |
| `main` / latest tagged RC        | :white_check_mark:  |
| Anything older                   | :x:                 |

## Reporting a vulnerability

Please **do not** open a public GitHub issue for a suspected vulnerability.

Instead, use GitHub's private vulnerability reporting for this repository
(Security tab → "Report a vulnerability"), which reaches maintainers directly
without disclosing details publicly. If that is unavailable to you, contact
the maintainers listed in [CODEOWNERS](.github/CODEOWNERS).

Please include:

- The affected version or commit SHA.
- A minimal reproduction (ideally a synthetic fixture, not a real transcript —
  see [CONTRIBUTING.md](CONTRIBUTING.md) for what "synthetic" means here).
- The impact you believe the issue has: disclosure of conversation content,
  attribution spoofing, a way to make the hook block or crash a host agent
  (a violation of [ADR 0004](docs/adr/0004-stdout-and-fail-open.md)), or
  something else.

We aim to acknowledge reports within 5 business days and to agree on a
disclosure timeline with the reporter before any public write-up.

## What counts as a security issue here

Given this library's actual attack surface (ADR 0004, ADR 0005), the reports
we most want to hear about are:

- **Content disclosure**: any way for prompt, response, reasoning, tool
  argument, or error text to reach a telemetry sink under the default
  `contentMode: "omit"` policy, or any way to escape the bounds
  (`maxStringLength`, `maxDepth`, `maxArrayLength`, `maxObjectKeys`) that
  policy is supposed to enforce.
- **Path/identifier leakage**: any way for a real filesystem path, hostname, or
  credential to reach `WorkspaceIdentity`, an event attribute, or an
  extension, instead of the opaque salted handles those types are designed to
  produce.
- **Attribution spoofing**: any way to make the hook attribute events to the
  wrong `invocationId`/`sessionId`, or to silently merge two distinct
  invocations, rather than failing closed per
  [ADR 0001](docs/adr/0001-invocation-identity-isolation.md).
- **Fail-open violations**: any input that makes the hook throw uncaught, exit
  non-zero, or write to stdout outside a declared provider-protocol response
  (ADR 0004) — because that turns a telemetry bug into a host-agent outage.
- **Supply-chain issues**: a compromised dependency, a build step that could
  inject code into `dist/`, or a gap in the release provenance/SBOM pipeline
  (see `.github/workflows/release.yml` and `docs/release-checklist.md`).

Please still report anything else you find suspicious even if it doesn't fit
neatly into the above — this list describes what we expect to be most useful,
not the boundary of what we'll act on.

## Scope note on the parity harness

`tests/parity/**` and `scripts/parity/**` install and execute a pinned,
third-party Python package (`opentelemetry-hooks==0.14.0`) inside an isolated
temp directory purely to compare behavior — see
[docs/shadow-mode.md](docs/shadow-mode.md). A vulnerability in that third-party
package itself should be reported to its own maintainers, not here; a
vulnerability in *how our harness isolates or invokes it* (for example, a way
for the harness to reach a real OTLP endpoint or write outside its temp
directory) is in scope for this repository.
