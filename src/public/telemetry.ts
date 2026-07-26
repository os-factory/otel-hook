/**
 * Curated public surface of the telemetry layer.
 *
 * `assembleReadableSpan` is omitted: it exists so the durable spool can rebuild
 * a span it persisted earlier, and exposing it would invite hosts to hand-build
 * spans that bypass the canonical-event boundary the sink depends on (ADR 0006).
 */
export {
  canonicalEventsToReadableSpans,
  parentScopeRefOf,
  spanScopeRefOf,
  startOnlySpanAttributes,
  DEFAULT_INSTRUMENTATION_SCOPE,
  MAX_RECOVERED_START_ATTRIBUTES,
  type SemanticMappingOptions,
  type SpanCorrelation,
  type SpanCorrelationResolver,
  type SpanDisposition,
  type SpanFamily,
  type SpanOrphanClassification,
  type SpanPairing,
  type SpanScopeRef,
} from "../telemetry/semconv.js";
export {
  createFileDurableSpool,
  type DurableSpool,
  type DurableSpoolOptions,
  type SerializedSpan,
  type SpoolBatch,
  type SpoolDrainResult,
  type SpoolEnqueueResult,
} from "../telemetry/durable-spool.js";
export {
  createOtlpTraceSink,
  type OtlpTelemetrySink,
  type OtlpTraceSinkOptions,
} from "../telemetry/otlp-sink.js";
