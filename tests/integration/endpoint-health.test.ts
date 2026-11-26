/**
 * A down collector must not stall the host agent (which waits for its hooks).
 *
 * Every case drives the real OTLP/HTTP exporters through the destination sinks:
 * a closed port (ECONNREFUSED), a host that accepts and never answers, and the
 * marks the state directory keeps between hook processes. One synthetic event;
 * nothing here is a real payload.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { ExportResultCode } from "@opentelemetry/core";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_EXPORTER_POLICY, effectiveExportTimeoutMillis, type ExporterPolicy } from "../../src/config/schema.js";
import { parseCanonicalEvent, type CanonicalEvent } from "../../src/model/events.js";
import { CANONICAL_SCHEMA_VERSION } from "../../src/model/version.js";
import { createFixedClock, createSystemClock } from "../../src/runtime/clock.js";
import {
  boundedExporterOptions,
  createEndpointHealth,
  ENDPOINT_DOWN_ERROR_CODE,
  isUnreachableExportFailure,
} from "../../src/telemetry/endpoint-health.js";
import { createDestinationFanout, createExportDestinationSinks } from "../../src/telemetry/export-destinations.js";
import { NO_LOG_CONTENT } from "../../src/telemetry/log-records.js";
import { createTestIdentity } from "../../src/testing/index.js";
import { startCapturingCollector } from "../helpers/collector.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), "otel-hook-endpoint-health-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

/** A TCP server that accepts every connection and never answers. */
const blackhole = async (): Promise<string> => {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("unexpected address");
  return `http://127.0.0.1:${String(address.port)}/v1/traces`;
};

const closedPort = async (): Promise<string> => {
  const collector = await startCapturingCollector();
  await collector.close();
  return collector.url;
};

/** One "hook process": its own sinks over a shared state root. */
const hookProcess = (endpoint: string, stateRoot: string, exporter: Partial<ExporterPolicy> = {}) => {
  const policy: ExporterPolicy = {
    ...DEFAULT_EXPORTER_POLICY,
    endpoint,
    logs: { ...DEFAULT_EXPORTER_POLICY.logs, enabled: true },
    ...exporter,
  };
  const { destinations } = createExportDestinationSinks({
    exporter: policy,
    providerId: "claude-code",
    installationId: "test-install",
    clock: createSystemClock(),
    spoolRootDir: stateRoot,
    logContent: NO_LOG_CONTENT,
  });
  return { sink: createDestinationFanout(destinations), destinations };
};

const timed = async <T>(work: () => Promise<T>): Promise<{ value: T; millis: number }> => {
  const started = Date.now();
  const value = await work();
  return { value, millis: Date.now() - started };
};

const spooled = async (stateRoot: string): Promise<number> => {
  let total = 0;
  for (const queue of ["spool", "spool-logs"]) {
    total += (await readdir(path.join(stateRoot, "claude-code", "test-install", queue)).catch(() => [])).filter(
      (name) => name.endsWith(".json") && !name.startsWith(".tmp-") && !name.startsWith("drops"),
    ).length;
  }
  return total;
};

const marks = async (stateRoot: string): Promise<string[]> =>
  (await readdir(path.join(stateRoot, "endpoint-health")).catch(() => [])).filter((name) => !name.startsWith(".tmp-"));

const identity = createTestIdentity();
let eventCounter = 0;
const events = (): readonly CanonicalEvent[] => {
  eventCounter += 1;
  return [
    parseCanonicalEvent({
      schemaVersion: CANONICAL_SCHEMA_VERSION,
      invocationId: identity.invocationId,
      sessionId: identity.sessionId,
      provenance: identity.provenance,
      workspace: identity.workspace,
      extensions: {},
      eventId: `e${String(eventCounter)}`,
      sequence: eventCounter,
      occurredAt: 1_700_000_000_000 + eventCounter,
      type: "prompt.submitted",
      promptSource: "user",
    }),
  ];
};

