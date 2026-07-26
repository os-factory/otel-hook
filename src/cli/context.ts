import { readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Readable, Writable } from "node:stream";

import { parseEnvironmentConfig } from "../config/environment.js";
import { resolveConfig, type ConfigLayer, type ConfigProvenance } from "../config/resolve.js";
import { DEFAULT_CONFIG, type OtelHookConfig, type OtelHookConfigPatch } from "../config/schema.js";
import { createErrorInfo, type OtelHookErrorInfo } from "../errors/index.js";
import { createStderrLogger } from "../runtime/logger.js";
import type { LogLevel, Logger } from "../runtime/ports.js";
import type { CliPolicyFlags } from "./args.js";

/**
 * Everything the CLI is allowed to touch, passed in rather than reached for.
 *
 * `env` is read-only and never written back: no command mutates the process
 * environment, and no environment variable carries identity (ADR 0001). Streams
 * are injected so the whole CLI is testable in-process, and so nothing can write
 * to stdout by accident — only the run command's provider response does.
 */
export type CliIo = {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
  /** Used only for the default state directory; never exported. */
  readonly homeDir?: string;
  readonly tmpDir?: string;
};

export const writeLine = (stream: Writable, text: string): void => {
  stream.write(`${text}\n`);
};

/** Environment variables the CLI reads in addition to the library's own. */
export const CLI_ENVIRONMENT_VARIABLES = Object.freeze({
  stateDir: "OTEL_HOOK_STATE_DIR",
  installationId: "OTEL_HOOK_INSTALLATION_ID",
  xdgStateHome: "XDG_STATE_HOME",
});

export const DEFAULT_INSTALLATION_ID = "default";

/**
 * Where session state and the retry spool live.
 *
 * Resolution order is explicit flag, then `OTEL_HOOK_STATE_DIR`, then the XDG
 * state directory, then a temp-directory fallback. The path is used only to open
 * files: it never becomes a workspace id, an attribute, or part of an event.
 */
export const resolveStateRootDir = (policy: CliPolicyFlags, io: CliIo): string => {
  if (policy.stateDir !== undefined) {
    return path.resolve(policy.stateDir);
  }
  const fromEnv = io.env[CLI_ENVIRONMENT_VARIABLES.stateDir];
  if (fromEnv !== undefined && fromEnv.trim().length > 0) {
    return path.resolve(fromEnv.trim());
  }
  const xdg = io.env[CLI_ENVIRONMENT_VARIABLES.xdgStateHome];
  if (xdg !== undefined && xdg.trim().length > 0) {
    return path.join(path.resolve(xdg.trim()), "otel-hook");
  }
  const home = io.homeDir ?? os.homedir();
  if (home.length > 0) {
    return path.join(home, ".local", "state", "otel-hook");
  }
  return path.join(io.tmpDir ?? os.tmpdir(), "otel-hook-state");
};

export const resolveInstallationId = (policy: CliPolicyFlags, io: CliIo): string => {
  const explicit = policy.installationId ?? io.env[CLI_ENVIRONMENT_VARIABLES.installationId];
  const trimmed = explicit?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : DEFAULT_INSTALLATION_ID;
};

