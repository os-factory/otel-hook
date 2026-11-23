import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { parseCliArgs, type CliPolicyFlags } from "../../src/cli/args.js";
import { resolveCliConfig, resolveCliExporterHeaders, type CliIo } from "../../src/cli/context.js";
import {
  describeResolvedConfig,
  MAX_OTLP_HEADERS,
  mergeOtlpHeaders,
  OTLP_HEADER_VARIABLES,
  parseEnvironmentConfig,
  parseOtlpHeadersValue,
  resolveOtlpHeaders,
} from "../../src/index.js";

const SECRET = "c2stbGYtc2VjcmV0OnNrLWxmLXZhbHVl";

const policyOf = (argv: readonly string[]): CliPolicyFlags => {
  const parsed = parseCliArgs(["run", ...argv]);
  if (parsed.status !== "command" || parsed.command.name !== "run") {
    throw new Error(`expected a run command, got ${JSON.stringify(parsed)}`);
  }
  return parsed.command.policy;
};

const ioWith = (env: Record<string, string>): CliIo => ({
  argv: [],
  env,
  stdin: new PassThrough(),
  stdout: new PassThrough(),
  stderr: new PassThrough(),
});

describe("parseOtlpHeadersValue", () => {
  it("parses comma-separated key=value pairs and trims whitespace", () => {
    expect(parseOtlpHeadersValue(" api-key = one ,  x-tenant=two ")).toEqual({
      headers: { "api-key": "one", "x-tenant": "two" },
      warnings: [],
    });
  });

  it("percent-decodes keys and values", () => {
    const parsed = parseOtlpHeadersValue(
      `Authorization=Basic%20${SECRET},x-note=a%2Cb%3Dc,x%2Dencoded=1`,
    );
    expect(parsed.headers).toEqual({
      Authorization: `Basic ${SECRET}`,
      "x-note": "a,b=c",
      "x-encoded": "1",
    });
    expect(parsed.warnings).toEqual([]);
  });

  it("splits on the first = only, so base64 padding survives", () => {
    expect(parseOtlpHeadersValue("authorization=Basic%20YWJjOmRlZg==").headers).toEqual({
      authorization: "Basic YWJjOmRlZg==",
    });
  });

  it("returns nothing for an empty or blank value", () => {
    expect(parseOtlpHeadersValue("")).toEqual({ headers: {}, warnings: [] });
    expect(parseOtlpHeadersValue(" , ,")).toEqual({ headers: {}, warnings: [] });
  });

  it("ignores malformed entries, keeps the rest, and never quotes them", () => {
    const parsed = parseOtlpHeadersValue(
      [
        `Basic ${SECRET}`, // 1: no `=` at all — likely the secret itself
        `=${SECRET}`, // 2: empty key
        `bad key=${SECRET}`, // 3: not an HTTP token
        `x-bad-escape=%ZZ${SECRET}`, // 4: broken percent-encoding
        "x-empty=", // 5: empty value
        `x-crlf=${SECRET}%0D%0Ainjected: 1`, // 6: header injection
        "x-wide=%E0%A4%AC", // 7: beyond Latin-1, which HTTP cannot carry
        "x-good=kept", // 8
      ].join(","),
    );
    expect(parsed.headers).toEqual({ "x-good": "kept" });
    expect(parsed.warnings).toHaveLength(7);
    expect(parsed.warnings.map((warning) => warning.slice(0, 8))).toEqual([
      "entry 1 ",
      "entry 2 ",
      "entry 3 ",
      "entry 4 ",
      "entry 5 ",
      "entry 6 ",
      "entry 7 ",
    ]);
    const text = parsed.warnings.join("\n");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("Basic");
    expect(text).not.toContain("bad key");
  });

  it("lets a repeated key take its last value, case-insensitively", () => {
    expect(parseOtlpHeadersValue("authorization=first,Authorization=second").headers).toEqual({
      Authorization: "second",
    });
  });

  it("bounds how many headers one variable may set", () => {
    const raw = Array.from({ length: MAX_OTLP_HEADERS + 3 }, (_, i) => `x-h${String(i)}=v`).join(",");
    const parsed = parseOtlpHeadersValue(raw);
    expect(Object.keys(parsed.headers)).toHaveLength(MAX_OTLP_HEADERS);
    expect(parsed.warnings).toEqual([
      `more than ${String(MAX_OTLP_HEADERS)} headers were supplied; the excess was ignored`,
    ]);
  });
});

