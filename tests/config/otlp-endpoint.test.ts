import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { parseCliArgs } from "../../src/cli/args.js";
import { resolveCliConfig, type CliIo } from "../../src/cli/context.js";
import {
  OTLP_ENDPOINT_VARIABLES,
  otlpSignalEndpointFromBase,
  parseEnvironmentConfig,
  type EnvironmentRecord,
} from "../../src/index.js";
import { resolveLogsEndpoint } from "../../src/telemetry/otlp-log-sink.js";

/**
 * Endpoint resolution per the OpenTelemetry exporter specification:
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is a base URL with the signal path appended,
 * the per-signal variables are used as-is, and otel-hook's own
 * `OTEL_HOOK_EXPORTER_ENDPOINT` / `--endpoint` keep their precedence above both.
 */

const BASE = "https://collector.example:4318";

describe("otlpSignalEndpointFromBase", () => {
  it("appends the signal path to a base URL", () => {
    expect(otlpSignalEndpointFromBase(BASE, "traces")).toBe(`${BASE}/v1/traces`);
    expect(otlpSignalEndpointFromBase(BASE, "logs")).toBe(`${BASE}/v1/logs`);
  });

  it("keeps a base path and drops trailing slashes before appending", () => {
    expect(otlpSignalEndpointFromBase(`${BASE}/otlp/`, "traces")).toBe(`${BASE}/otlp/v1/traces`);
    expect(otlpSignalEndpointFromBase(`${BASE}//`, "logs")).toBe(`${BASE}/v1/logs`);
  });

  it("uses a legacy full traces URL as-is, and swaps its suffix for logs", () => {
    expect(otlpSignalEndpointFromBase(`${BASE}/v1/traces`, "traces")).toBe(`${BASE}/v1/traces`);
    expect(otlpSignalEndpointFromBase(`${BASE}/v1/traces/`, "traces")).toBe(`${BASE}/v1/traces`);
    expect(otlpSignalEndpointFromBase(`${BASE}/v1/traces`, "logs")).toBe(`${BASE}/v1/logs`);
  });

  it("names the three standard variables", () => {
    expect(OTLP_ENDPOINT_VARIABLES).toEqual({
      generic: "OTEL_EXPORTER_OTLP_ENDPOINT",
      traces: "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
      logs: "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
    });
  });
});

const exporterOf = (env: EnvironmentRecord) => {
  const { patch, warnings } = parseEnvironmentConfig(env);
  expect(warnings).toEqual([]);
  return patch.exporter;
};

