import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, DEFAULT_EXPORTER_POLICY } from "../../src/config/schema.js";
import { createHookRuntime } from "../../src/integration/hook-runtime.js";
import { createClaudeCodeAdapter } from "../../src/providers/claude/adapter.js";
import { createProviderRegistry } from "../../src/providers/registry.js";
import { createRecordingLogger } from "../../src/runtime/memory.js";
import { isPermanentExportFailure } from "../../src/telemetry/export-failure.js";
import { resourceFromExporterPolicy } from "../../src/telemetry/exporter-resource.js";
import { assembleReadableSpan, DEFAULT_INSTRUMENTATION_SCOPE } from "../../src/telemetry/semconv.js";
import { startCapturingCollector, type CapturingCollector } from "../helpers/collector.js";

/**
 * `isPermanentExportFailure` against the real OTLP/HTTP trace exporter, not a
 * hand-built `ExportResult`: the classification depends on where the exporter
 * puts the HTTP status on its error, which is the exporter's contract to change.
 * One synthetic span; nothing here is a real payload.
 */

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const collector = async (status: number): Promise<CapturingCollector> => {
  const started = await startCapturingCollector(() => ({ status }));
  cleanups.push(() => started.close());
  return started;
};

const syntheticSpan = () =>
  assembleReadableSpan({
    name: "synthetic",
    kind: SpanKind.INTERNAL,
    startMillis: 1_700_000_000_000,
    endMillis: 1_700_000_000_001,
    attributes: {},
    status: { code: SpanStatusCode.OK },
    traceId: "1".repeat(32),
    spanId: "2".repeat(16),
    resource: resourceFromExporterPolicy(DEFAULT_EXPORTER_POLICY),
    instrumentationScope: DEFAULT_INSTRUMENTATION_SCOPE,
  });

const exportTo = async (url: string): Promise<ExportResult> => {
  // A short timeout: the exporter's own retries of 429/502/503/504 back off by
  // about a second, so this makes it give up after the first answer.
  const exporter = new OTLPTraceExporter({ url, timeoutMillis: 500 });
  try {
    return await new Promise<ExportResult>((resolve) => {
      exporter.export([syntheticSpan()], resolve);
    });
  } finally {
    await exporter.shutdown();
  }
};

describe("isPermanentExportFailure with the real OTLP exporter", () => {
  it.each([400, 401, 403, 404, 413])("treats HTTP %i as a permanent refusal", async (status) => {
    const receiver = await collector(status);
    const result = await exportTo(receiver.url);
    expect(result.code).toBe(ExportResultCode.FAILED);
    // The exporter puts the HTTP status on its error as a numeric `code`.
    expect((result.error as { code?: unknown } | undefined)?.code).toBe(status);
    expect(isPermanentExportFailure(result)).toBe(true);
    expect(receiver.requests).toHaveLength(1);
  });

  it.each([408, 500])("treats HTTP %i as retryable although the exporter reports its status", async (status) => {
    const receiver = await collector(status);
    const result = await exportTo(receiver.url);
    expect(result.code).toBe(ExportResultCode.FAILED);
    expect((result.error as { code?: unknown } | undefined)?.code).toBe(status);
    expect(isPermanentExportFailure(result)).toBe(false);
  });

  it.each([429, 502, 503, 504])("treats HTTP %i as retryable; the exporter reports no status", async (status) => {
    const receiver = await collector(status);
    const result = await exportTo(receiver.url);
    expect(result.code).toBe(ExportResultCode.FAILED);
    expect((result.error as { code?: unknown } | undefined)?.code).toBeUndefined();
    expect(isPermanentExportFailure(result)).toBe(false);
  });

  it("treats a refused connection as retryable", async () => {
    const closed = await startCapturingCollector();
    await closed.close();
    const result = await exportTo(closed.url);
    expect(result.code).toBe(ExportResultCode.FAILED);
    expect(isPermanentExportFailure(result)).toBe(false);
  });
});

describe("spooling by HTTP status, through the runtime", () => {
  it.each([
    { status: 500, spooled: 1 },
    { status: 503, spooled: 1 },
    { status: 400, spooled: 0 },
  ])("a batch answered $status is spooled $spooled time(s)", async ({ status, spooled }) => {
    const receiver = await collector(status);
    const stateRootDir = await mkdtemp(path.join(tmpdir(), "otel-hook-export-failure-"));
    cleanups.push(() => rm(stateRootDir, { recursive: true, force: true }));
    const runtime = createHookRuntime({
      config: {
        ...DEFAULT_CONFIG,
        exporter: { ...DEFAULT_EXPORTER_POLICY, endpoint: receiver.url, timeoutMillis: 500 },
        detection: { ...DEFAULT_CONFIG.detection, minimumConfidence: "weak" },
      },
      registry: createProviderRegistry([createClaudeCodeAdapter()]),
      stateRootDir,
      installationId: "test-install",
      providerNamespace: "claude-code",
      logger: createRecordingLogger("debug"),
    });
    const outcome = await runtime.process({
      payload: {
        hook_event_name: "UserPromptSubmit",
        session_id: `ses-status-${String(status)}`,
        transcript_path: "/workspace/demo/.claude/transcript.jsonl",
        cwd: "/workspace/demo",
        prompt: "synthetic prompt",
      },
      transport: "hook-stdin",
      providerHint: "claude-code",
    });
    await runtime.shutdown();

    expect(outcome.ingest.durability).toBe(spooled === 1 ? "delivered" : "lost");
    const queued = await readdir(path.join(stateRootDir, "claude-code", "test-install", "spool")).catch(
      () => [],
    );
    expect(queued.filter((entry) => entry.endsWith(".json"))).toHaveLength(spooled);
  });
});
