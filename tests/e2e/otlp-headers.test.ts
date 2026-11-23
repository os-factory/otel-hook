import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  ensureBuiltCli,
  findProviderCase,
  makeStateDir,
  runCliProcess,
  startCollector,
  type Collector,
} from "./harness.js";

/**
 * The standard `OTEL_EXPORTER_OTLP_*HEADERS` variables, driven through the built
 * binary: the headers that reach the collector on each signal path, and the
 * values that must never reach stderr or a doctor report.
 */

const SECRET = "c2stbGYtc2VjcmV0OnNrLWxmLXZhbHVl";

beforeAll(async () => {
  await ensureBuiltCli();
}, 300_000);

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const withCollector = async (): Promise<Collector> => {
  const collector = await startCollector();
  cleanups.push(() => collector.close());
  return collector;
};

const withStateDir = async (): Promise<string> => {
  const state = await makeStateDir();
  cleanups.push(() => state.remove());
  return state.dir;
};

const runWithEnv = async (
  env: Readonly<Record<string, string>>,
  extraArgs: readonly string[] = [],
) => {
  const collector = await withCollector();
  const stateDir = await withStateDir();
  const providerCase = findProviderCase("claude-code");
  const result = await runCliProcess(
    [
      "run",
      "--provider",
      "claude-code",
      "--endpoint",
      collector.url,
      "--logs",
      "--state-dir",
      stateDir,
      "--log-level",
      "debug",
      ...extraArgs,
    ],
    JSON.stringify(providerCase.payload("ses-e2e-otlp-headers")),
    { env },
  );
  const traces = collector.requests.filter((request) => request.path === "/v1/traces");
  const logs = collector.requests.filter((request) => request.path === "/v1/logs");
  return { result, traces, logs };
};

describe("otel-hook run: OTEL_EXPORTER_OTLP_*HEADERS", () => {
  it("sends the generic variable's headers on both signals", async () => {
    const { result, traces, logs } = await runWithEnv({
      OTEL_EXPORTER_OTLP_HEADERS: `authorization=Basic%20${SECRET},x-tenant=acme`,
    });
    expect(result.code).toBe(0);
    expect(traces.length).toBeGreaterThanOrEqual(1);
    expect(logs.length).toBeGreaterThanOrEqual(1);
    for (const request of [...traces, ...logs]) {
      expect(request.headers.authorization).toBe(`Basic ${SECRET}`);
      expect(request.headers["x-tenant"]).toBe("acme");
    }
    expect(result.stderr).not.toContain(SECRET);
  }, 60_000);

  it("sends each signal-specific variable only on its own signal, over the generic one", async () => {
    const { result, traces, logs } = await runWithEnv({
      OTEL_EXPORTER_OTLP_HEADERS: "authorization=generic,x-tenant=acme",
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: `authorization=traces-${SECRET}`,
      OTEL_EXPORTER_OTLP_LOGS_HEADERS: `x-logs-only=logs-${SECRET}`,
    });
    expect(result.code).toBe(0);
    expect(traces.length).toBeGreaterThanOrEqual(1);
    expect(logs.length).toBeGreaterThanOrEqual(1);
    for (const request of traces) {
      expect(request.headers.authorization).toBe(`traces-${SECRET}`);
      expect(request.headers["x-tenant"]).toBe("acme");
      expect(request.headers["x-logs-only"]).toBeUndefined();
    }
    for (const request of logs) {
      expect(request.headers.authorization).toBe("generic");
      expect(request.headers["x-tenant"]).toBe("acme");
      expect(request.headers["x-logs-only"]).toBe(`logs-${SECRET}`);
    }
    expect(result.stderr).not.toContain(SECRET);
  }, 60_000);

  it("lets --header override the variables", async () => {
    const { result, traces, logs } = await runWithEnv(
      {
        OTEL_EXPORTER_OTLP_HEADERS: `authorization=env-${SECRET}`,
        OTEL_EXPORTER_OTLP_TRACES_HEADERS: `authorization=traces-${SECRET}`,
      },
      ["--header", "authorization=from-flag"],
    );
    expect(result.code).toBe(0);
    for (const request of [...traces, ...logs]) {
      expect(request.headers.authorization).toBe("from-flag");
    }
    expect(result.stderr).not.toContain(SECRET);
  }, 60_000);

  it("warns about a malformed entry without printing it, and still exports", async () => {
    const { result, traces } = await runWithEnv({
      OTEL_EXPORTER_OTLP_HEADERS: `Basic ${SECRET},x-tenant=acme`,
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("OTEL_EXPORTER_OTLP_HEADERS");
    expect(result.stderr).toContain("entry 1 is not a key=value pair");
    expect(result.stderr).not.toContain(SECRET);
    expect(traces.length).toBeGreaterThanOrEqual(1);
    expect(traces[0]?.headers["x-tenant"]).toBe("acme");
  }, 60_000);
});

describe("otel-hook doctor: OTEL_EXPORTER_OTLP_*HEADERS", () => {
  it("names the headers and never discloses their values", async () => {
    const collector = await withCollector();
    const stateDir = await withStateDir();
    const result = await runCliProcess(
      ["doctor", "--json", "--state-dir", stateDir, "--endpoint", collector.url],
      "",
      {
        env: {
          OTEL_EXPORTER_OTLP_HEADERS: `authorization=Basic%20${SECRET}`,
          OTEL_EXPORTER_OTLP_LOGS_HEADERS: `x-logs-key=${SECRET}`,
        },
      },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain(SECRET);
    expect(result.stderr).not.toContain(SECRET);
    const report = JSON.parse(result.stdout) as { config: Record<string, unknown> };
    expect(report.config["exporter.header_names"]).toEqual(["authorization", "x-logs-key"]);
    expect(collector.requests).toHaveLength(0);
  }, 60_000);
});