/** Configuration patch expressed by CLI policy flags. Carries no identity field. */
export const policyFlagsToPatch = (policy: CliPolicyFlags): OtelHookConfigPatch => {
  const headerNames = Object.keys(policy.headers).sort();
  const exporter = {
    ...(policy.exportDisabled === true ? { enabled: false } : {}),
    ...(policy.endpoint === undefined ? {} : { endpoint: policy.endpoint }),
    ...(policy.protocol === undefined ? {} : { protocol: policy.protocol }),
    ...(policy.serviceName === undefined ? {} : { serviceName: policy.serviceName }),
    ...(policy.serviceNamespace === undefined ? {} : { serviceNamespace: policy.serviceNamespace }),
    ...(policy.timeoutMillis === undefined ? {} : { timeoutMillis: policy.timeoutMillis }),
    // Only header *names* reach configuration; the values stay in CliPolicyFlags
    // and are handed straight to the sink, so a resolved-config snapshot (which
    // is logged and exported) cannot leak a credential.
    ...(headerNames.length === 0 ? {} : { headerNames }),
    // Resource attribute *values* do belong in configuration: unlike a header
    // value they are exported on every span by design, so there is nothing to
    // keep out of the snapshot. The snapshot still reports names only.
    ...(Object.keys(policy.resourceAttributes).length === 0
      ? {}
      : { resourceAttributes: policy.resourceAttributes }),
  };
  const privacy = policy.contentMode === undefined ? {} : { contentMode: policy.contentMode };
  const diagnostics = policy.logLevel === undefined ? {} : { logLevel: policy.logLevel };
  return {
    ...(Object.keys(exporter).length === 0 ? {} : { exporter }),
    ...(Object.keys(privacy).length === 0 ? {} : { privacy }),
    ...(Object.keys(diagnostics).length === 0 ? {} : { diagnostics }),
  } as OtelHookConfigPatch;
};

export type ResolvedCliConfig = {
  readonly config: OtelHookConfig;
  readonly provenance?: ConfigProvenance;
  readonly notes: readonly string[];
  /** Reported, never fatal: a bad layer falls back to DEFAULT_CONFIG. */
  readonly warnings: readonly OtelHookErrorInfo[];
  readonly usedDefaults: boolean;
};

const readJsonFile = async (
  filePath: string,
): Promise<{ readonly value: unknown } | { readonly error: OtelHookErrorInfo }> => {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (thrown) {
    return {
      error: createErrorInfo({
        code: "configuration-invalid",
        phase: "configuration",
        // The basename is safe to name; the full path is not.
        detail: `could not read ${path.basename(filePath)}`,
        details: {
          "config.origin": path.basename(filePath),
          "error.name": thrown instanceof Error ? thrown.name : typeof thrown,
        },
      }),
    };
  }
  try {
    return { value: JSON.parse(raw) as unknown };
  } catch {
    return {
      error: createErrorInfo({
        code: "configuration-invalid",
        phase: "configuration",
        detail: `${path.basename(filePath)} is not well-formed JSON`,
        details: { "config.origin": path.basename(filePath) },
      }),
    };
  }
};

/**
 * Resolve configuration from file, environment, and flags.
 *
 * An unusable layer is reported and the whole resolution falls back to
 * `DEFAULT_CONFIG` rather than being partially applied: a half-applied privacy
 * policy is exactly what the configuration contract exists to prevent. Falling
 * back rather than exiting keeps the hook fail-open (ADR 0004).
 */
export const resolveCliConfig = async (
  policy: CliPolicyFlags,
  io: CliIo,
): Promise<ResolvedCliConfig> => {
  const warnings: OtelHookErrorInfo[] = [];
  const layers: ConfigLayer[] = [];

  if (policy.configFile !== undefined) {
    const read = await readJsonFile(path.resolve(policy.configFile));
    if ("error" in read) {
      warnings.push(read.error);
    } else {
      layers.push({
        source: "file",
        patch: read.value as OtelHookConfigPatch,
        origin: path.basename(policy.configFile),
      });
    }
  }

  const environment = parseEnvironmentConfig(io.env);
  warnings.push(...environment.warnings);
  layers.push({ source: "environment", patch: environment.patch });
  layers.push({ source: "inline-override", patch: policyFlagsToPatch(policy) });

  const resolution = resolveConfig(layers);
  if (resolution.status !== "ok") {
    warnings.push(...resolution.errors);
    return { config: DEFAULT_CONFIG, notes: [], warnings, usedDefaults: true };
  }
  return {
    config: resolution.config,
    provenance: resolution.provenance,
    notes: resolution.notes,
    warnings,
    usedDefaults: false,
  };
};

export const createCliLogger = (io: CliIo, level: LogLevel): Logger =>
  createStderrLogger({
    level,
    write: (line: string): void => {
      io.stderr.write(line);
    },
  });

export const readIdentityFile = readJsonFile;
