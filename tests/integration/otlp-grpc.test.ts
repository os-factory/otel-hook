import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { status as GrpcStatus } from "@grpc/grpc-js";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_EXPORTER_POLICY } from "../../src/config/schema.js";
import { parseCanonicalEvent } from "../../src/model/events.js";
import { CANONICAL_SCHEMA_VERSION } from "../../src/model/version.js";
import { createFixedClock } from "../../src/runtime/clock.js";
import { createFileDurableSpool } from "../../src/telemetry/durable-spool.js";
import { createOtlpTraceSink } from "../../src/telemetry/otlp-sink.js";
import { createTestIdentity } from "../../src/testing/index.js";
import { startCapturingCollector } from "../helpers/collector.js";
import { startGrpcTraceReceiver, type GrpcExportDecision } from "../helpers/grpc-collector.js";
import { decodeExportedSpans } from "../helpers/otlp.js";

const identity = createTestIdentity();
let index = 0;
const nextEvent = (kind: "prompt" | "error" = "prompt") => {
  index += 1;
  const shared = {
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    invocationId: identity.invocationId,
    sessionId: identity.sessionId,
    provenance: identity.provenance,
    workspace: identity.workspace,
    extensions: {},
    eventId: `g${String(index)}`,
    sequence: index,
    occurredAt: 1_000 + index,
  };
  return parseCanonicalEvent(
    kind === "error"
      ? {
          ...shared,
          type: "error.raised",
          errorCode: "internal-error",
          severity: "error",
          phase: "export",
          retryable: false,
        }
      : { ...shared, type: "prompt.submitted", promptSource: "user" },
  );
};

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const grpcSink = (
  endpoint: string,
  extra: {
    readonly headers?: Readonly<Record<string, string>>;
    readonly timeoutMillis?: number;
    readonly spool?: ReturnType<typeof createFileDurableSpool>;
    readonly resourceAttributes?: Readonly<Record<string, string>>;
    readonly serviceName?: string;
  } = {},
) =>
  createOtlpTraceSink({
    exporter: {
      ...DEFAULT_EXPORTER_POLICY,
      protocol: "grpc",
      endpoint,
      timeoutMillis: extra.timeoutMillis ?? 2_000,
      maxRetryAttempts: 0,
      ...(extra.serviceName === undefined ? {} : { serviceName: extra.serviceName }),
      ...(extra.resourceAttributes === undefined
        ? {}
        : { resourceAttributes: extra.resourceAttributes }),
    },
    ...(extra.headers === undefined ? {} : { headers: extra.headers }),
    ...(extra.spool === undefined ? {} : { spool: extra.spool }),
    providerId: "acme-cli",
    installationId: "install-1",
    clock: createFixedClock(),
  });

