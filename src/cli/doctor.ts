import { readdir } from "node:fs/promises";
import * as path from "node:path";

import {
  describeExportDestinations,
  hasConfiguredDestinations,
  resolveDestinationHeaders,
  resolveExportDestinations,
  type DestinationDescription,
  type ExportSignal,
} from "../config/destinations.js";
import { describeResolvedConfig } from "../config/resolve.js";
import { summarizeHealth } from "../diagnostics/health.js";
import { CANONICAL_SCHEMA_VERSION } from "../model/version.js";
import { createPrivacyService } from "../privacy/service.js";
import { describeProviderCatalog } from "../providers/defaults.js";
import { createSystemClock } from "../runtime/clock.js";
import { createFilesystemStateStore } from "../state/filesystem-store.js";
import { createFileDurableLogSpool } from "../telemetry/durable-log-spool.js";
import { createFileDurableSpool } from "../telemetry/durable-spool.js";
import { describeLogsDeliverability } from "../telemetry/otlp-log-sink.js";
import { createOtlpTraceSink } from "../telemetry/otlp-sink.js";
import { spoolQueueNamesFor } from "../telemetry/export-destinations.js";
import {
  EMPTY_SPOOL_DROP_COUNTS,
  readSpoolQueueStats,
  type SpoolStats,
} from "../telemetry/spool-queue.js";
import { sanitizeSegment } from "../state/keys.js";
import type { CliDoctorCommand } from "./args.js";
import {
  createCliLogger,
  resolveCliConfig,
  resolveCliExporterHeaders,
  resolveInstallationId,
  resolveStateRootDir,
  writeLine,
  type CliIo,
} from "./context.js";
import { VERSION } from "../version.js";

export type DoctorCheck = {
  readonly name: string;
  readonly ok: boolean;
  /** Non-sensitive explanation; never an exception message. */
  readonly detail: string;
};

/**
 * One export destination as `doctor` sees it.
 *
 * Header *names* and the *names* of the environment variables they reference —
 * never a value, whether it came from the file or from the environment.
 */
export type DoctorDestination = DestinationDescription & {
  /** Referenced variables that are unset or empty, so the destination is skipped. */
  readonly missingVariables: readonly string[];
  readonly ok: boolean;
  readonly detail: string;
  /**
   * Retry spool per signal, summed over every provider namespace under this
   * installation. Absent when spooling is off or the signal is not sent here.
   */
  readonly spool?: Partial<Readonly<Record<ExportSignal, SpoolStats>>>;
};

export type DoctorReport = {
  readonly ok: boolean;
  readonly version: string;
  readonly canonicalSchemaVersion: number;
  readonly checks: readonly DoctorCheck[];
  /** Attribute-safe configuration snapshot: endpoints reduced to origin, no header values. */
  readonly config: Readonly<Record<string, unknown>>;
  readonly configNotes: readonly string[];
  readonly configWarnings: readonly { readonly code: string; readonly message: string }[];
  readonly privacyNotes: readonly string[];
  /** Local paths, for an operator diagnosing this machine. Never exported as telemetry. */
  readonly state: {
    readonly rootDir: string;
    readonly installationId: string;
    readonly writable: boolean;
    readonly spooledBatches?: number;
    /** Queued log batches awaiting retry. Absent when logs or spooling are off. */
    readonly spooledLogBatches?: number;
  };
  /** Every export destination, `default` first; disabled ones are listed too. */
  readonly destinations: readonly DoctorDestination[];
  readonly providers: readonly {
    readonly id: string;
    readonly version: string;
    readonly maturity: string;
    readonly lifecycleEvents: readonly string[];
  }[];
};

const DOCTOR_STATE_NAMESPACE = "doctor";
const PROBE_KEY = "diagnostics:doctor-probe";

