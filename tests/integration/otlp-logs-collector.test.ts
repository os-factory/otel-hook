import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { SeverityNumber } from "@opentelemetry/api-logs";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_EXPORTER_POLICY, type ExporterPolicy } from "../../src/config/schema.js";
import { parseCanonicalEvent, type CanonicalEvent } from "../../src/model/events.js";
import { CANONICAL_SCHEMA_VERSION } from "../../src/model/version.js";
import { createPrivacyService } from "../../src/privacy/service.js";
import { DEFAULT_PRIVACY_POLICY } from "../../src/privacy/policy.js";
import { createFixedClock } from "../../src/runtime/clock.js";
import { createRecordingLogger } from "../../src/runtime/memory.js";
import { createFileDurableLogSpool } from "../../src/telemetry/durable-log-spool.js";
import { createOtlpLogSink } from "../../src/telemetry/otlp-log-sink.js";
import { createTestIdentity } from "../../src/testing/index.js";
import { startCapturingCollector } from "../helpers/collector.js";
import { decodeAllExportedLogRecords, decodeExportedLogRecords } from "../helpers/otlp.js";

/**
 * The logs signal driven against a real (ephemeral, local-only) HTTP collector, so
 * these assertions are about bytes that actually left the process rather than about
 * an in-memory double. Where a privacy claim is made it is made against the raw
 * body as well as the decoded records: "this text is nowhere in what we sent" is
 * only meaningful on the bytes themselves.
 */

const identity = createTestIdentity();
const PROVIDER = "acme-cli";
const INSTALLATION = "install-1";

let sequence = 0;
const build = (fields: Record<string, unknown>): CanonicalEvent =>
  parseCanonicalEvent({
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    invocationId: identity.invocationId,
    sessionId: identity.sessionId,
    provenance: identity.provenance,
    workspace: identity.workspace,
    extensions: {},
    eventId: `e${String((sequence += 1))}`,
    sequence,
    occurredAt: 1_700_000_000_000,
    ...fields,
  });

const logsOn = (patch: Partial<ExporterPolicy> = {}, logs: Partial<ExporterPolicy["logs"]> = {}): ExporterPolicy => ({
  ...DEFAULT_EXPORTER_POLICY,
  ...patch,
  logs: { ...DEFAULT_EXPORTER_POLICY.logs, enabled: true, ...logs },
});

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const tempRoot = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), "otel-hook-log-spool-"));
  closers.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

