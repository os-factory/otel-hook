import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_EXPORTER_POLICY } from "../../src/config/schema.js";
import { parseCanonicalEvent } from "../../src/model/events.js";
import { CANONICAL_SCHEMA_VERSION } from "../../src/model/version.js";
import { createFixedClock } from "../../src/runtime/clock.js";
import { createFileDurableSpool } from "../../src/telemetry/durable-spool.js";
import { createOtlpTraceSink } from "../../src/telemetry/otlp-sink.js";
import { createTestIdentity } from "../../src/testing/index.js";

/**
 * A real (ephemeral, local-only) HTTP server standing in for a collector, so
 * the sink's actual OTLP HTTP/protobuf delivery path runs end to end instead
 * of only against the in-memory test double. Not a daemon: it is created and
 * torn down within a single test.
 */
type CapturedRequest = { readonly headers: IncomingHttpHeaders; readonly body: Buffer };

const startCapturingCollector = async (
  respond: (request: CapturedRequest) => { readonly status: number },
): Promise<{ readonly url: string; readonly server: Server; readonly requests: CapturedRequest[] }> => {
  const requests: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const request = { headers: req.headers, body: Buffer.concat(chunks) };
      requests.push(request);
      const { status } = respond(request);
      res.writeHead(status);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("failed to bind capturing collector");
  }
  return { url: `http://127.0.0.1:${address.port}/v1/traces`, server, requests };
};

const identity = createTestIdentity();
let index = 0;
const nextEvent = () =>
  parseCanonicalEvent({
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    invocationId: identity.invocationId,
    sessionId: identity.sessionId,
    provenance: identity.provenance,
    workspace: identity.workspace,
    extensions: {},
    eventId: `e${(index += 1)}`,
    sequence: index,
    occurredAt: 1_000,
    type: "prompt.submitted",
    promptSource: "user",
  });

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe("OTLP HTTP/protobuf delivery against a real local collector", () => {
  it("sends a well-formed protobuf ExportTraceServiceRequest and reports success", async () => {
    const collector = await startCapturingCollector(() => ({ status: 200 }));
    closers.push(() => new Promise<void>((resolve) => collector.server.close(() => resolve())));

    const sink = createOtlpTraceSink({
      exporter: { ...DEFAULT_EXPORTER_POLICY, endpoint: collector.url, timeoutMillis: 5_000 },
      providerId: "acme-cli",
      installationId: "install-1",
      clock: createFixedClock(),
    });

    const result = await sink.emit([nextEvent()]);
    expect(result).toEqual({ accepted: 1, rejected: 0, errors: [] });
    expect(collector.requests).toHaveLength(1);

    const [request] = collector.requests;
    expect(request?.headers["content-type"]).toBe("application/x-protobuf");
    expect(request?.body.length).toBeGreaterThan(0);
    // Field 1 (resource_spans), wire type 2 (length-delimited) on
    // ExportTraceServiceRequest is tag byte 0x0A — a strong signal this is a
    // real protobuf-encoded request rather than JSON or garbage.
    expect(request?.body[0]).toBe(0x0a);

    expect(sink.health()).toMatchObject({ healthy: true, totalAccepted: 1, totalRejected: 0 });
    await sink.shutdown();
  });

  it("spools a batch the collector rejects, then delivers it on a later drain", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "otel-hook-spool-"));
    closers.push(() => rm(rootDir, { recursive: true, force: true }));

    const collector = await startCapturingCollector(() => ({ status: 503 }));
    closers.push(() => new Promise<void>((resolve) => collector.server.close(() => resolve())));

    const clock = createFixedClock();
    const spool = createFileDurableSpool({ rootDir, providerId: "acme-cli", installationId: "install-1", clock });
    const sink = createOtlpTraceSink({
      exporter: { ...DEFAULT_EXPORTER_POLICY, endpoint: collector.url, timeoutMillis: 2_000, maxRetryAttempts: 0 },
      providerId: "acme-cli",
      installationId: "install-1",
      clock,
      spool,
    });

    const rejected = await sink.emit([nextEvent()]);
    expect(rejected).toEqual({ accepted: 1, rejected: 0, errors: [] });
    expect(await spool.size()).toBe(1);
    // The exporter may retry a retryable 503 internally before giving up; what
    // matters here is that every attempt failed and the batch got spooled.
    expect(collector.requests.length).toBeGreaterThanOrEqual(1);

    // The collector recovers; a later drain should deliver the spooled batch.
    let up = false;
    const recoveredCollector = await startCapturingCollector(() => (up ? { status: 200 } : { status: 503 }));
    closers.push(() => new Promise<void>((resolve) => recoveredCollector.server.close(() => resolve())));
    up = true;

    const drainSink = createOtlpTraceSink({
      exporter: { ...DEFAULT_EXPORTER_POLICY, endpoint: recoveredCollector.url, timeoutMillis: 2_000 },
      providerId: "acme-cli",
      installationId: "install-1",
      clock,
      spool,
    });
    const drainResult = await drainSink.drainSpool();
    expect(drainResult).toEqual({ drained: 1, remaining: 0, failed: 0 });
    expect(recoveredCollector.requests).toHaveLength(1);
    expect(await spool.size()).toBe(0);

    await sink.shutdown();
    await drainSink.shutdown();
  });
});
