# @osfactory/otel-hook

Provider-neutral coding-agent hooks for OpenTelemetry.

This project exposes both an importable TypeScript library and the `otel-hook`
CLI. Provider adapters normalize coding-agent hook protocols into a versioned
canonical event model before lifecycle processing, privacy filtering, and OTLP
export.

## Status

Early development. The public contract and provider implementations are not yet
stable.

## Principles

- Independent of any telemetry consumer, including HAR
- Explicit, immutable per-invocation identity
- Provider-specific protocol adapters
- Fail-open hook execution and fail-closed attribution
- No conversation or tool content by default
- Replay-safe usage accounting

## Development

```bash
npm install
npm run check
```

Licensed under MIT.
