import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ExportDestinationConfig } from "../../src/config/destinations.js";
import { DEFAULT_CONFIG, DEFAULT_EXPORTER_POLICY, type ExporterPolicy } from "../../src/config/schema.js";
import { createHookRuntime, type HookRuntime } from "../../src/integration/hook-runtime.js";
import { createClaudeCodeAdapter } from "../../src/providers/claude/adapter.js";
import { createProviderRegistry } from "../../src/providers/registry.js";
import { createRecordingLogger } from "../../src/runtime/memory.js";
import { startCapturingCollector, type CapturingCollector } from "../helpers/collector.js";

/**
 * Destination fan-out inside one runtime: signal routing, durability across
 * destinations, and the unchanged single-destination shape. Payloads are synthetic.
 */

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const scratchDir = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), "otel-hook-destinations-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

const collector = async (
  respond?: Parameters<typeof startCapturingCollector>[0],
): Promise<CapturingCollector> => {
  const started = await startCapturingCollector(respond);
  cleanups.push(() => started.close());
  return started;
};

const promptPayload = (sessionId: string): Record<string, unknown> => ({
  hook_event_name: "UserPromptSubmit",
  session_id: sessionId,
  transcript_path: "/workspace/demo/.claude/transcript.jsonl",
  cwd: "/workspace/demo",
  prompt: "synthetic prompt",
});

