import {
  DEFAULT_DESTINATION_NAME,
  effectiveSpoolPolicy,
  type DestinationScope,
  hasConfiguredDestinations,
  resolveDestinationHeaders,
  resolveExportDestinations,
  type ExportDestination,
} from "../config/destinations.js";
import { siblingSignalEndpoint } from "../config/otlp-endpoint.js";
import { effectiveExportTimeoutMillis, effectiveMetricsPolicy, type ExporterPolicy } from "../config/schema.js";
import type { DeliveryHealthSnapshot } from "../diagnostics/health.js";
import { createHealthTracker } from "../diagnostics/health.js";
import { errorInfoFromThrown, type OtelHookErrorInfo } from "../errors/index.js";
import type { CanonicalEvent } from "../model/events.js";
import type { Clock, Logger, TelemetryEmitOptions, TelemetryEmitResult } from "../runtime/ports.js";
import { createFileDurableLogSpool, type DurableLogSpool } from "./durable-log-spool.js";
import { createFileDurableMetricSpool, type DurableMetricSpool } from "./durable-metric-spool.js";
import { createFileDurableSpool, type DurableSpool } from "./durable-spool.js";
import { createEndpointHealth, type EndpointHealth } from "./endpoint-health.js";
import type { LogContentPolicy } from "./log-records.js";
import {
  createOtlpLogSink,
  resolveLogsEndpoint,
  type OtlpLogTelemetrySink,
} from "./otlp-log-sink.js";
import {
  createDisabledOtlpMetricSink,
  createOtlpMetricSink,
  type OtlpMetricTelemetrySink,
} from "./otlp-metric-sink.js";
import { createOtlpTraceSink, type OtlpTelemetrySink } from "./otlp-sink.js";
import type { SpanCorrelationResolver } from "./semconv.js";
import {
  omitRestrictedContent,
  resourceRepositoryKey,
  routeEventsToScopes,
  type ContentRestrictor,
  type ScopedBatch,
} from "./destination-scope.js";
import { resourceFromExporterPolicy } from "./exporter-resource.js";
import {
  createSignalFanout,
  type SharedCorrelationResolver,
  type SignalFanoutSink,
} from "./signal-fanout.js";

/**
 * Spool queue directories for one destination, below the identity namespace.
 *
 * `default` keeps the directories it has always had, so batches an earlier
 * version queued are still drained after an upgrade. Every other destination
 * queues under `destinations/<name>/`, so one destination's outage can never
 * consume another's budget or be drained by another's sender.
 */
export const spoolQueueNamesFor = (
  destination: string,
): { readonly traces: string; readonly logs: string; readonly metrics: string } =>
  destination === DEFAULT_DESTINATION_NAME
    ? { traces: "spool", logs: "spool-logs", metrics: "spool-metrics" }
    : {
        traces: `destinations/${destination}/spool`,
        logs: `destinations/${destination}/spool-logs`,
        metrics: `destinations/${destination}/spool-metrics`,
      };

/**
 * The exporter policy one destination's sinks are built from.
 *
 * Everything but where and how to send — timeout, batch sizes, service identity,
 * resource attributes, log content policy — is shared, so every destination
 * receives the same spans. The `default` destination gets the policy unchanged.
 */