/**
 * Report whether this installation could actually deliver telemetry.
 *
 * Every check is local: the state directory is probed with a real write/read/
 * delete cycle in the doctor's own namespace, and the exporter is *constructed*
 * (which is where a disabled exporter, a missing endpoint, or an unsupported
 * protocol surfaces) but never asked to send anything. A doctor that quietly
 * emitted a span to prove reachability would be a doctor that leaks data from a
 * misconfigured machine.
 */
export const collectDoctorReport = async (
  command: CliDoctorCommand,
  io: CliIo,
): Promise<DoctorReport> => {
  const resolved = await resolveCliConfig(command.policy, io);
  const logger = createCliLogger(io, resolved.config.diagnostics.logLevel);
  const clock = createSystemClock();
  const privacy = createPrivacyService(resolved.config.privacy);
  const stateRootDir = resolveStateRootDir(command.policy, io);
  const installationId = resolveInstallationId(command.policy, io);
  const checks: DoctorCheck[] = [];

  checks.push({
    name: "configuration",
    ok: !resolved.usedDefaults && resolved.warnings.length === 0,
    detail: resolved.usedDefaults
      ? "configuration could not be resolved; defaults are in force"
      : resolved.warnings.length === 0
        ? "resolved from defaults, file, environment, and flags"
        : `${String(resolved.warnings.length)} configuration warning(s)`,
  });

  const stateStore = createFilesystemStateStore({
    rootDir: stateRootDir,
    providerId: DOCTOR_STATE_NAMESPACE,
    installationId,
    clock,
    logger,
  });
  let writable = false;
  try {
    await stateStore.write(PROBE_KEY, { kind: "attributes", attributes: { probedAt: clock.now() } });
    const readBack = await stateStore.read(PROBE_KEY);
    writable = readBack?.value.kind === "attributes";
    await stateStore.delete(PROBE_KEY);
  } catch (thrown) {
    logger.warn("state directory probe failed", {
      "error.name": thrown instanceof Error ? thrown.name : typeof thrown,
    });
  }
  checks.push({
    name: "state-store",
    ok: writable,
    detail: writable
      ? "state directory is writable and a probe record round-tripped"
      : "state directory could not be written; cumulative usage will restart every invocation",
  });

  let spooledBatches: number | undefined;
  let spooledLogBatches: number | undefined;
  if (command.policy.spoolDisabled !== true) {
    const spool = createFileDurableSpool({
      rootDir: stateRootDir,
      providerId: DOCTOR_STATE_NAMESPACE,
      installationId,
      clock,
      logger,
    });
    try {
      spooledBatches = await spool.size();
    } catch {
      spooledBatches = undefined;
    }
    if (resolved.config.exporter.logs.enabled) {
      // Only probed when logs are on: `size()` creates the queue directory, and a
      // doctor run must not leave a tree behind for a signal this installation
      // never emits.
      const logSpool = createFileDurableLogSpool({
        rootDir: stateRootDir,
        providerId: DOCTOR_STATE_NAMESPACE,
        installationId,
        clock,
        logger,
      });
      try {
        spooledLogBatches = await logSpool.size();
      } catch {
        spooledLogBatches = undefined;
      }
    }
  }

  const traceHeaders = resolveCliExporterHeaders(command.policy, io).traces;
  const destinations = await describeDoctorDestinations(
    resolved.config.exporter,
    io.env,
    command.policy.spoolDisabled === true ? undefined : { rootDir: stateRootDir, installationId },
  );
  const withDestinations = hasConfiguredDestinations(resolved.config.exporter);

  const sink = createOtlpTraceSink({
    exporter: resolved.config.exporter,
    ...(Object.keys(traceHeaders).length === 0 ? {} : { headers: traceHeaders }),
    providerId: DOCTOR_STATE_NAMESPACE,
    installationId,
    clock,
    logger,
  });
  const legacyConfigured =
    resolved.config.exporter.enabled &&
    resolved.config.exporter.protocol === "http/protobuf" &&
    resolved.config.exporter.endpoint !== undefined;
  const routable = destinations.filter((destination) => destination.enabled && destination.ok);
  const exporterConfigured =
    legacyConfigured || (withDestinations && resolved.config.exporter.enabled && routable.length > 0);
  checks.push({
    name: "exporter",
    ok: exporterConfigured,
    detail: exporterConfigured
      ? withDestinations
        ? `OTLP HTTP/protobuf export to ${String(routable.length)} destination(s): ${routable
            .map((destination) => destination.name)
            .join(", ")}`
        : "OTLP HTTP/protobuf exporter is configured"
      : !resolved.config.exporter.enabled
        ? "exporter is disabled; events are accepted and discarded"
        : resolved.config.exporter.endpoint === undefined && !withDestinations
          ? "exporter is enabled but no endpoint is configured"
          : withDestinations
            ? "exporter.destinations is set but no destination can be sent to"
          : `protocol ${resolved.config.exporter.protocol} is not supported by this build`,
  });
  /**
   * The logs signal, reported separately and never as a failure when it is simply
   * off.
   *
   * `ok` is true for a deliberately disabled pipeline, because `doctor` exiting
   * non-zero on the default configuration would make the check useless. What it
   * distinguishes is "off" from "asked for and unroutable", which is the state an
   * operator cannot otherwise see: the sink degrades to a no-op that accepts
   * everything, so a wrong endpoint looks exactly like success.
   */
  const logs = describeLogsDeliverability(resolved.config.exporter);
  checks.push({
    name: "logs-exporter",
    ok: logs.status === "configured" || logs.reason === "logs-disabled",
    detail:
      logs.status === "configured"
        ? `OTLP HTTP/protobuf logs exporter is configured${logs.derivedEndpoint ? " (endpoint derived from the trace endpoint)" : ""}; content ${
            resolved.config.exporter.logs.includeContent ? "permitted" : "disabled"
          }`
        : logs.reason === "logs-disabled"
          ? "logs are disabled; only traces are exported"
          : logs.reason === "no-endpoint"
            ? "logs are enabled but no endpoint is configured and none could be derived"
            : `logs are enabled but unroutable: ${logs.reason}`,
  });

  if (withDestinations) {
    const failing = destinations.filter((destination) => destination.enabled && !destination.ok);
    checks.push({
      name: "destinations",
      ok: failing.length === 0,
      detail:
        failing.length === 0
          ? `${String(destinations.filter((destination) => destination.enabled).length)} enabled destination(s) resolve`
          : failing.map((destination) => `${destination.name}: ${destination.detail}`).join("; "),
    });
  }

  const health = summarizeHealth([sink.health()]);
  await sink.shutdown();

  checks.push({
    name: "privacy",
    ok: resolved.config.privacy.contentMode === "omit" || resolved.config.privacy.allowRawContent,
    detail: `content mode is "${privacy.policy.contentMode}"${
      privacy.policyNotes.length === 0 ? "" : `; ${privacy.policyNotes.join("; ")}`
    }`,
  });

  const providers = describeProviderCatalog({
    includeExperimental: command.policy.includeExperimental ?? true,
  });
  checks.push({
    name: "providers",
    ok: providers.length > 0,
    detail: `${String(providers.length)} adapter(s) registered`,
  });

  return {
    ok: checks.every((check) => check.ok) && health.healthy,
    version: VERSION,
    canonicalSchemaVersion: CANONICAL_SCHEMA_VERSION,
    checks,
    config: describeResolvedConfig(resolved.config),
    configNotes: resolved.notes,
    configWarnings: resolved.warnings.map((warning) => ({
      code: warning.code,
      message: warning.message,
    })),
    privacyNotes: privacy.policyNotes,
    state: {
      rootDir: stateRootDir,
      installationId,
      writable,
      ...(spooledBatches === undefined ? {} : { spooledBatches }),
      ...(spooledLogBatches === undefined ? {} : { spooledLogBatches }),
    },
    destinations,
    providers: providers.map((entry) => ({
      id: entry.id,
      version: entry.version,
      maturity: entry.maturity,
      lifecycleEvents: entry.lifecycleEvents,
    })),
  };
};

