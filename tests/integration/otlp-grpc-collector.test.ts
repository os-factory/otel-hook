import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_EXPORTER_POLICY } from "../../src/config/schema.js";
import { parseCanonicalEvent } from "../../src/model/events.js";
import { CANONICAL_SCHEMA_VERSION } from "../../src/model/version.js";
import { createFixedClock } from "../../src/runtime/clock.js";
import { createOtlpTraceSink } from "../../src/telemetry/otlp-sink.js";
import { createTestIdentity } from "../../src/testing/index.js";
import { startCapturingCollector } from "../helpers/collector.js";
import { officialCollectorAvailable, startOfficialCollector } from "../helpers/official-collector.js";
import { decodeExportedSpans } from "../helpers/otlp.js";

const identity = createTestIdentity();
const event = (kind: "prompt" | "error") =>
  parseCanonicalEvent(
    kind === "error"
      ? {
          schemaVersion: CANONICAL_SCHEMA_VERSION,
          invocationId: identity.invocationId,
          sessionId: identity.sessionId,
          provenance: identity.provenance,
          workspace: identity.workspace,
          extensions: {},
          eventId: "collector-error",
          sequence: 2,
          occurredAt: 2_000,
          type: "error.raised",
          errorCode: "internal-error",
          severity: "error",
          phase: "export",
          retryable: false,
        }
      : {
          schemaVersion: CANONICAL_SCHEMA_VERSION,
          invocationId: identity.invocationId,
          sessionId: identity.sessionId,
          provenance: identity.provenance,
          workspace: identity.workspace,
          extensions: {},
          eventId: "collector-prompt",
          sequence: 1,
          occurredAt: 1_000,
          type: "prompt.submitted",
          promptSource: "user",
        },
  );

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe("OTLP/gRPC against the OpenTelemetry Collector", () => {
  it.skipIf(!officialCollectorAvailable())(
    "forwards resources, spans, links, status, and attributes",
    async () => {
      const http = await startCapturingCollector();
      closers.push(() => http.close());
      const collector = await startOfficialCollector(http.baseUrl);
      if (collector === undefined) {
        throw new Error("docker reported ready and then could not start otelcol");
      }
      closers.push(() => collector.close());

      const sink = createOtlpTraceSink({
        exporter: {
          ...DEFAULT_EXPORTER_POLICY,
          protocol: "grpc",
          endpoint: collector.grpcUrl,
          timeoutMillis: 10_000,
          serviceName: "collector-traces",
          resourceAttributes: { "deployment.environment": "ci" },
        },
        providerId: "acme-cli",
        installationId: "install-1",
        clock: createFixedClock(),
      });

      const result = await sink.emit([event("prompt"), event("error")]);
      expect(result).toEqual({ accepted: 2, rejected: 0, errors: [] });
      const deadline = Date.now() + 5_000;
      while (http.requests.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(http.requests.length).toBeGreaterThan(0);

      const spans = http.bodies().flatMap((body) => decodeExportedSpans(body));
      const prompt = spans.find((span) => span.name === "prompt");
      const raised = spans.find((span) => span.name === "error");
      expect(prompt?.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(prompt?.spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(prompt?.parentSpanId).toMatch(/^[0-9a-f]{16}$/);
      expect(prompt?.attributes["session.id"]).toBe(identity.sessionId);
      expect(prompt?.attributes["otelhook.prompt.source"]).toBe("user");
      expect(prompt?.statusCode).toBe(0);
      expect(prompt?.links).toEqual([]);
      expect(prompt?.resourceAttributes["service.name"]).toBe("collector-traces");
      expect(prompt?.resourceAttributes["deployment.environment"]).toBe("ci");
      expect(raised?.statusCode).toBe(2);
      expect(raised?.attributes["error.type"]).toBe("internal-error");
      expect(raised?.links).toEqual([]);
      await sink.shutdown();
    },
    40_000,
  );
});
