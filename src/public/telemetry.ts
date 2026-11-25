/**
 * Curated public surface of the telemetry layer.
 *
 * `assembleReadableSpan` is omitted: it exists so the durable spool can rebuild
 * a span it persisted earlier, and exposing it would invite hosts to hand-build
 * spans that bypass the canonical-event boundary the sink depends on (ADR 0006).
 */
export {
  canonicalEventTraceIdentities,
  canonicalEventsToReadableSpans,
  parentScopeRefOf,
  spanScopeRefOf,
  startOnlySpanAttributes,
  DEFAULT_INSTRUMENTATION_SCOPE,
  MAX_RECOVERED_START_ATTRIBUTES,
  type EventTraceIdentity,
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
} from "../telemetry/durable-spool.js";
export {
  type SpoolDrainResult,
  type SpoolDropCounts,
  type SpoolDropReason,
  type SpoolEnqueueResult,
  type SpoolOverflowPolicy,
  type SpoolSendOutcome,
  type SpoolStats,
} from "../telemetry/spool-queue.js";
export {
  createOtlpTraceSink,
  type OtlpTelemetrySink,
  type OtlpTraceSinkOptions,
} from "../telemetry/otlp-sink.js";
/**
 * The logs signal.
 *
 * `canonicalEventsToLogRecords` is published for the same reason
 * `canonicalEventsToReadableSpans` is: it is the versioned contract a consumer
 * reads records against, and it is pure, so a host can render the mapping without
 * standing up an exporter. The spool's record *assembly* stays internal, exactly as
 * `assembleReadableSpan` does.
 */
export {
  canonicalEventsToLogRecords,
  logSignalOf,
  logSignalsForLifecycleEvents,
  LOG_MAPPING_VERSION,
  LOG_SIGNALS,
  MAX_LOG_BODY_CHARACTERS,
  MAX_LOG_RECORDS_PER_BATCH,
  MAX_LOG_RECORDS_PER_EVENT,
  MCP_TOOL_NAME_PATTERN,
  NO_LOG_CONTENT,
  type ContentWithholdingReason,
  type LogContentPolicy,
  type LogMappingOptions,
  type LogMappingResult,
  type LogSignal,
} from "../telemetry/log-records.js";
export {
  createFileDurableLogSpool,
  type DurableLogSpool,
  type DurableLogSpoolOptions,
  type LogSpoolBatch,
  type SerializedLogRecord,
} from "../telemetry/durable-log-spool.js";
export {
  createOtlpLogSink,
  describeLogsDeliverability,
  resolveLogsEndpoint,
  type LogsDeliverability,
  type OtlpLogSinkOptions,
  type OtlpLogTelemetrySink,
} from "../telemetry/otlp-log-sink.js";
export {
  createSignalFanout,
  shareCorrelationPerBatch,
  type SignalFanoutOptions,
  type SignalFanoutSink,
} from "../telemetry/signal-fanout.js";
/**
 * Multiple export destinations: one sink pair per destination, fanned out in
 * parallel, each with its own bounded spool. `createHookRuntime` wires these from
 * `exporter.destinations`; they are published for a host wiring its own runtime.
 */
export {
  createDestinationFanout,
  createExportDestinationSinks,
  exporterPolicyForDestination,
  spoolQueueNamesFor,
  type ExportDestinationSinks,
  type ExportDestinationsOptions,
  type SkippedExportDestination,
} from "../telemetry/export-destinations.js";
export { isPermanentExportFailure } from "../telemetry/export-failure.js";

/**
 * Hook-derived metrics (issue #69): the pure derivation from canonical events,
 * the OTLP metric sink, and its spool. `createHookRuntime` wires these from
 * `exporter.metrics` and each destination's `signals`.
 */
export {
  aggregateDeltaPoints,
  deriveMetricObservations,
  METRIC_COST_USAGE,
  METRIC_INSTRUMENTS,
  METRIC_OPERATION_DURATION,
  METRIC_SESSIONS,
  METRIC_TOKEN_USAGE,
  METRIC_TOOL_CALLS,
  OPERATION_DURATION_BUCKETS,
  TOKEN_USAGE_BUCKETS,
  type DeriveMetricObservationsInput,
  type MetricInstrument,
  type MetricInstrumentName,
  type MetricObservation,
  type MetricPoint,
  type MetricsTemporality,
  type TokenType,
} from "../telemetry/metric-model.js";
export {
  createOtlpMetricSink,
  describeMetricsDeliverability,
  resolveMetricsEndpoint,
  type MetricExportResult,
  type MetricsDeliverability,
  type OtlpMetricSinkOptions,
  type OtlpMetricTelemetrySink,
} from "../telemetry/otlp-metric-sink.js";
export {
  createFileDurableMetricSpool,
  validateMetricSpoolBatch,
  type DurableMetricSpool,
  type DurableMetricSpoolOptions,
  type MetricSpoolBatch,
} from "../telemetry/durable-metric-spool.js";