export const exporterPolicyForDestination = (
  exporter: ExporterPolicy,
  destination: ExportDestination,
): ExporterPolicy => {
  if (destination.source === "exporter") {
    return exporter;
  }
  const { destinations, endpoint, logs, ...shared } = exporter;
  void destinations;
  void endpoint;
  const tracesEndpoint = destination.tracesEndpoint ?? destination.endpoint;
  // An explicit logs URL wins; otherwise derive from `endpoint` (not from a
  // traces-only override), and failing that let the sink derive from the traces URL.
  const derivedLogs =
    destination.logsEndpoint ??
    (destination.endpoint === undefined
      ? undefined
      : (() => {
          const derived = resolveLogsEndpoint({
            ...exporter,
            endpoint: destination.endpoint,
            logs: { enabled: true, includeContent: false, maxBatchSize: logs.maxBatchSize },
          });
          return "endpoint" in derived ? derived.endpoint : undefined;
        })());
  const { metrics: sharedMetrics, ...rest } = shared;
  // Like logs: an explicit metrics URL wins; otherwise derive from `endpoint`, and
  // failing that let the sink derive from the traces URL.
  const derivedMetrics =
    destination.metricsEndpoint ??
    (destination.endpoint === undefined
      ? undefined
      : siblingSignalEndpoint(destination.endpoint, "metrics"));
  return {
    ...rest,
    protocol: destination.protocol,
    ...(tracesEndpoint === undefined ? {} : { endpoint: tracesEndpoint }),
    headerNames: Object.keys(destination.headers).sort(),
    logs: {
      ...logs,
      enabled: destination.signals.logs,
      ...(derivedLogs === undefined ? {} : { endpoint: derivedLogs }),
    },
    metrics: {
      ...effectiveMetricsPolicy({ ...exporter, metrics: sharedMetrics }),
      enabled: destination.signals.metrics,
      ...(derivedMetrics === undefined ? {} : { endpoint: derivedMetrics }),
    },
  };
};

/** The pair of sinks, and their spools, serving one destination. */
export type ExportDestinationSinks = {
  readonly name: string;
  readonly traces: OtlpTelemetrySink;
  readonly logs: OtlpLogTelemetrySink;
  readonly spool?: DurableSpool;
  readonly logSpool?: DurableLogSpool;
  /** Hook-derived metrics; a disabled sink unless this destination takes `metrics`. */
  readonly metrics: OtlpMetricTelemetrySink;
  readonly metricSpool?: DurableMetricSpool;
  /**
   * Per-repository filter (`exporter.destinations[].scopes`). Absent: this
   * destination is sent every record, exactly as before scopes existed.
   */
  readonly scopes?: readonly DestinationScope[];
  /**
   * Splits a batch by {@link scopes}; present exactly when they are. The workspace
   * key is the batch's `TelemetryEmitOptions.workspaceRepositoryKey`.
   */
  readonly route?: (events: readonly CanonicalEvent[], workspaceRepositoryKey?: string) => ScopedBatch;
};

/** A destination left out of this invocation, and why — by name only. */
export type SkippedExportDestination = {
  readonly name: string;
  readonly reason: "header-variable-missing";
  /** Environment variable *names*; never a value. */
  readonly missingVariables: readonly string[];
};

export type ExportDestinationsOptions = {
  readonly exporter: ExporterPolicy;
  /**
   * Header values for the `default` destination's traces: `--header` over
   * `OTEL_EXPORTER_OTLP_TRACES_HEADERS` over `OTEL_EXPORTER_OTLP_HEADERS`, as
   * resolved by `resolveOtlpHeaders`.
   */
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  /**
   * Header values for the `default` destination's logs, when they differ from
   * its traces' (`OTEL_EXPORTER_OTLP_LOGS_HEADERS`). Defaults to {@link defaultHeaders}.
   */
  readonly defaultLogHeaders?: Readonly<Record<string, string>>;
  /**
   * The environment `env:` header references resolve against. Never read
   * implicitly; without it, a destination whose headers reference a variable is
   * skipped and reported.
   */
  readonly headerEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly providerId: string;
  readonly installationId: string;
  readonly clock: Clock;
  readonly logger?: Logger;
  /** Root of the spool trees. Absent, nothing is spooled. */
  readonly spoolRootDir?: string;
  /** Whether the logs signal gets a spool at all; it is only built when logs are on. */
  readonly logContent: LogContentPolicy;
  readonly correlate?: SpanCorrelationResolver;
  /**
   * Shared reachability marks (`endpoint-health.ts`). Default: one built over
   * `spoolRootDir` (in-process only without it), shared by every destination and
   * signal of this call.
   */
  readonly endpointHealth?: EndpointHealth;
  /**
   * Lowers content disclosure for a scope's `contentMode` — the privacy
   * service's `restrictContent`. Default: content above the scope's mode is
   * omitted outright.
   */
  readonly restrictContent?: ContentRestrictor;
};

