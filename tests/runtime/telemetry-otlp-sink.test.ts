import { describe, expect, it } from "vitest";

import { DEFAULT_EXPORTER_POLICY } from "../../src/config/schema.js";
import { createFixedClock } from "../../src/runtime/clock.js";
import { createRecordingLogger } from "../../src/runtime/memory.js";
import { createOtlpTraceSink } from "../../src/telemetry/otlp-sink.js";
import { createTestIdentity } from "../../src/testing/index.js";
import { parseCanonicalEvent } from "../../src/model/events.js";
import { CANONICAL_SCHEMA_VERSION } from "../../src/model/version.js";

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

describe("createOtlpTraceSink: degraded configurations never throw", () => {
  it("stays a no-op sink when the exporter is disabled", async () => {
    const sink = createOtlpTraceSink({
      exporter: { ...DEFAULT_EXPORTER_POLICY, enabled: false },
      providerId: "acme",
      installationId: "install-1",
      clock: createFixedClock(),
    });
    const result = await sink.emit(events);
    expect(result).toEqual({ accepted: 1, rejected: 0, errors: [] });
    expect(sink.health().healthy).toBe(true);
    await sink.flush();
    await sink.shutdown();
    await sink.shutdown();
  });

  it("stays a no-op sink when protocol is none", async () => {
    const sink = createOtlpTraceSink({
      exporter: { ...DEFAULT_EXPORTER_POLICY, protocol: "none" },
      providerId: "acme",
      installationId: "install-1",
      clock: createFixedClock(),
    });
    expect((await sink.emit(events)).accepted).toBe(1);
  });

  it("falls back to a no-op sink and logs a warning when no endpoint is configured", async () => {
    const logger = createRecordingLogger();
    const sink = createOtlpTraceSink({
      exporter: { ...DEFAULT_EXPORTER_POLICY, endpoint: undefined },
      providerId: "acme",
      installationId: "install-1",
      clock: createFixedClock(),
      logger,
    });
    expect((await sink.emit(events)).accepted).toBe(1);
    expect(logger.records().some((record) => record.message.includes("no endpoint"))).toBe(true);
  });

  it("falls back to a no-op sink for a protocol without a wired exporter", async () => {
    const logger = createRecordingLogger();
    const sink = createOtlpTraceSink({
      exporter: { ...DEFAULT_EXPORTER_POLICY, protocol: "http/json", endpoint: "http://127.0.0.1:4318" },
      providerId: "acme",
      installationId: "install-1",
      clock: createFixedClock(),
      logger,
    });
    expect((await sink.emit(events)).accepted).toBe(1);
    expect(logger.records().some((record) => record.message.includes("not supported"))).toBe(true);
  });

  it("drainSpool is a safe no-op when no spool is configured", async () => {
    const sink = createOtlpTraceSink({
      exporter: { ...DEFAULT_EXPORTER_POLICY, enabled: false },
      providerId: "acme",
      installationId: "install-1",
      clock: createFixedClock(),
    });
    expect(await sink.drainSpool()).toEqual({ drained: 0, remaining: 0, failed: 0 });
  });

  it("reports export failures against an unreachable collector without throwing", async () => {
    const sink = createOtlpTraceSink({
      exporter: {
        ...DEFAULT_EXPORTER_POLICY,
        endpoint: "http://127.0.0.1:1/v1/traces",
        timeoutMillis: 300,
        maxRetryAttempts: 0,
      },
      providerId: "acme",
      installationId: "install-1",
      clock: createFixedClock(),
    });
    const result = await sink.emit(events);
    expect(result.accepted).toBe(0);
    expect(result.rejected).toBe(1);
    expect(result.errors[0]?.code).toBe("telemetry-export-failure");
    expect(sink.health().consecutiveFailures).toBeGreaterThanOrEqual(1);
    expect(sink.health().lastErrorCode).toBe("telemetry-export-failure");
    await sink.shutdown();
  }, 10_000);
});