const formatBytes = (bytes: number): string =>
  bytes < 1024 ? `${String(bytes)} B` : `${(bytes / 1024).toFixed(1)} KiB`;

const describeDestinationLine = (destination: DoctorDestination): string => {
  const parts: string[] = [];
  parts.push(destination.enabled ? destination.signals.join("+") || "no signals" : "disabled");
  if (destination.tracesEndpointOrigin !== undefined) {
    parts.push(`traces -> ${destination.tracesEndpointOrigin}`);
  }
  if (destination.logsEndpointOrigin !== undefined) {
    parts.push(`logs -> ${destination.logsEndpointOrigin}`);
  }
  if (destination.headerNames.length > 0) {
    parts.push(`headers ${destination.headerNames.join(", ")}`);
  }
  if (destination.missingVariables.length > 0) {
    parts.push(`MISSING ${destination.missingVariables.join(", ")}`);
  }
  for (const [signal, stats] of Object.entries(destination.spool ?? {})) {
    if (stats.batches > 0 || stats.dropped.total > 0) {
      const dropped = stats.dropped;
      parts.push(
        `${signal} spool ${String(stats.batches)} batch(es) ${formatBytes(stats.bytes)}, dropped ${String(
          dropped.total,
        )} (age ${String(dropped.age)}, size ${String(dropped.size)}, count ${String(
          dropped.count,
        )}, rejected ${String(dropped.rejected)})`,
      );
    }
  }
  return `${destination.ok ? "ok  " : "FAIL"} destination ${destination.name}: ${parts.join("; ")}`;
};