/**
 * A trace sink for a destination that does not take the traces signal.
 *
 * Contributes zero accepted and zero rejected — unlike a *disabled exporter*,
 * which accepts everything — because the counts decide commit-or-retry and a
 * signal that never tried must not make a real loss elsewhere look delivered.
 */
const createOptedOutTraceSink = (destination: string | undefined): OtlpTelemetrySink => {
  const health = createHealthTracker(
    "telemetry-sink",
    destination === undefined ? {} : { destination },
  );
  return {
    emit: (): Promise<TelemetryEmitResult> =>
      Promise.resolve({ accepted: 0, rejected: 0, errors: [] }),
    flush: (): Promise<void> => Promise.resolve(),
    shutdown: (): Promise<void> => Promise.resolve(),
    health: (): DeliveryHealthSnapshot => health.snapshot(),
    drainSpool: (): Promise<{
      readonly drained: number;
      readonly remaining: number;
      readonly failed: number;
    }> => Promise.resolve({ drained: 0, remaining: 0, failed: 0 }),
  };
};

/**
 * Build one sink pair per enabled destination.
 *
 * With no `exporter.destinations`, this is exactly the single `default`
 * destination the runtime has always built: the same policy, the same header
 * values, the same spool directories.
 */
export const createExportDestinationSinks = (
  options: ExportDestinationsOptions,
): {
  readonly destinations: readonly ExportDestinationSinks[];
  readonly skipped: readonly SkippedExportDestination[];
} => {
  const labelled = hasConfiguredDestinations(options.exporter);
  const spoolPolicy = effectiveSpoolPolicy(options.exporter);
  const destinations: ExportDestinationSinks[] = [];
  const skipped: SkippedExportDestination[] = [];
  const endpointHealth =
    options.endpointHealth ??
    createEndpointHealth({
      ...(options.spoolRootDir === undefined ? {} : { rootDir: options.spoolRootDir }),
      clock: options.clock,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.exporter.endpointDownMillis === undefined ? {} : { downMillis: options.exporter.endpointDownMillis }),
      probeMillis: effectiveExportTimeoutMillis(options.exporter) + 1_000,
    });

  const scopedResourceKey = resourceRepositoryKey(resourceFromExporterPolicy(options.exporter).attributes);
  const restrict = options.restrictContent ?? omitRestrictedContent;

  for (const destination of resolveExportDestinations(options.exporter)) {
    let headers: Readonly<Record<string, string>> | undefined;
    let logHeaders: Readonly<Record<string, string>> | undefined;
    if (destination.source === "exporter") {
      headers = options.defaultHeaders;
      logHeaders = options.defaultLogHeaders ?? options.defaultHeaders;
    } else {
      const resolved = resolveDestinationHeaders(destination.headers, options.headerEnvironment);
      if (resolved.missingVariables.length > 0) {
        // Sending without the header would be refused at best, and at worst
        // accepted into somebody else's unauthenticated tenant. So the destination
        // sits this invocation out, and says which variable it is waiting for.
        options.logger?.warn("export destination skipped: a header references an unset environment variable", {
          "export.destination": destination.name,
          "config.variables": [...resolved.missingVariables],
        });
        skipped.push({
          name: destination.name,
          reason: "header-variable-missing",
          missingVariables: resolved.missingVariables,
        });
        continue;
      }
      headers = resolved.values;
      logHeaders = resolved.values;
    }

    const label = labelled ? destination.name : undefined;
    const policy = exporterPolicyForDestination(options.exporter, destination);
    const queues = spoolQueueNamesFor(destination.name);
    const bounds = {
      maxSpoolFiles: spoolPolicy.maxBatches,
      maxBytes: spoolPolicy.maxBytes,
      maxAgeMillis: spoolPolicy.maxAgeMillis,
      overflow: "drop-oldest" as const,
    };
    const shared = {
      providerId: options.providerId,
      installationId: options.installationId,
      clock: options.clock,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    };
    const spool =
      options.spoolRootDir === undefined || !destination.signals.traces
        ? undefined
        : createFileDurableSpool({
            rootDir: options.spoolRootDir,
            ...shared,
            ...bounds,
            queueName: queues.traces,
          });
    // Only built when logs are on: a default installation must not create a
    // directory for a signal it never emits.
    const logSpool =
      options.spoolRootDir === undefined || !destination.signals.logs
        ? undefined
        : createFileDurableLogSpool({
            rootDir: options.spoolRootDir,
            ...shared,
            ...bounds,
            queueName: queues.logs,
          });

    const metricSpool =
      options.spoolRootDir === undefined || !destination.signals.metrics
        ? undefined
        : createFileDurableMetricSpool({
            rootDir: options.spoolRootDir,
            ...shared,
            ...bounds,
            queueName: queues.metrics,
          });

    const sinkShared = {
      exporter: policy,
      ...shared,
      endpointHealth,
      ...(options.correlate === undefined ? {} : { correlate: options.correlate }),
      ...(label === undefined ? {} : { destination: label }),
    };
    const traces = destination.signals.traces
      ? createOtlpTraceSink({
          ...sinkShared,
          ...(headers === undefined || Object.keys(headers).length === 0 ? {} : { headers }),
          ...(spool === undefined ? {} : { spool }),
        })
      : createOptedOutTraceSink(label);
    const logs = createOtlpLogSink({
      ...sinkShared,
      ...(logHeaders === undefined || Object.keys(logHeaders).length === 0
        ? {}
        : { headers: logHeaders }),
      ...(logSpool === undefined ? {} : { spool: logSpool }),
      content: options.logContent,
    });
    const metrics = destination.signals.metrics
      ? createOtlpMetricSink({
          exporter: policy,
          ...shared,
          endpointHealth,
          ...(label === undefined ? {} : { destination: label }),
          ...(headers === undefined || Object.keys(headers).length === 0 ? {} : { headers }),
          ...(metricSpool === undefined ? {} : { spool: metricSpool }),
        })
      : createDisabledOtlpMetricSink(label);
    destinations.push({
      name: destination.name,
      traces,
      logs,
      metrics,
      ...(spool === undefined ? {} : { spool }),
      ...(logSpool === undefined ? {} : { logSpool }),
      ...(metricSpool === undefined ? {} : { metricSpool }),
      ...(destination.scopes === undefined
        ? {}
        : {
            scopes: destination.scopes,
            route: (events: readonly CanonicalEvent[], workspaceRepositoryKey?: string): ScopedBatch =>
              routeEventsToScopes(events, destination.scopes ?? [], {
                ...(scopedResourceKey === undefined ? {} : { resourceRepositoryKey: scopedResourceKey }),
                ...(workspaceRepositoryKey === undefined ? {} : { workspaceRepositoryKey }),
                restrict,
              }),
          }),
    });
  }
  return { destinations, skipped };
};

