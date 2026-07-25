import { createErrorInfo, type OtelHookErrorInfo } from "../errors/index.js";
import { detectionConfidenceSchema } from "../model/primitives.js";
import { contentModeSchema } from "../privacy/policy.js";
import type { OtelHookConfigPatch } from "./schema.js";

export type EnvironmentRecord = Readonly<Record<string, string | undefined>>;

export type EnvironmentConfigResult = {
  readonly patch: OtelHookConfigPatch;
  /**
   * Unusable variables are reported and skipped rather than failing resolution.
   * The environment is ambient: a stale variable in a shell profile must not
   * disable telemetry, and it must not silently change privacy either — hence
   * the warning.
   */
  readonly warnings: readonly OtelHookErrorInfo[];
};

/**
 * Environment variables read by the library.
 *
 * No identity variable appears here by design: session, invocation, and
 * workspace identity are supplied per invocation as identity claims, never
 * through ambient configuration (ADR 0001).
 */
export const ENVIRONMENT_VARIABLES = Object.freeze({
  exporterEnabled: "OTEL_HOOK_ENABLED",
  exporterEndpoint: "OTEL_HOOK_EXPORTER_ENDPOINT",
  otlpEndpoint: "OTEL_EXPORTER_OTLP_ENDPOINT",
  exporterProtocol: "OTEL_HOOK_EXPORTER_PROTOCOL",
  exporterTimeoutMillis: "OTEL_HOOK_EXPORTER_TIMEOUT_MS",
  serviceName: "OTEL_HOOK_SERVICE_NAME",
  serviceNamespace: "OTEL_HOOK_SERVICE_NAMESPACE",
  contentMode: "OTEL_HOOK_CONTENT_MODE",
  allowRawContent: "OTEL_HOOK_ALLOW_RAW_CONTENT",
  hashSalt: "OTEL_HOOK_HASH_SALT",
  maxStringLength: "OTEL_HOOK_MAX_STRING_LENGTH",
  maxDepth: "OTEL_HOOK_MAX_DEPTH",
  maxArrayLength: "OTEL_HOOK_MAX_ARRAY_LENGTH",
  maxEventsPerInvocation: "OTEL_HOOK_MAX_EVENTS_PER_INVOCATION",
  minimumConfidence: "OTEL_HOOK_MIN_DETECTION_CONFIDENCE",
  logLevel: "OTEL_HOOK_LOG_LEVEL",
});

const BOOLEAN_TRUE = new Set(["1", "true", "yes", "on"]);
const BOOLEAN_FALSE = new Set(["0", "false", "no", "off"]);

/**
 * Read configuration from an environment record.
 *
 * Pure: the process environment is never read implicitly, which keeps tests and
 * hosted embeddings from inheriting the developer's shell.
 */
