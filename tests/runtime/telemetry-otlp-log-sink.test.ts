import { describe, expect, it } from "vitest";

import { DEFAULT_EXPORTER_POLICY, type ExporterPolicy } from "../../src/config/schema.js";
import { parseCanonicalEvent } from "../../src/model/events.js";
import { CANONICAL_SCHEMA_VERSION } from "../../src/model/version.js";
import { createFixedClock } from "../../src/runtime/clock.js";
import { createRecordingLogger } from "../../src/runtime/memory.js";
import {
  createOtlpLogSink,
  describeLogsDeliverability,
  resolveLogsEndpoint,
} from "../../src/telemetry/otlp-log-sink.js";
import { createTestIdentity } from "../../src/testing/index.js";

const identity = createTestIdentity();
const events = [
  parseCanonicalEvent({
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    invocationId: identity.invocationId,
    sessionId: identity.sessionId,
    provenance: identity.provenance,
    workspace: identity.workspace,
    extensions: {},
    eventId: "e1",
    sequence: 0,
    occurredAt: 1_000,
    type: "prompt.submitted",
    promptSource: "user",
  }),
];

const policy = (patch: Partial<ExporterPolicy> = {}): ExporterPolicy => ({
  ...DEFAULT_EXPORTER_POLICY,
  ...patch,
});

const withLogs = (
  logs: Partial<ExporterPolicy["logs"]>,
  patch: Partial<ExporterPolicy> = {},
): ExporterPolicy => policy({ ...patch, logs: { ...DEFAULT_EXPORTER_POLICY.logs, ...logs } });

describe("resolveLogsEndpoint", () => {
  it("uses an explicit logs endpoint verbatim", () => {
    expect(
      resolveLogsEndpoint(
        withLogs({ endpoint: "http://collector:4318/custom/logs" }, { endpoint: "http://a:4318/v1/traces" }),
      ),
    ).toEqual({ endpoint: "http://collector:4318/custom/logs", derived: false });
  });

  it("swaps a trailing /v1/traces for /v1/logs", () => {
    expect(resolveLogsEndpoint(policy({ endpoint: "http://collector:4318/v1/traces" }))).toEqual({
      endpoint: "http://collector:4318/v1/logs",
      derived: true,
    });
  });

  it("appends the signal path to an endpoint that carries none", () => {
    expect(resolveLogsEndpoint(policy({ endpoint: "http://collector:4318" }))).toEqual({
      endpoint: "http://collector:4318/v1/logs",
      derived: true,
    });
    // A trailing slash must not produce a doubled separator.
    expect(resolveLogsEndpoint(policy({ endpoint: "http://collector:4318/" }))).toEqual({
      endpoint: "http://collector:4318/v1/logs",
      derived: true,
    });
  });

  it("leaves an endpoint that is already the logs path alone", () => {
    expect(resolveLogsEndpoint(policy({ endpoint: "http://collector:4318/v1/logs" }))).toEqual({
      endpoint: "http://collector:4318/v1/logs",
      derived: true,
    });
  });

  it("reports that nothing could be derived when there is no endpoint at all", () => {
    expect(resolveLogsEndpoint(policy({ endpoint: undefined }))).toEqual({
      unresolvable: "no-endpoint",
    });
  });

  it("never posts logs to a traces path", () => {
    // The one property that matters across every branch above: an
    // ExportLogsServiceRequest reaching a traces receiver is a configuration bug
    // whose symptom looks like a collector fault.
    for (const endpoint of [
      "http://c:4318/v1/traces",
      "http://c:4318/v1/traces/",
      "http://c:4318",
      "http://c:4318/otlp",
    ]) {
      const resolved = resolveLogsEndpoint(policy({ endpoint }));
      expect("endpoint" in resolved && resolved.endpoint.endsWith("/v1/logs")).toBe(true);
    }
  });
});