export type DestinationFanoutOptions = {
  /**
   * The batch's shared correlation resolver (`shareCorrelationPerBatch`), the
   * same one every sink was built with. A scoped destination resolves it over the
   * *whole* batch and aliases its subsets to that answer, so every destination is
   * served one resolution and no destination's filter changes another's span ids.
   */
  readonly correlate?: SharedCorrelationResolver;
};

/** A scoped destination's traces-then-logs emission over its own subsets. */
const createScopedFanout = (
  destination: ExportDestinationSinks,
  correlate: SharedCorrelationResolver | undefined,
): SignalFanoutSink => {
  const route = destination.route;
  const unscoped = createSignalFanout({ traces: destination.traces, logs: destination.logs });
  if (route === undefined) {
    return unscoped;
  }
  const none: TelemetryEmitResult = { accepted: 0, rejected: 0, errors: [] };
  return {
    ...unscoped,
    emit: async (events, emitOptions) => {
      const batch = route(events, emitOptions?.workspaceRepositoryKey);
      if (correlate !== undefined && (batch.traces.length > 0 || batch.logs.length > 0)) {
        // Resolve the whole batch (a memo hit when another destination already
        // did), then let this destination's subsets be served that answer.
        await correlate(events);
        correlate.alias(batch.traces, events);
        correlate.alias(batch.logs, events);
      }
      const traces = batch.traces.length === 0 ? none : await destination.traces.emit(batch.traces);
      const logs = batch.logs.length === 0 ? none : await destination.logs.emit(batch.logs);
      return {
        accepted: traces.accepted + logs.accepted,
        rejected: traces.rejected + logs.rejected,
        errors: [...traces.errors, ...logs.errors],
      };
    },
  };
};