const sumSpoolStats = (all: readonly SpoolStats[]): SpoolStats => {
  const oldest = all
    .map((stats) => stats.oldestEnqueuedAt)
    .filter((value): value is number => value !== undefined);
  const lastDropped = all
    .map((stats) => stats.dropped.lastDroppedAt)
    .filter((value): value is number => value !== undefined);
  return {
    batches: all.reduce((sum, stats) => sum + stats.batches, 0),
    bytes: all.reduce((sum, stats) => sum + stats.bytes, 0),
    ...(oldest.length === 0 ? {} : { oldestEnqueuedAt: Math.min(...oldest) }),
    dropped: {
      total: all.reduce((sum, stats) => sum + stats.dropped.total, 0),
      age: all.reduce((sum, stats) => sum + stats.dropped.age, 0),
      size: all.reduce((sum, stats) => sum + stats.dropped.size, 0),
      count: all.reduce((sum, stats) => sum + stats.dropped.count, 0),
      rejected: all.reduce((sum, stats) => sum + stats.dropped.rejected, 0),
      ...(lastDropped.length === 0 ? {} : { lastDroppedAt: Math.max(...lastDropped) }),
    },
  };
};

/**
 * Spool depth and drops for one queue, across every provider namespace.
 *
 * The hook spools under the provider it ran as, and `doctor` is not told which
 * providers run here — so it reads every namespace directory under this
 * installation. Read-only: nothing is created.
 */
const inspectQueue = async (
  spool: { readonly rootDir: string; readonly installationId: string },
  queueName: string,
): Promise<SpoolStats> => {
  let namespaces: string[];
  try {
    namespaces = await readdir(spool.rootDir);
  } catch {
    namespaces = [];
  }
  const installation = sanitizeSegment(spool.installationId);
  const stats = await Promise.all(
    namespaces.map((namespace) =>
      readSpoolQueueStats(path.join(spool.rootDir, namespace, installation, queueName)),
    ),
  );
  return stats.length === 0
    ? { batches: 0, bytes: 0, dropped: EMPTY_SPOOL_DROP_COUNTS }
    : sumSpoolStats(stats);
};