describe("describeLogsDeliverability", () => {
  it("names each reason a configuration cannot deliver logs", () => {
    expect(describeLogsDeliverability(policy())).toEqual({
      status: "disabled",
      reason: "logs-disabled",
    });
    expect(
      describeLogsDeliverability(
        withLogs({ enabled: true }, { enabled: false, endpoint: "http://c:4318/v1/traces" }),
      ),
    ).toEqual({ status: "disabled", reason: "exporter-disabled" });
    expect(
      describeLogsDeliverability(withLogs({ enabled: true }, { protocol: "none", endpoint: "http://c:4318" })),
    ).toEqual({ status: "disabled", reason: "protocol-none" });
    expect(
      describeLogsDeliverability(
        withLogs({ enabled: true }, { protocol: "http/json", endpoint: "http://c:4318" }),
      ),
    ).toEqual({ status: "disabled", reason: "protocol-unsupported" });
    expect(describeLogsDeliverability(withLogs({ enabled: true }, { endpoint: undefined }))).toEqual({
      status: "disabled",
      reason: "no-endpoint",
    });
  });

  it("reports a configured pipeline and whether its endpoint was derived", () => {
    expect(
      describeLogsDeliverability(withLogs({ enabled: true }, { endpoint: "http://c:4318/v1/traces" })),
    ).toEqual({ status: "configured", endpoint: "http://c:4318/v1/logs", derivedEndpoint: true });
    expect(
      describeLogsDeliverability(
        withLogs({ enabled: true, endpoint: "http://c:4319/v1/logs" }, { endpoint: "http://c:4318/v1/traces" }),
      ),
    ).toEqual({ status: "configured", endpoint: "http://c:4319/v1/logs", derivedEndpoint: false });
  });
});

describe("createOtlpLogSink: degraded configurations never throw", () => {
  const build = (exporter: ExporterPolicy, logger = createRecordingLogger()) => ({
    logger,
    sink: createOtlpLogSink({
      exporter,
      providerId: "acme",
      installationId: "install-1",
      clock: createFixedClock(),
      logger,
    }),
  });

  it("contributes no durability counts while logs are off", async () => {
    // The default posture. Zero accepted *and* zero rejected, so an installation
    // with logs disabled has its commit-or-retry decision made entirely by traces —
    // exactly as it was before logs existed.
    const { sink, logger } = build(policy());
    expect(await sink.emit(events)).toEqual({ accepted: 0, rejected: 0, errors: [] });
    // A disabled signal is not unhealthy, and the default posture is not a warning.
    expect(sink.health().healthy).toBe(true);
    expect(logger.records()).toEqual([]);
    await sink.flush();
    await sink.shutdown();
    await sink.shutdown();
  });

  it("warns when logs were asked for but cannot be routed", async () => {
    const { sink, logger } = build(withLogs({ enabled: true }, { endpoint: undefined }));
    expect((await sink.emit(events)).rejected).toBe(0);
    expect(logger.records().some((record) => record.message.includes("no logs endpoint"))).toBe(true);
  });

  it("falls back to a no-op sink for a protocol without a wired exporter", async () => {
    const { sink, logger } = build(
      withLogs({ enabled: true }, { protocol: "http/json", endpoint: "http://127.0.0.1:4318" }),
    );
    expect((await sink.emit(events)).accepted).toBe(0);
    expect(logger.records().some((record) => record.message.includes("not supported"))).toBe(true);
  });

  it("drainSpool is a safe no-op when no spool is configured", async () => {
    const { sink } = build(policy());
    expect(await sink.drainSpool()).toEqual({ drained: 0, remaining: 0, failed: 0 });
  });

  it("accepts an empty batch without contacting the collector", async () => {
    const { sink } = build(withLogs({ enabled: true }, { endpoint: "http://127.0.0.1:1/v1/traces" }));
    expect(await sink.emit([])).toEqual({ accepted: 0, rejected: 0, errors: [] });
    await sink.shutdown();
  });

  it("reports export failures against an unreachable collector without throwing", async () => {
    const { sink } = build(
      withLogs(
        { enabled: true },
        { endpoint: "http://127.0.0.1:1/v1/traces", timeoutMillis: 300, maxRetryAttempts: 0 },
      ),
    );
    const result = await sink.emit(events);
    expect(result.accepted).toBe(0);
    expect(result.rejected).toBe(1);
    expect(result.errors[0]?.code).toBe("telemetry-export-failure");
    // The signal is named, so a diagnostic cannot be mistaken for a trace failure.
    expect(result.errors[0]?.details?.["export.signal"]).toBe("logs");
    expect(sink.health().subsystem).toBe("telemetry-log-sink");
    expect(sink.health().lastErrorCode).toBe("telemetry-export-failure");
    await sink.shutdown();
  }, 15_000);
});
