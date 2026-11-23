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
 * The standard OTLP endpoint variables, driven through the built binary: the
 * paths each signal actually reaches on a capturing collector.
 */

beforeAll(async () => {
  await ensureBuiltCli();
}, 300_000);

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const run = async (env: (collector: Collector, base: string) => Record<string, string>) => {
  const collector = await startCollector();
  cleanups.push(() => collector.close());
  const state = await makeStateDir();
  cleanups.push(() => state.remove());
  const base = collector.url.slice(0, collector.url.length - "/v1/traces".length);
  const result = await runCliProcess(
    ["run", "--provider", "claude-code", "--logs", "--state-dir", state.dir],
    JSON.stringify(findProviderCase("claude-code").payload("ses-e2e-otlp-endpoints")),
    { env: env(collector, base) },
  );
  expect(result.code).toBe(0);
  return new Set(collector.requests.map((request) => request.path));
};

describe("otel-hook run: OTEL_EXPORTER_OTLP_*ENDPOINT", () => {
  it("appends the signal paths to an OTEL_EXPORTER_OTLP_ENDPOINT base URL", async () => {
    const paths = await run((_collector, base) => ({ OTEL_EXPORTER_OTLP_ENDPOINT: `${base}/` }));
    expect([...paths].sort()).toEqual(["/v1/logs", "/v1/traces"]);
  }, 60_000);

  it("posts traces to OTEL_EXPORTER_OTLP_TRACES_ENDPOINT as-is, logs under the base", async () => {
    const paths = await run((_collector, base) => ({
      OTEL_EXPORTER_OTLP_ENDPOINT: base,
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${base}/api/public/otel/v1/traces`,
    }));
    expect([...paths].sort()).toEqual(["/api/public/otel/v1/traces", "/v1/logs"]);
  }, 60_000);

  it("keeps a legacy full traces URL in OTEL_EXPORTER_OTLP_ENDPOINT working", async () => {
    const paths = await run((collector) => ({ OTEL_EXPORTER_OTLP_ENDPOINT: collector.url }));
    expect([...paths].sort()).toEqual(["/v1/logs", "/v1/traces"]);
  }, 60_000);
});