describe("OTLP logs: HTTP/protobuf delivery against a real local collector", () => {
  it("posts a well-formed ExportLogsServiceRequest to the logs path", async () => {
    const collector = await startCapturingCollector();
    closers.push(() => collector.close());

    const sink = createOtlpLogSink({
      // Only the trace endpoint is configured: the logs path is derived, which is
      // the shape a collector serving both signals actually has.
      exporter: logsOn({ endpoint: collector.url, timeoutMillis: 5_000 }),
      providerId: PROVIDER,
      installationId: INSTALLATION,
      clock: createFixedClock(),
    });

    const result = await sink.emit([build({ type: "prompt.submitted", promptSource: "user" })]);
    expect(result).toEqual({ accepted: 1, rejected: 0, errors: [] });
    expect(collector.requests).toHaveLength(1);

    const [request] = collector.requests;
    expect(request?.path).toBe("/v1/logs");
    expect(request?.headers["content-type"]).toBe("application/x-protobuf");
    // Field 1 (resource_logs), wire type 2 (length-delimited) on
    // ExportLogsServiceRequest is tag byte 0x0A — a strong signal this is a real
    // protobuf-encoded request rather than JSON or garbage.
    expect(request?.body[0]).toBe(0x0a);

    const [record] = decodeExportedLogRecords(request?.body ?? Buffer.alloc(0));
    expect(record?.eventName).toBe("otelhook.prompt.submitted");
    expect(record?.severityNumber).toBe(SeverityNumber.INFO);
    expect(record?.severityText).toBe("INFO");
    expect(record?.scopeName).toBe("@osfactory/otel-hook");
    expect(record?.attributes["session.id"]).toBe(identity.sessionId);
    expect(record?.attributes["otelhook.log.signal"]).toBe("prompt");
    expect(record?.attributes["otelhook.log.mapping_version"]).toBe(1);
    expect(record?.resourceAttributes["service.name"]).toBe(DEFAULT_EXPORTER_POLICY.serviceName);
    // Correlation fields are binary on the wire, so decoding is the only way to show
    // a record really carries ids of the right widths.
    expect(record?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(record?.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(record?.timeUnixNanos).toBe(1_700_000_000_000_000_000n);

    expect(sink.health()).toMatchObject({
      subsystem: "telemetry-log-sink",
      healthy: true,
      totalAccepted: 1,
      totalRejected: 0,
    });
    await sink.shutdown();
  });

  it("keeps content off the wire by default, exporting only measurable facts", async () => {
    const collector = await startCapturingCollector();
    closers.push(() => collector.close());

    const secret = "prompt-secret-do-not-export";
    const privacy = createPrivacyService(DEFAULT_PRIVACY_POLICY);
    const sink = createOtlpLogSink({
      exporter: logsOn({ endpoint: collector.url, timeoutMillis: 5_000 }),
      providerId: PROVIDER,
      installationId: INSTALLATION,
      clock: createFixedClock(),
    });

    await sink.emit([
      build({
        type: "prompt.submitted",
        promptSource: "user",
        content: privacy.describeContent({ kind: "prompt", text: secret }),
      }),
    ]);

    // Asserted on the raw bytes: a protobuf string field appears verbatim in the
    // payload, so this is the strongest available form of "we did not send it".
    const wire = Buffer.concat(collector.bodies()).toString("latin1");
    expect(wire).not.toContain(secret);

    const [record] = decodeAllExportedLogRecords(collector.bodies());
    expect(record?.body).toBeUndefined();
    expect(record?.attributes["otelhook.content.withheld"]).toBe("privacy-policy");
    expect(record?.attributes["otelhook.content.character_length"]).toBe(secret.length);
    await sink.shutdown();
  });

  it("chunks a large batch at the configured logs batch size", async () => {
    const collector = await startCapturingCollector();
    closers.push(() => collector.close());

    const sink = createOtlpLogSink({
      exporter: logsOn({ endpoint: collector.url, timeoutMillis: 5_000 }, { maxBatchSize: 2 }),
      providerId: PROVIDER,
      installationId: INSTALLATION,
      clock: createFixedClock(),
    });

    const result = await sink.emit(
      Array.from({ length: 5 }, () => build({ type: "prompt.submitted", promptSource: "user" })),
    );
    expect(result.accepted).toBe(5);
    expect(collector.requests).toHaveLength(3);
    expect(decodeAllExportedLogRecords(collector.bodies())).toHaveLength(5);
    await sink.shutdown();
  });
});

describe("OTLP logs: bounded spooling, retry, and shutdown", () => {
  it("spools a batch the collector rejects, then delivers it on a later drain", async () => {
    const rootDir = await tempRoot();
    const clock = createFixedClock();
    const spool = createFileDurableLogSpool({
      rootDir,
      providerId: PROVIDER,
      installationId: INSTALLATION,
      clock,
    });

    const down = await startCapturingCollector(() => ({ status: 503 }));
    closers.push(() => down.close());
    const sink = createOtlpLogSink({
      exporter: logsOn({ endpoint: down.url, timeoutMillis: 2_000, maxRetryAttempts: 0 }),
      providerId: PROVIDER,
      installationId: INSTALLATION,
      clock,
      spool,
    });

    // A spooled batch counts as accepted: it is safe on disk and a later invocation
    // will retry it, so the callback must not be treated as a loss.
    const rejected = await sink.emit([build({ type: "prompt.submitted", promptSource: "user" })]);
    expect(rejected).toEqual({ accepted: 1, rejected: 0, errors: [] });
    expect(await spool.size()).toBe(1);
    expect(down.requests.length).toBeGreaterThanOrEqual(1);

    const recovered = await startCapturingCollector();
    closers.push(() => recovered.close());
    const drainSink = createOtlpLogSink({
      exporter: logsOn({ endpoint: recovered.url, timeoutMillis: 2_000 }),
      providerId: PROVIDER,
      installationId: INSTALLATION,
      clock,
      spool,
    });

    expect(await drainSink.drainSpool()).toEqual({
      drained: 1,
      remaining: 0,
      failed: 0,
      quarantined: 0,
    });
    expect(recovered.requests).toHaveLength(1);
    expect(recovered.requests[0]?.path).toBe("/v1/logs");
    expect(await spool.size()).toBe(0);

    // Everything the record carried survives the round-trip, correlation included.
    const [replayed] = decodeAllExportedLogRecords(recovered.bodies());
    expect(replayed?.eventName).toBe("otelhook.prompt.submitted");
    expect(replayed?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(replayed?.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(replayed?.resourceAttributes["service.name"]).toBe(DEFAULT_EXPORTER_POLICY.serviceName);

    await sink.shutdown();
    await drainSink.shutdown();
  }, 20_000);

  it("uses its own queue directory, so a logs outage cannot consume the trace spool", async () => {
    const rootDir = await tempRoot();
    const clock = createFixedClock();
    const down = await startCapturingCollector(() => ({ status: 503 }));
    closers.push(() => down.close());

    const sink = createOtlpLogSink({
      exporter: logsOn({ endpoint: down.url, timeoutMillis: 1_000, maxRetryAttempts: 0 }),
      providerId: PROVIDER,
      installationId: INSTALLATION,
      clock,
      spool: createFileDurableLogSpool({ rootDir, providerId: PROVIDER, installationId: INSTALLATION, clock }),
    });
    await sink.emit([build({ type: "prompt.submitted", promptSource: "user" })]);

    const identityDir = path.join(rootDir, PROVIDER, INSTALLATION);
    expect((await readdir(identityDir)).sort()).toEqual(["spool-logs", "spool-logs-corrupt"]);
    await sink.shutdown();
  }, 20_000);

  it("refuses new entries at capacity rather than growing without bound", async () => {
    const rootDir = await tempRoot();
    const clock = createFixedClock({ tickMillis: 1 });
    const logger = createRecordingLogger();
    const spool = createFileDurableLogSpool({
      rootDir,
      providerId: PROVIDER,
      installationId: INSTALLATION,
      clock,
      logger,
      maxSpoolFiles: 2,
    });
    const down = await startCapturingCollector(() => ({ status: 503 }));
    closers.push(() => down.close());

    const sink = createOtlpLogSink({
      exporter: logsOn({ endpoint: down.url, timeoutMillis: 1_000, maxRetryAttempts: 0 }),
      providerId: PROVIDER,
      installationId: INSTALLATION,
      clock,
      spool,
      logger,
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect((await sink.emit([build({ type: "prompt.submitted", promptSource: "user" })])).accepted).toBe(1);
    }
    // Third batch: the queue is full, so it is refused and reported as a real loss
    // rather than silently overwriting a queued batch.
    const overflow = await sink.emit([build({ type: "prompt.submitted", promptSource: "user" })]);
    expect(overflow).toMatchObject({ accepted: 0, rejected: 1 });
    expect(await spool.size()).toBe(2);
    expect(logger.records().some((record) => record.message.includes("at capacity"))).toBe(true);
    await sink.shutdown();
  }, 20_000);

  it("quarantines a poisoned spool file instead of wedging the queue behind it", async () => {
    const rootDir = await tempRoot();
    const clock = createFixedClock({ tickMillis: 1 });
    const logger = createRecordingLogger();
    const spool = createFileDurableLogSpool({
      rootDir,
      providerId: PROVIDER,
      installationId: INSTALLATION,
      clock,
      logger,
    });

    const down = await startCapturingCollector(() => ({ status: 503 }));
    closers.push(() => down.close());
    const failing = createOtlpLogSink({
      exporter: logsOn({ endpoint: down.url, timeoutMillis: 1_000, maxRetryAttempts: 0 }),
      providerId: PROVIDER,
      installationId: INSTALLATION,
      clock,
      spool,
    });
    // A healthy batch queued *behind* the poison, which is the case that matters:
    // a file the drain cannot use must not block the ones it can.
    await failing.emit([build({ type: "prompt.submitted", promptSource: "user" })]);
    await failing.shutdown();

    const spoolDir = path.join(rootDir, PROVIDER, INSTALLATION, "spool-logs");
    const [healthyFile] = (await readdir(spoolDir)).filter((entry) => entry.endsWith(".json")).sort();
    expect(healthyFile).toBeDefined();
    const healthy = JSON.parse(await readFile(path.join(spoolDir, healthyFile as string), "utf8")) as Record<
      string,
      unknown
    >;
    // Sorted by filename, and the clock ticks, so a name below the healthy one is
    // read first.
    await writeFile(
      path.join(spoolDir, "0000000000000000-poison.json"),
      JSON.stringify({ ...healthy, records: "not-an-array" }),
      "utf8",
    );

    const recovered = await startCapturingCollector();
    closers.push(() => recovered.close());
    const drainSink = createOtlpLogSink({
      exporter: logsOn({ endpoint: recovered.url, timeoutMillis: 2_000 }),
      providerId: PROVIDER,
      installationId: INSTALLATION,
      clock,
      spool,
      logger,
    });

    const result = await drainSink.drainSpool();
    expect(result).toMatchObject({ drained: 1, failed: 0, quarantined: 1, remaining: 0 });
    expect(recovered.requests).toHaveLength(1);
    expect(
      logger.records().some((record) => record.fields?.["spool.rejection"] === "records-invalid"),
    ).toBe(true);
    // Quarantined, not deleted: the unusable file is still there to inspect.
    const corrupt = await readdir(path.join(rootDir, PROVIDER, INSTALLATION, "spool-logs-corrupt"));
    expect(corrupt).toContain("0000000000000000-poison.json");
    await drainSink.shutdown();
  }, 20_000);

  it("refuses a spooled record whose correlation was tampered with", async () => {
    const rootDir = await tempRoot();
    const clock = createFixedClock({ tickMillis: 1 });
    const logger = createRecordingLogger();
    const spool = createFileDurableLogSpool({
      rootDir,
      providerId: PROVIDER,
      installationId: INSTALLATION,
      clock,
      logger,
    });

    const down = await startCapturingCollector(() => ({ status: 503 }));
    closers.push(() => down.close());
    const failing = createOtlpLogSink({
      exporter: logsOn({ endpoint: down.url, timeoutMillis: 1_000, maxRetryAttempts: 0 }),
      providerId: PROVIDER,
      installationId: INSTALLATION,
      clock,
      spool,
    });
    await failing.emit([build({ type: "prompt.submitted", promptSource: "user" })]);
    await failing.shutdown();

    const spoolDir = path.join(rootDir, PROVIDER, INSTALLATION, "spool-logs");
    const [file] = (await readdir(spoolDir)).filter((entry) => entry.endsWith(".json"));
    const filePath = path.join(spoolDir, file as string);
    const batch = JSON.parse(await readFile(filePath, "utf8")) as {
      records: { traceId?: string; spanId?: string }[];
    };
    // A trace id of the wrong width is not a span a collector can place; accepting it
    // would surface as an encoder error deep inside the exporter instead of here.
    batch.records[0] = { ...batch.records[0], traceId: "tooshort" };
    await writeFile(filePath, JSON.stringify(batch), "utf8");

    const recovered = await startCapturingCollector();
    closers.push(() => recovered.close());
    const drainSink = createOtlpLogSink({
      exporter: logsOn({ endpoint: recovered.url, timeoutMillis: 2_000 }),
      providerId: PROVIDER,
      installationId: INSTALLATION,
      clock,
      spool,
      logger,
    });

    expect(await drainSink.drainSpool()).toMatchObject({ drained: 0, quarantined: 1, failed: 0 });
    expect(recovered.requests).toHaveLength(0);
    await drainSink.shutdown();
  }, 20_000);

  it("drains the spool on shutdown, and shutdown is idempotent", async () => {
    const rootDir = await tempRoot();
    const clock = createFixedClock();
    const spool = createFileDurableLogSpool({
      rootDir,
      providerId: PROVIDER,
      installationId: INSTALLATION,
      clock,
    });

    let up = false;
    const collector = await startCapturingCollector(() => ({ status: up ? 200 : 503 }));
    closers.push(() => collector.close());
    const sink = createOtlpLogSink({
      exporter: logsOn({ endpoint: collector.url, timeoutMillis: 1_000, maxRetryAttempts: 0 }),
      providerId: PROVIDER,
      installationId: INSTALLATION,
      clock,
      spool,
    });

    await sink.emit([build({ type: "prompt.submitted", promptSource: "user" })]);
    expect(await spool.size()).toBe(1);

    up = true;
    await sink.shutdown();
    expect(await spool.size()).toBe(0);
    // Second shutdown must not re-flush or throw.
    const before = collector.requests.length;
    await sink.shutdown();
    expect(collector.requests.length).toBe(before);
  }, 20_000);
});
