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
import type { CliDoctorCommand } from "./args.js";
import {
  createCliLogger,
  resolveCliConfig,
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

  const sink = createOtlpTraceSink({
    exporter: resolved.config.exporter,
    ...(Object.keys(command.policy.headers).length === 0
      ? {}
      : { headers: command.policy.headers }),
    providerId: DOCTOR_STATE_NAMESPACE,
    installationId,
    clock,
    logger,
  });
  const exporterConfigured =
    resolved.config.exporter.enabled &&
    resolved.config.exporter.protocol === "http/protobuf" &&
    resolved.config.exporter.endpoint !== undefined;
  checks.push({
    name: "exporter",
    ok: exporterConfigured,
    detail: exporterConfigured
      ? "OTLP HTTP/protobuf exporter is configured"
      : !resolved.config.exporter.enabled
        ? "exporter is disabled; events are accepted and discarded"
        : resolved.config.exporter.endpoint === undefined
          ? "exporter is enabled but no endpoint is configured"
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
    providers: providers.map((entry) => ({
      id: entry.id,
      version: entry.version,
      maturity: entry.maturity,
      lifecycleEvents: entry.lifecycleEvents,
    })),
  };
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