const describeDoctorDestinations = async (
  exporter: Parameters<typeof describeExportDestinations>[0],
  environment: Readonly<Record<string, string | undefined>>,
  spool: { readonly rootDir: string; readonly installationId: string } | undefined,
): Promise<readonly DoctorDestination[]> => {
  const configured = new Map(
    (exporter.destinations ?? []).map((destination) => [destination.name, destination]),
  );
  const resolvedNames = new Set(resolveExportDestinations(exporter).map((destination) => destination.name));
  const descriptions = describeExportDestinations(exporter);
  return Promise.all(
    descriptions.map(async (description): Promise<DoctorDestination> => {
      const headers = configured.get(description.name)?.headers ?? {};
      // Resolved only to learn which variables are missing; the values are dropped
      // on the floor here and never reach the report.
      const missingVariables = resolveDestinationHeaders(headers, environment).missingVariables;
      const sends = description.signals.length > 0;
      const reachable =
        (description.signals.includes("traces") && description.tracesEndpointOrigin !== undefined) ||
        (description.signals.includes("logs") && description.logsEndpointOrigin !== undefined);
      let detail = "resolves";
      let ok = true;
      if (!description.enabled) {
        detail = "disabled";
      } else if (missingVariables.length > 0) {
        ok = false;
        detail = `header variable(s) not set: ${missingVariables.join(", ")}; skipped until they are`;
      } else if (description.protocol !== "http/protobuf") {
        ok = description.protocol === "none";
        detail =
          description.protocol === "none"
            ? "protocol is none; nothing is sent"
            : `protocol ${description.protocol} is not supported by this build`;
      } else if (!sends || !reachable) {
        ok = false;
        detail = "no endpoint for any signal it receives";
      }
      const queues = spoolQueueNamesFor(description.name);
      const spoolStats =
        spool === undefined || !resolvedNames.has(description.name)
          ? undefined
          : {
              ...(description.signals.includes("traces")
                ? { traces: await inspectQueue(spool, queues.traces) }
                : {}),
              ...(description.signals.includes("logs")
                ? { logs: await inspectQueue(spool, queues.logs) }
                : {}),
            };
      return {
        ...description,
        missingVariables,
        ok,
        detail,
        ...(spoolStats === undefined ? {} : { spool: spoolStats }),
      };
    }),
  );
};

export const runDoctorCommand = async (command: CliDoctorCommand, io: CliIo): Promise<number> => {
  const report = await collectDoctorReport(command, io);

  if (command.json) {
    writeLine(io.stdout, JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }

  writeLine(io.stdout, `otel-hook ${report.version} (canonical schema v${String(report.canonicalSchemaVersion)})`);
  writeLine(io.stdout, "");
  for (const check of report.checks) {
    writeLine(io.stdout, `${check.ok ? "ok  " : "FAIL"} ${check.name.padEnd(14)} ${check.detail}`);
  }
  writeLine(io.stdout, "");
  writeLine(io.stdout, `state directory: ${report.state.rootDir}`);
  writeLine(io.stdout, `installation id: ${report.state.installationId}`);
  if (report.state.spooledBatches !== undefined) {
    writeLine(io.stdout, `spooled batches: ${String(report.state.spooledBatches)}`);
  }
  if (report.state.spooledLogBatches !== undefined) {
    writeLine(io.stdout, `spooled log batches: ${String(report.state.spooledLogBatches)}`);
  }
  // A single-destination installation prints exactly what it always has, unless its
  // spool has something to say: queued batches or drops.
  const listDestinations =
    report.config["exporter.destination_names"] !== undefined ||
    report.destinations.some((destination) =>
      Object.values(destination.spool ?? {}).some(
        (stats) => stats.dropped.total > 0,
      ),
    );
  if (listDestinations) {
    for (const destination of report.destinations) {
      writeLine(io.stdout, describeDestinationLine(destination));
    }
  }
  for (const note of report.configNotes) {
    writeLine(io.stdout, `note: ${note}`);
  }
  for (const warning of report.configWarnings) {
    writeLine(io.stdout, `warning: ${warning.message}`);
  }
  writeLine(io.stdout, "");
  writeLine(io.stdout, `providers: ${report.providers.map((entry) => `${entry.id} (${entry.maturity})`).join(", ")}`);
  return report.ok ? 0 : 1;
};