/**
 * One canonical batch, every destination, in parallel.
 *
 * Each destination is its own {@link createSignalFanout} (traces then logs, which
 * must stay sequential so they share one correlation resolution); destinations run
 * concurrently, each bounded by the exporter's own timeout, so a slow or dead
 * destination costs at most that timeout and never another destination's delivery.
 * A destination that throws is contained to a rejection of its own share.
 *
 * Counts are summed across destinations, which gives the durability decision the
 * right inputs: everything delivered or spooled → `delivered`; nothing → `lost`
 * and safe to retry; some → `partial`, terminal, because retrying would re-export
 * to the destinations that already accepted.
 *
 * With one unscoped destination this returns that destination's fanout unchanged.
 * A scoped destination (`scopes`) is sent only its own subset of each batch,
 * per signal; see `destination-scope.ts`.
 */
export const createDestinationFanout = (
  destinations: readonly ExportDestinationSinks[],
  options: DestinationFanoutOptions = {},
): SignalFanoutSink => {
  const fanouts = destinations.map((destination) => ({
    name: destination.name,
    sink: createScopedFanout(destination, options.correlate),
  }));
  const scoped = destinations.some((destination) => destination.route !== undefined);
  const only = fanouts.length === 1 && !scoped ? fanouts[0] : undefined;
  if (only !== undefined) {
    return only.sink;
  }

  const emit = async (
    events: readonly CanonicalEvent[],
    emitOptions?: TelemetryEmitOptions,
  ): Promise<TelemetryEmitResult> => {
    const results = await Promise.all(
      fanouts.map((fanout) =>
        fanout.sink.emit(events, emitOptions).catch(
          (thrown: unknown): TelemetryEmitResult => ({
            accepted: 0,
            rejected: events.length,
            errors: [errorInfoFromThrown(thrown, { code: "telemetry-export-failure", phase: "export" })],
          }),
        ),
      ),
    );
    const errors: OtelHookErrorInfo[] = results.flatMap((result) => result.errors);
    return {
      accepted: results.reduce((sum, result) => sum + result.accepted, 0),
      rejected: results.reduce((sum, result) => sum + result.rejected, 0),
      errors,
    };
  };

  const settleAll = async (run: (sink: SignalFanoutSink) => Promise<void>): Promise<void> => {
    await Promise.all(fanouts.map((fanout) => run(fanout.sink).catch(() => undefined)));
  };

  return {
    emit,
    // Each destination drains its own spool in its flush; in parallel, so one
    // unreachable destination's drain cannot use up the others' flush window.
    flush: () => settleAll((sink) => sink.flush()),
    shutdown: () => settleAll((sink) => sink.shutdown()),
    health: (): readonly DeliveryHealthSnapshot[] => fanouts.flatMap((fanout) => fanout.sink.health()),
  };
};