describe("OTLP/gRPC trace delivery", () => {
  it("sends headers and a protobuf export the receiver can decode", async () => {
    const receiver = await startGrpcTraceReceiver();
    closers.push(() => receiver.close());
    const sink = grpcSink(receiver.url, {
      headers: { authorization: "Bearer synthetic-token", "x-otel-hook": "trace" },
      serviceName: "grpc-traces",
      resourceAttributes: { "deployment.environment": "test" },
    });

    const result = await sink.emit([nextEvent("prompt"), nextEvent("error")]);
    expect(result).toEqual({ accepted: 2, rejected: 0, errors: [] });
    expect(receiver.requests).toHaveLength(1);
    const [request] = receiver.requests;
    expect(request?.metadata["authorization"]).toBe("Bearer synthetic-token");
    expect(request?.metadata["x-otel-hook"]).toBe("trace");
    expect(request?.body[0]).toBe(0x0a);

    const spans = decodeExportedSpans(request?.body ?? Buffer.alloc(0));
    const prompt = spans.find((span) => span.name === "prompt");
    const error = spans.find((span) => span.name === "error");
    expect(prompt?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(prompt?.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(prompt?.parentSpanId).toMatch(/^[0-9a-f]{16}$/);
    expect(prompt?.attributes["session.id"]).toBe(identity.sessionId);
    expect(prompt?.attributes["otelhook.prompt.source"]).toBe("user");
    expect(prompt?.statusCode).toBe(0);
    expect(prompt?.links).toEqual([]);
    expect(prompt?.resourceAttributes["service.name"]).toBe("grpc-traces");
    expect(prompt?.resourceAttributes["deployment.environment"]).toBe("test");
    expect(error?.statusCode).toBe(2);
    expect(error?.attributes["error.type"]).toBe("internal-error");
    expect(error?.links).toEqual([]);
    await sink.shutdown();
    await sink.shutdown();
  });

  it("spools a retryable gRPC status and refuses a terminal one", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "otel-hook-grpc-class-"));
    closers.push(() => rm(rootDir, { recursive: true, force: true }));
    const clock = createFixedClock();
    const spool = createFileDurableSpool({
      rootDir,
      providerId: "acme-cli",
      installationId: "install-1",
      clock,
    });

    const unavailable = await startGrpcTraceReceiver(
      (): GrpcExportDecision => ({ action: "status", code: GrpcStatus.UNAVAILABLE }),
    );
    closers.push(() => unavailable.close());
    const retryable = await grpcSink(unavailable.url, { spool }).emit([nextEvent()]);
    expect(retryable).toEqual({ accepted: 1, rejected: 0, errors: [] });
    expect(await spool.size()).toBe(1);

    const invalid = await startGrpcTraceReceiver(
      (): GrpcExportDecision => ({ action: "status", code: GrpcStatus.INVALID_ARGUMENT }),
    );
    closers.push(() => invalid.close());
    const terminal = await grpcSink(invalid.url, { spool }).emit([nextEvent()]);
    expect(terminal.rejected).toBe(1);
    expect(terminal.errors[0]?.details?.["export.retryable"]).toBe(false);
    expect(terminal.errors[0]?.posture).toBe("fail-open");
    expect(await spool.size()).toBe(1);
  });

  it("classifies a deadline as retryable and does not throw", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "otel-hook-grpc-deadline-"));
    closers.push(() => rm(rootDir, { recursive: true, force: true }));
    const receiver = await startGrpcTraceReceiver((): GrpcExportDecision => ({ action: "hold" }));
    closers.push(() => receiver.close());
    const spool = createFileDurableSpool({
      rootDir,
      providerId: "acme-cli",
      installationId: "install-1",
      clock: createFixedClock(),
    });
    const sink = grpcSink(receiver.url, { timeoutMillis: 300, spool });
    const result = await sink.emit([nextEvent()]);
    expect(result).toEqual({ accepted: 1, rejected: 0, errors: [] });
    expect(await spool.size()).toBe(1);
    expect(sink.health().consecutiveFailures).toBeGreaterThanOrEqual(1);
    await sink.shutdown();
  }, 10_000);

  it("fails open on a TLS handshake against a plaintext server", async () => {
    const receiver = await startGrpcTraceReceiver();
    closers.push(() => receiver.close());
    const tlsUrl = receiver.url.replace("http://", "https://");
    const sink = grpcSink(tlsUrl, { timeoutMillis: 1_000 });
    const result = await sink.emit([nextEvent()]);
    expect(result.accepted + result.rejected).toBe(1);
    expect(result.errors[0]?.code).toBe("telemetry-export-failure");
    expect(result.errors[0]?.posture).toBe("fail-open");
    expect(typeof result.errors[0]?.details?.["export.retryable"]).toBe("boolean");
    expect(sink.health().lastErrorCode).toBe("telemetry-export-failure");
    await sink.shutdown();
  }, 10_000);

  it("fails open when nothing is listening", async () => {
    const sink = grpcSink("http://127.0.0.1:1", { timeoutMillis: 300 });
    const result = await sink.emit([nextEvent()]);
    expect(result.accepted).toBe(0);
    expect(result.rejected).toBe(1);
    expect(result.errors[0]?.code).toBe("telemetry-export-failure");
    expect(result.errors[0]?.posture).toBe("fail-open");
    await sink.shutdown();
  }, 10_000);

  it("replays one spool through gRPC and HTTP/protobuf without changing the batch", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "otel-hook-grpc-replay-"));
    closers.push(() => rm(rootDir, { recursive: true, force: true }));
    const clock = createFixedClock();
    const spool = createFileDurableSpool({
      rootDir,
      providerId: "acme-cli",
      installationId: "install-1",
      clock,
    });

    const down = await startCapturingCollector(() => ({ status: 503 }));
    closers.push(() => down.close());
    const httpSink = createOtlpTraceSink({
      exporter: {
        ...DEFAULT_EXPORTER_POLICY,
        endpoint: down.url,
        timeoutMillis: 2_000,
        maxRetryAttempts: 0,
        serviceName: "shared-spool",
      },
      providerId: "acme-cli",
      installationId: "install-1",
      clock,
      spool,
    });
    expect(await httpSink.emit([nextEvent()])).toEqual({ accepted: 1, rejected: 0, errors: [] });
    expect(await spool.size()).toBe(1);

    const receiver = await startGrpcTraceReceiver();
    closers.push(() => receiver.close());
    const drain = await grpcSink(receiver.url, { spool, serviceName: "shared-spool" }).drainSpool();
    expect(drain).toEqual({ drained: 1, remaining: 0, failed: 0, quarantined: 0 });
    expect(await spool.size()).toBe(0);
    const [replayed] = decodeExportedSpans(receiver.requests[0]?.body ?? Buffer.alloc(0));
    expect(replayed?.name).toBe("prompt");
    expect(replayed?.resourceAttributes["service.name"]).toBe("shared-spool");
    expect(replayed?.attributes["session.id"]).toBe(identity.sessionId);
    expect(replayed?.links).toEqual([]);

    const refused = await startGrpcTraceReceiver(
      (): GrpcExportDecision => ({ action: "status", code: GrpcStatus.UNAVAILABLE }),
    );
    closers.push(() => refused.close());
    const grpcDown = grpcSink(refused.url, { spool, serviceName: "shared-spool" });
    expect(await grpcDown.emit([nextEvent("error")])).toEqual({ accepted: 1, rejected: 0, errors: [] });

    const up = await startCapturingCollector();
    closers.push(() => up.close());
    const httpDrain = createOtlpTraceSink({
      exporter: {
        ...DEFAULT_EXPORTER_POLICY,
        endpoint: up.url,
        timeoutMillis: 2_000,
        serviceName: "shared-spool",
      },
      providerId: "acme-cli",
      installationId: "install-1",
      clock,
      spool,
    });
    expect(await httpDrain.drainSpool()).toEqual({ drained: 1, remaining: 0, failed: 0, quarantined: 0 });
    const [fromGrpc] = decodeExportedSpans(up.bodies()[0] ?? Buffer.alloc(0));
    expect(fromGrpc?.name).toBe("error");
    expect(fromGrpc?.statusCode).toBe(2);
    expect(fromGrpc?.links).toEqual([]);
    await httpSink.shutdown();
    await grpcDown.shutdown();
    await httpDrain.shutdown();
  });
});