/** A collector on a fixed port that accepts everything; counts requests. */
const reviveOn = async (port: number): Promise<{ readonly requests: () => number }> => {
  let requests = 0;
  const server = createHttpServer((req, res) => {
    req.resume();
    req.on("end", () => {
      requests += 1;
      res.writeHead(200, { "content-type": "application/x-protobuf" });
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { requests: () => requests };
};

describe("a down endpoint costs one hook at most the export budget", () => {
  it.each([
    { name: "a closed port (ECONNREFUSED)", endpoint: closedPort },
    { name: "a host that accepts and never answers", endpoint: blackhole },
  ])("$name: spooled within the budget, then the next hooks spool without trying", async ({ endpoint }) => {
    const url = await endpoint();
    const stateRoot = await tempDir();

    const first = hookProcess(url, stateRoot);
    const emitted = await timed(() => first.sink.emit(events()));
    const flushed = await timed(() => first.sink.shutdown());
    // Budget 1.5 s per request; before this, ~20 s (refused) and the kernel's
    // connect timeout (blackholed SYN).
    expect(emitted.millis + flushed.millis).toBeLessThan(3_500);
    expect(emitted.value.rejected).toBe(0);
    expect(await spooled(stateRoot)).toBeGreaterThan(0);
    expect(await marks(stateRoot)).toHaveLength(1);

    const before = await spooled(stateRoot);
    const second = hookProcess(url, stateRoot);
    const next = await timed(async () => {
      const result = await second.sink.emit(events());
      await second.sink.shutdown();
      return result;
    });
    expect(next.millis).toBeLessThan(500);
    expect(next.value.rejected).toBe(0);
    expect(await spooled(stateRoot)).toBeGreaterThan(before);
  });

  it("a revived endpoint is probed once the window ends, and the spool drains", async () => {
    const url = await closedPort();
    const stateRoot = await tempDir();
    const port = new URL(url).port;
    const first = hookProcess(url, stateRoot, { endpointDownMillis: 200 });
    await first.sink.emit(events());
    await first.sink.shutdown();
    expect(await spooled(stateRoot)).toBeGreaterThan(0);

    const collector = await reviveOn(Number(port));
    // Still inside the window: nothing is sent, nothing drains.
    const early = hookProcess(url, stateRoot, { endpointDownMillis: 200 });
    await early.sink.shutdown();
    expect(collector.requests()).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 250));
    const probe = hookProcess(url, stateRoot, { endpointDownMillis: 200 });
    await probe.sink.emit(events());
    await probe.sink.shutdown();
    expect(collector.requests()).toBeGreaterThan(0);
    expect(await spooled(stateRoot)).toBe(0);
    expect(await marks(stateRoot)).toHaveLength(0);
  });

  it("a refusal with a status (4xx) says the endpoint is up: no mark", async () => {
    const collector = await startCapturingCollector(() => ({ status: 400 }));
    cleanups.push(() => collector.close());
    const stateRoot = await tempDir();
    const hook = hookProcess(collector.url, stateRoot);
    await hook.sink.emit(events());
    await hook.sink.shutdown();
    expect(await marks(stateRoot)).toHaveLength(0);
  });

  it("endpointDownMillis 0 turns the window off: every hook tries", async () => {
    const url = await closedPort();
    const stateRoot = await tempDir();
    const hook = hookProcess(url, stateRoot, { endpointDownMillis: 0, exportBudgetMillis: 200 });
    await hook.sink.emit(events());
    await hook.sink.shutdown();
    expect(await marks(stateRoot)).toHaveLength(0);
  });
});

describe("endpoint health marks", () => {
  const ok = { code: ExportResultCode.SUCCESS } as const;
  const refused = {
    code: ExportResultCode.FAILED,
    error: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
  } as const;

  it("one prober after the window: the next process waits for it", async () => {
    const rootDir = await tempDir();
    const clock = createFixedClock({ startMillis: 1_800_000_000_000 });
    const a = createEndpointHealth({ rootDir, clock, downMillis: 30_000, probeMillis: 2_500 }).gateFor("http://collector.invalid:4318/v1/traces");
    await a?.record(refused);
    expect(await a?.available()).toBe(false);
    clock.advance(30_001);
    // Two fresh processes after the window: the first to look claims the probe.
    const b = createEndpointHealth({ rootDir, clock, downMillis: 30_000, probeMillis: 2_500 }).gateFor("http://collector.invalid:4318/v1/logs");
    const c = createEndpointHealth({ rootDir, clock, downMillis: 30_000, probeMillis: 2_500 }).gateFor("http://collector.invalid:4318/v1/metrics");
    expect(await b?.available()).toBe(true);
    expect(await c?.available()).toBe(false);
    await b?.record(ok);
    const d = createEndpointHealth({ rootDir, clock, downMillis: 30_000, probeMillis: 2_500 }).gateFor("http://collector.invalid:4318/v1/traces");
    expect(await d?.available()).toBe(true);
  });

  it("is keyed by origin and holds no URL", async () => {
    const rootDir = await tempDir();
    const clock = createFixedClock();
    const health = createEndpointHealth({ rootDir, clock, probeMillis: 2_500 });
    await health.gateFor("https://secret-collector.example:4318/v1/traces")?.record(refused);
    expect(await health.gateFor("https://secret-collector.example:4318/v1/logs")?.available()).toBe(false);
    expect(await health.gateFor("https://other.example:4318/v1/logs")?.available()).toBe(true);
    const [mark] = await marks(rootDir);
    const body = await readFile(path.join(rootDir, "endpoint-health", mark ?? ""), "utf8");
    expect(body).not.toContain("secret-collector");
  });

  it("a corrupt mark is ignored", async () => {
    const rootDir = await tempDir();
    await mkdir(path.join(rootDir, "endpoint-health"), { recursive: true });
    const health = createEndpointHealth({ rootDir, clock: createFixedClock(), probeMillis: 2_500 });
    const gate = health.gateFor("http://collector.invalid:4318/v1/traces");
    const [name] = await readdir(path.join(rootDir, "endpoint-health"));
    expect(name).toBeUndefined();
    await gate?.record(refused);
    const [mark] = await marks(rootDir);
    await writeFile(path.join(rootDir, "endpoint-health", mark ?? ""), "not json");
    const fresh = createEndpointHealth({ rootDir, clock: createFixedClock(), probeMillis: 2_500 });
    expect(await fresh.gateFor("http://collector.invalid:4318/v1/traces")?.available()).toBe(true);
  });

  it("classifies what counts as unreachable", () => {
    const failed = (error: unknown) => ({ code: ExportResultCode.FAILED, error: error as Error });
    expect(isUnreachableExportFailure(refused)).toBe(true);
    expect(isUnreachableExportFailure(failed(new Error("Request timed out")))).toBe(true);
    // Any HTTP answer, a 503 included, says the endpoint is up.
    expect(isUnreachableExportFailure(failed(Object.assign(new Error("x"), { code: 503 })))).toBe(false);
    expect(isUnreachableExportFailure(failed(new Error("Export failed with retryable status")))).toBe(false);
    expect(isUnreachableExportFailure(failed(Object.assign(new Error("x"), { code: 400 })))).toBe(false);
    expect(isUnreachableExportFailure(failed(Object.assign(new Error("x"), { code: ENDPOINT_DOWN_ERROR_CODE })))).toBe(true);
    expect(isUnreachableExportFailure(ok)).toBe(false);
  });

  it("caps every request at the export budget", () => {
    expect(effectiveExportTimeoutMillis({ ...DEFAULT_EXPORTER_POLICY, timeoutMillis: 15_000 })).toBe(1_500);
    expect(effectiveExportTimeoutMillis({ ...DEFAULT_EXPORTER_POLICY, timeoutMillis: 800 })).toBe(800);
    expect(boundedExporterOptions({ ...DEFAULT_EXPORTER_POLICY, exportBudgetMillis: 4_000 }).timeoutMillis).toBe(4_000);
  });
});