export const parseEnvironmentConfig = (env: EnvironmentRecord): EnvironmentConfigResult => {
  const warnings: OtelHookErrorInfo[] = [];
  const warn = (variable: string, detail: string): void => {
    warnings.push(
      createErrorInfo({
        code: "configuration-invalid",
        phase: "configuration",
        detail: `${variable}: ${detail}`,
        details: { "config.variable": variable },
      }),
    );
  };

  const readBoolean = (variable: string): boolean | undefined => {
    const raw = env[variable];
    if (raw === undefined || raw === "") {
      return undefined;
    }
    const normalized = raw.trim().toLowerCase();
    if (BOOLEAN_TRUE.has(normalized)) {
      return true;
    }
    if (BOOLEAN_FALSE.has(normalized)) {
      return false;
    }
    warn(variable, "expected a boolean");
    return undefined;
  };

  const readInteger = (variable: string): number | undefined => {
    const raw = env[variable];
    if (raw === undefined || raw === "") {
      return undefined;
    }
    const value = Number(raw.trim());
    if (!Number.isInteger(value) || value < 0) {
      warn(variable, "expected a non-negative integer");
      return undefined;
    }
    return value;
  };

  const readString = (variable: string): string | undefined => {
    const raw = env[variable];
    if (raw === undefined) {
      return undefined;
    }
    const trimmed = raw.trim();
    return trimmed === "" ? undefined : trimmed;
  };

  const exporterEnabled = readBoolean(ENVIRONMENT_VARIABLES.exporterEnabled);
  const endpoint =
    readString(ENVIRONMENT_VARIABLES.exporterEndpoint) ??
    readString(ENVIRONMENT_VARIABLES.otlpEndpoint);
  const timeoutMillis = readInteger(ENVIRONMENT_VARIABLES.exporterTimeoutMillis);
  const serviceName = readString(ENVIRONMENT_VARIABLES.serviceName);
  const serviceNamespace = readString(ENVIRONMENT_VARIABLES.serviceNamespace);

  const protocolRaw = readString(ENVIRONMENT_VARIABLES.exporterProtocol);
  let protocol: "http/protobuf" | "http/json" | "none" | undefined;
  if (protocolRaw !== undefined) {
    if (protocolRaw === "http/protobuf" || protocolRaw === "http/json" || protocolRaw === "none") {
      protocol = protocolRaw;
    } else {
      warn(ENVIRONMENT_VARIABLES.exporterProtocol, "expected http/protobuf, http/json, or none");
    }
  }

  const contentModeRaw = readString(ENVIRONMENT_VARIABLES.contentMode);
  const contentModeParsed =
    contentModeRaw === undefined ? undefined : contentModeSchema.safeParse(contentModeRaw);
  if (contentModeParsed !== undefined && !contentModeParsed.success) {
    warn(ENVIRONMENT_VARIABLES.contentMode, "expected omit, mask, redact, or raw");
  }

  const confidenceRaw = readString(ENVIRONMENT_VARIABLES.minimumConfidence);
  const confidenceParsed =
    confidenceRaw === undefined ? undefined : detectionConfidenceSchema.safeParse(confidenceRaw);
  if (confidenceParsed !== undefined && !confidenceParsed.success) {
    warn(ENVIRONMENT_VARIABLES.minimumConfidence, "expected none, weak, strong, or exact");
  }

  const logLevelRaw = readString(ENVIRONMENT_VARIABLES.logLevel);
  const logLevels = ["silent", "error", "warn", "info", "debug"] as const;
  type LogLevel = (typeof logLevels)[number];
  let logLevel: LogLevel | undefined;
  if (logLevelRaw !== undefined) {
    const match = logLevels.find((level) => level === logLevelRaw);
    if (match === undefined) {
      warn(ENVIRONMENT_VARIABLES.logLevel, `expected one of ${logLevels.join(", ")}`);
    } else {
      logLevel = match;
    }
  }

  const allowRawContent = readBoolean(ENVIRONMENT_VARIABLES.allowRawContent);
  const hashSalt = readString(ENVIRONMENT_VARIABLES.hashSalt);
  const maxStringLength = readInteger(ENVIRONMENT_VARIABLES.maxStringLength);
  const maxDepth = readInteger(ENVIRONMENT_VARIABLES.maxDepth);
  const maxArrayLength = readInteger(ENVIRONMENT_VARIABLES.maxArrayLength);
  const maxEventsPerInvocation = readInteger(ENVIRONMENT_VARIABLES.maxEventsPerInvocation);

  const exporter = {
    ...(exporterEnabled === undefined ? {} : { enabled: exporterEnabled }),
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(protocol === undefined ? {} : { protocol }),
    ...(timeoutMillis === undefined ? {} : { timeoutMillis }),
    ...(serviceName === undefined ? {} : { serviceName }),
    ...(serviceNamespace === undefined ? {} : { serviceNamespace }),
  };

  const limits = {
    ...(maxStringLength === undefined ? {} : { maxStringLength }),
    ...(maxDepth === undefined ? {} : { maxDepth }),
    ...(maxArrayLength === undefined ? {} : { maxArrayLength }),
    ...(maxEventsPerInvocation === undefined ? {} : { maxEventsPerInvocation }),
  };

  const privacy = {
    ...(contentModeParsed?.success === true ? { contentMode: contentModeParsed.data } : {}),
    ...(allowRawContent === undefined ? {} : { allowRawContent }),
    ...(hashSalt === undefined ? {} : { hashSalt }),
    ...(Object.keys(limits).length === 0 ? {} : { limits }),
  };

  const detection =
    confidenceParsed?.success === true ? { minimumConfidence: confidenceParsed.data } : {};

  const diagnostics = logLevel === undefined ? {} : { logLevel };

  const patch: OtelHookConfigPatch = {
    ...(Object.keys(exporter).length === 0 ? {} : { exporter }),
    ...(Object.keys(privacy).length === 0 ? {} : { privacy }),
    ...(Object.keys(detection).length === 0 ? {} : { detection }),
    ...(Object.keys(diagnostics).length === 0 ? {} : { diagnostics }),
  };

  return { patch, warnings };
};