describe("resolveOtlpHeaders: precedence and the per-signal split", () => {
  it("reads the three standard variables", () => {
    expect(OTLP_HEADER_VARIABLES).toEqual({
      generic: "OTEL_EXPORTER_OTLP_HEADERS",
      traces: "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
      logs: "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
    });
  });

  it("applies the generic variable to both signals", () => {
    const resolved = resolveOtlpHeaders({ OTEL_EXPORTER_OTLP_HEADERS: "authorization=generic" });
    expect(resolved.traces).toEqual({ authorization: "generic" });
    expect(resolved.logs).toEqual({ authorization: "generic" });
  });

  it("applies each signal-specific variable only to its own signal", () => {
    const resolved = resolveOtlpHeaders({
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: "x-traces=t",
      OTEL_EXPORTER_OTLP_LOGS_HEADERS: "x-logs=l",
    });
    expect(resolved.traces).toEqual({ "x-traces": "t" });
    expect(resolved.logs).toEqual({ "x-logs": "l" });
  });

  it("lets the signal-specific variable override the generic one per header name", () => {
    const resolved = resolveOtlpHeaders({
      OTEL_EXPORTER_OTLP_HEADERS: "authorization=generic,x-tenant=acme",
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: "Authorization=traces-only",
    });
    expect(resolved.traces).toEqual({ "x-tenant": "acme", Authorization: "traces-only" });
    expect(resolved.logs).toEqual({ authorization: "generic", "x-tenant": "acme" });
  });

  it("lets explicit --header values override every variable", () => {
    const resolved = resolveOtlpHeaders(
      {
        OTEL_EXPORTER_OTLP_HEADERS: "authorization=generic,x-tenant=acme",
        OTEL_EXPORTER_OTLP_TRACES_HEADERS: "authorization=traces",
        OTEL_EXPORTER_OTLP_LOGS_HEADERS: "authorization=logs",
      },
      { authorization: "flag" },
    );
    expect(resolved.traces).toEqual({ "x-tenant": "acme", authorization: "flag" });
    expect(resolved.logs).toEqual({ "x-tenant": "acme", authorization: "flag" });
  });

  it("qualifies warnings with the variable name and nothing else", () => {
    const resolved = resolveOtlpHeaders({ OTEL_EXPORTER_OTLP_LOGS_HEADERS: `oops${SECRET}` });
    expect(resolved.warnings).toEqual([
      { variable: "OTEL_EXPORTER_OTLP_LOGS_HEADERS", detail: "entry 1 is not a key=value pair; ignored" },
    ]);
  });

  it("merges case-insensitively, keeping the higher source's spelling", () => {
    expect(mergeOtlpHeaders({ authorization: "a" }, { AUTHORIZATION: "b" })).toEqual({
      AUTHORIZATION: "b",
    });
  });
});

describe("header values never reach configuration, snapshots, or diagnostics", () => {
  const env = {
    OTEL_EXPORTER_OTLP_HEADERS: `authorization=Basic%20${SECRET}`,
    OTEL_EXPORTER_OTLP_TRACES_HEADERS: `x-trace-key=${SECRET}`,
    OTEL_EXPORTER_OTLP_LOGS_HEADERS: `x-log-key=${SECRET},Basic ${SECRET}`,
  };

  it("puts only header names in the environment configuration patch", () => {
    const { patch, warnings } = parseEnvironmentConfig(env);
    expect(patch.exporter?.headerNames).toEqual(["authorization", "x-log-key", "x-trace-key"]);
    expect(JSON.stringify(patch)).not.toContain(SECRET);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.details).toEqual({ "config.variable": "OTEL_EXPORTER_OTLP_LOGS_HEADERS" });
    expect(JSON.stringify(warnings)).not.toContain(SECRET);
  });

  it("names environment and flag headers together in the resolved snapshot", async () => {
    const policy = policyOf(["--header", `x-flag=${SECRET}`]);
    const resolved = await resolveCliConfig(policy, ioWith(env));
    expect(resolved.usedDefaults).toBe(false);
    const snapshot = describeResolvedConfig(resolved.config);
    expect(snapshot["exporter.header_names"]).toEqual([
      "authorization",
      "x-flag",
      "x-log-key",
      "x-trace-key",
    ]);
    expect(JSON.stringify(snapshot)).not.toContain(SECRET);
    expect(JSON.stringify(resolved.config)).not.toContain(SECRET);
    expect(JSON.stringify(resolved.warnings)).not.toContain(SECRET);
  });

  it("hands the values to the sinks, per signal, with --header winning", () => {
    const policy = policyOf(["--header", "authorization=flag-wins"]);
    const headers = resolveCliExporterHeaders(policy, ioWith(env));
    expect(headers.traces).toEqual({ authorization: "flag-wins", "x-trace-key": SECRET });
    expect(headers.logs).toEqual({ authorization: "flag-wins", "x-log-key": SECRET });
  });
});