const buildRuntime = async (
  exporter: Partial<ExporterPolicy>,
  options: {
    readonly headerEnvironment?: Readonly<Record<string, string>>;
    readonly headers?: Readonly<Record<string, string>>;
    readonly logHeaders?: Readonly<Record<string, string>>;
  } = {},
): Promise<{ readonly runtime: HookRuntime; readonly stateRootDir: string }> => {
  const stateRootDir = await scratchDir();
  const runtime = createHookRuntime({
    config: {
      ...DEFAULT_CONFIG,
      exporter: { ...DEFAULT_EXPORTER_POLICY, timeoutMillis: 1_000, ...exporter },
      detection: { ...DEFAULT_CONFIG.detection, minimumConfidence: "weak" },
    },
    registry: createProviderRegistry([createClaudeCodeAdapter()]),
    stateRootDir,
    installationId: "test-install",
    providerNamespace: "claude-code",
    logger: createRecordingLogger("debug"),
    ...(options.headerEnvironment === undefined ? {} : { headerEnvironment: options.headerEnvironment }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    ...(options.logHeaders === undefined ? {} : { logHeaders: options.logHeaders }),
  });
  cleanups.push(async () => {
    await runtime.shutdown();
  });
  return { runtime, stateRootDir };
};

const process_ = (runtime: HookRuntime, sessionId: string) =>
  runtime.process({
    payload: promptPayload(sessionId),
    transport: "hook-stdin",
    providerHint: "claude-code",
  });

describe("hook runtime: export destinations", () => {
  it("routes each signal only to the destinations that take it", async () => {
    const tracesOnly = await collector();
    const logsOnly = await collector();
    const destinations: ExportDestinationConfig[] = [
      { name: "traces-only", endpoint: tracesOnly.url, signals: ["traces"] },
      { name: "logs-only", endpoint: logsOnly.url, signals: ["logs"] },
    ];
    const { runtime } = await buildRuntime({
      destinations,
      logs: { ...DEFAULT_EXPORTER_POLICY.logs, enabled: true },
    });

    const outcome = await process_(runtime, "ses-routing");
    await runtime.shutdown();

    expect(outcome.ingest.durability).toBe("delivered");
    expect(tracesOnly.requests.map((request) => request.path)).toEqual(["/v1/traces"]);
    expect(logsOnly.requests.map((request) => request.path)).toEqual(["/v1/logs"]);
    expect(runtime.destinations.map((destination) => destination.name)).toEqual([
      "traces-only",
      "logs-only",
    ]);
    expect(runtime.health().subsystems.map((snapshot) => snapshot.destination)).toEqual([
      "traces-only",
      "traces-only",
      "logs-only",
      "logs-only",
    ]);
  });

  it("commits a callback one destination refused outright as partial, never as lost", async () => {
    const accepting = await collector();
    const refusing = await collector(() => ({ status: 400 }));
    const { runtime, stateRootDir } = await buildRuntime({
      destinations: [
        { name: "accepting", endpoint: accepting.url },
        { name: "refusing", endpoint: refusing.url },
      ],
    });

    const outcome = await process_(runtime, "ses-partial");
    await runtime.shutdown();

    // Retrying would re-export to the destination that already accepted.
    expect(outcome.ingest.durability).toBe("partial");
    expect(outcome.ingest.diagnostics.some((info) => info.details?.["export.destination"] === "refusing")).toBe(
      true,
    );
    expect(accepting.requests).toHaveLength(1);
    // A non-retryable refusal is not spooled: it could only fail the same way again.
    const queue = path.join(stateRootDir, "claude-code", "test-install", "destinations", "refusing", "spool");
    const queued = await readdir(queue).catch(() => []);
    expect(queued.filter((entry) => entry.endsWith(".json"))).toEqual([]);
  });

  it("skips a destination whose header variable is unset, and still delivers to the rest", async () => {
    const open = await collector();
    const authed = await collector();
    const { runtime } = await buildRuntime(
      {
        destinations: [
          { name: "open", endpoint: open.url },
          { name: "authed", endpoint: authed.url, headers: { authorization: "env:SYNTHETIC_TOKEN" } },
        ],
      },
      { headerEnvironment: {} },
    );

    const outcome = await process_(runtime, "ses-skip");
    await runtime.shutdown();

    expect(runtime.skippedDestinations).toEqual([
      { name: "authed", reason: "header-variable-missing", missingVariables: ["SYNTHETIC_TOKEN"] },
    ]);
    expect(outcome.ingest.durability).toBe("delivered");
    expect(open.requests).toHaveLength(1);
    expect(authed.requests).toHaveLength(0);
  });

  it("sends the per-signal OTEL_EXPORTER_OTLP_*_HEADERS values to the default destination only", async () => {
    // What `resolveOtlpHeaders` hands the runtime: traces and logs header values
    // that differ. The list entry sends exactly the headers it lists.
    const legacy = await collector();
    const listed = await collector();
    const { runtime } = await buildRuntime(
      {
        endpoint: legacy.url,
        destinations: [{ name: "listed", endpoint: listed.url, headers: { "x-tenant": "synthetic" } }],
        logs: { ...DEFAULT_EXPORTER_POLICY.logs, enabled: true },
      },
      { headers: { "x-signal": "traces-value" }, logHeaders: { "x-signal": "logs-value" } },
    );

    await process_(runtime, "ses-default-headers");
    await runtime.shutdown();

    const header = (requests: CapturingCollector["requests"], signalPath: string) =>
      requests.filter((request) => request.path === signalPath).map((request) => request.headers["x-signal"]);
    expect(header(legacy.requests, "/v1/traces")).toEqual(["traces-value"]);
    expect(header(legacy.requests, "/v1/logs")).toEqual(["logs-value"]);
    expect(listed.requests.length).toBeGreaterThan(0);
    expect(listed.requests.every((request) => request.headers["x-signal"] === undefined)).toBe(true);
    expect(listed.requests.every((request) => request.headers["x-tenant"] === "synthetic")).toBe(true);
  });

  it("keeps the single-destination runtime exactly as it was without a list", async () => {
    const only = await collector();
    const { runtime, stateRootDir } = await buildRuntime({ endpoint: only.url });

    await process_(runtime, "ses-legacy");
    await runtime.shutdown();

    expect(runtime.destinations.map((destination) => destination.name)).toEqual(["default"]);
    expect(runtime.sink).toBe(runtime.destinations[0]?.traces);
    // No destination label on a snapshot nobody asked to be labelled.
    expect(runtime.health().subsystems.every((snapshot) => snapshot.destination === undefined)).toBe(true);
    expect(only.requests).toHaveLength(1);
    // The default destination's spool keeps its original directory.
    expect(runtime.spool).toBeDefined();
    expect(await readdir(path.join(stateRootDir, "claude-code", "test-install"))).not.toContain(
      "destinations",
    );
  });
});