describe("environment endpoint resolution", () => {
  it("treats OTEL_EXPORTER_OTLP_ENDPOINT as a base URL", () => {
    const exporter = exporterOf({ OTEL_EXPORTER_OTLP_ENDPOINT: BASE });
    expect(exporter?.endpoint).toBe(`${BASE}/v1/traces`);
    // Logs are derived from the traces URL by the sink: same result as the spec.
    expect(exporter?.logs).toBeUndefined();
  });

  it("keeps a legacy full traces URL in OTEL_EXPORTER_OTLP_ENDPOINT working", () => {
    const exporter = exporterOf({ OTEL_EXPORTER_OTLP_ENDPOINT: `${BASE}/v1/traces` });
    expect(exporter?.endpoint).toBe(`${BASE}/v1/traces`);
  });

  it("uses OTEL_EXPORTER_OTLP_TRACES_ENDPOINT as-is", () => {
    const langfuse = "https://langfuse.example/api/public/otel/v1/traces";
    expect(exporterOf({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: langfuse })?.endpoint).toBe(langfuse);
    // No signal path is appended to a per-signal URL, even one without /v1/traces.
    const custom = "https://collector.example/custom/traces";
    expect(exporterOf({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: custom })?.endpoint).toBe(custom);
  });

  it("prefers OTEL_EXPORTER_OTLP_TRACES_ENDPOINT over the base for traces only", () => {
    const exporter = exporterOf({
      OTEL_EXPORTER_OTLP_ENDPOINT: BASE,
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://traces.example/ingest",
    });
    expect(exporter?.endpoint).toBe("https://traces.example/ingest");
    // The base still sets the logs endpoint, per the specification.
    expect(exporter?.logs?.endpoint).toBe(`${BASE}/v1/logs`);
  });

  it("prefers OTEL_EXPORTER_OTLP_LOGS_ENDPOINT over the base for logs", () => {
    const exporter = exporterOf({
      OTEL_EXPORTER_OTLP_ENDPOINT: BASE,
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://traces.example/ingest",
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://logs.example/ingest",
    });
    expect(exporter?.endpoint).toBe("https://traces.example/ingest");
    expect(exporter?.logs?.endpoint).toBe("https://logs.example/ingest");
  });

  it("keeps OTEL_HOOK_EXPORTER_ENDPOINT above every standard variable", () => {
    const exporter = exporterOf({
      OTEL_HOOK_EXPORTER_ENDPOINT: "https://hook.example/v1/traces",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://traces.example/ingest",
      OTEL_EXPORTER_OTLP_ENDPOINT: BASE,
    });
    expect(exporter?.endpoint).toBe("https://hook.example/v1/traces");
    // As before, logs follow otel-hook's own endpoint rather than the base.
    expect(exporter?.logs).toBeUndefined();
  });

  it("keeps OTEL_HOOK_LOGS_ENDPOINT above every standard logs variable", () => {
    const exporter = exporterOf({
      OTEL_HOOK_LOGS_ENDPOINT: "https://hook.example/v1/logs",
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://logs.example/ingest",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://traces.example/ingest",
      OTEL_EXPORTER_OTLP_ENDPOINT: BASE,
    });
    expect(exporter?.logs?.endpoint).toBe("https://hook.example/v1/logs");
  });

  it("ignores blank values", () => {
    const exporter = exporterOf({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "  ",
      OTEL_EXPORTER_OTLP_ENDPOINT: BASE,
    });
    expect(exporter?.endpoint).toBe(`${BASE}/v1/traces`);
    expect(exporter?.logs).toBeUndefined();
  });
});

const ioWith = (env: EnvironmentRecord): CliIo => ({
  argv: [],
  env,
  stdin: new PassThrough(),
  stdout: new PassThrough(),
  stderr: new PassThrough(),
});

const resolvedExporter = async (argv: readonly string[], env: EnvironmentRecord) => {
  const parsed = parseCliArgs(["run", ...argv]);
  if (parsed.status !== "command" || parsed.command.name !== "run") {
    throw new Error("expected a run command");
  }
  const resolved = await resolveCliConfig(parsed.command.policy, ioWith(env));
  expect(resolved.usedDefaults).toBe(false);
  return resolved.config.exporter;
};

describe("CLI endpoint precedence", () => {
  it("lets --endpoint override every endpoint variable, with logs derived from it", async () => {
    const exporter = await resolvedExporter(["--endpoint", "https://flag.example/v1/traces"], {
      OTEL_HOOK_EXPORTER_ENDPOINT: "https://hook.example/v1/traces",
      OTEL_EXPORTER_OTLP_ENDPOINT: BASE,
    });
    expect(exporter.endpoint).toBe("https://flag.example/v1/traces");
    expect(resolveLogsEndpoint(exporter)).toEqual({
      endpoint: "https://flag.example/v1/logs",
      derived: true,
    });
  });

  it("posts both signals under the base when only OTEL_EXPORTER_OTLP_ENDPOINT is set", async () => {
    const exporter = await resolvedExporter([], { OTEL_EXPORTER_OTLP_ENDPOINT: `${BASE}/` });
    expect(exporter.endpoint).toBe(`${BASE}/v1/traces`);
    expect(resolveLogsEndpoint(exporter)).toEqual({ endpoint: `${BASE}/v1/logs`, derived: true });
  });
});
