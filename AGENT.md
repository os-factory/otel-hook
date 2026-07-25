# Agent guide

## Scope

`@osfactory/otel-hook` is an independent TypeScript library and CLI. Do not
import HAR code or encode HAR slot concepts in its public model.

## Architecture

Dependency direction:

```text
CLI / installers
  -> protocol
  -> provider adapters
  -> canonical model
  -> lifecycle
  -> state and telemetry sinks
```

Raw provider payloads must not escape provider adapters. Consumer attributes
are opaque, immutable invocation metadata.

## Safety

- Hook behavior fails open so telemetry cannot block the host agent.
- Attribution fails closed: unknown or conflicting identity is never guessed.
- Prompt, response, reasoning, error, and tool content is omitted by default.
- Do not introduce module-level mutable identity, session, tracer, or workspace.
- Do not scan arbitrary transcript directories from provider adapters.

## Verification

Before committing:

```bash
npm run check
```

Provider changes require contract fixtures, replay tests, privacy assertions,
and actual CLI-to-captured-OTLP integration coverage where applicable.
