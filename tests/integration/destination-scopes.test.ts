import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { ExportDestinationConfig } from "../../src/config/destinations.js";
import { DEFAULT_CONFIG, DEFAULT_EXPORTER_POLICY, type ExporterPolicy } from "../../src/config/schema.js";
import { createHookRuntime, type HookRuntime } from "../../src/integration/hook-runtime.js";
import { parseCanonicalEvent, type CanonicalEvent } from "../../src/model/events.js";
import { CANONICAL_SCHEMA_VERSION } from "../../src/model/version.js";
import { DEFAULT_PRIVACY_POLICY } from "../../src/privacy/policy.js";
import { createPrivacyService } from "../../src/privacy/service.js";
import { createClaudeCodeAdapter } from "../../src/providers/claude/adapter.js";
import { createProviderRegistry } from "../../src/providers/registry.js";
import { createSystemClock } from "../../src/runtime/clock.js";
import { createRecordingLogger } from "../../src/runtime/memory.js";
import type { SessionContextReader } from "../../src/runtime/ports.js";
import { createDestinationFanout, createExportDestinationSinks } from "../../src/telemetry/export-destinations.js";
import { createTestIdentity } from "../../src/testing/index.js";
import { startCapturingCollector, type CapturingCollector } from "../helpers/collector.js";
import { decodeAllExportedLogRecords, decodeAllExportedSpans } from "../helpers/otlp.js";

/**
 * Per-repository destination scopes, end to end through real sinks and a local
 * capturing collector: what a scoped destination receives and spools, next to an
 * unscoped one that keeps receiving everything. Every payload is synthetic; the
 * repository URLs are invented.
 */

const REPO_A = "https://github.com/synthetic-org/repo-a";
const REPO_B = "https://github.com/synthetic-org/repo-b";
const SECRET = "sk-synthetic0000000000000000000000";

type DecodedMetricPoint = {
  readonly name: string;
  readonly attributes: Readonly<Record<string, unknown>>;
};
let decodeAllExportedMetrics: (bodies: readonly Buffer[]) => DecodedMetricPoint[];

beforeAll(async () => {
  const decoderUrl = pathToFileURL(path.join(process.cwd(), "scripts", "e2e-proof", "otlp-decode.mjs")).href;
  const decoder = (await import(decoderUrl)) as { decodeAllExportedMetrics: typeof decodeAllExportedMetrics };
  decodeAllExportedMetrics = decoder.decodeAllExportedMetrics;
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const scratchDir = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), "otel-hook-scopes-"));
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

/** Session context per session id: which repository a session works in. */
const contextReader = (repositories: Readonly<Record<string, string>>): SessionContextReader => ({
  read: (request) => {
    const repository = repositories[request.sessionId];
    return Promise.resolve(
      repository === undefined
        ? undefined
        : [{ from: 0, to: null, attributes: { "vcs.repository.url.full": repository } }],
    );
  },
});

const buildRuntime = async (
  exporter: Partial<ExporterPolicy>,
  repositories: Readonly<Record<string, string>>,
  resourceAttributes: Readonly<Record<string, string>> = {},
): Promise<{ readonly runtime: HookRuntime; readonly stateRootDir: string }> => {
  const stateRootDir = await scratchDir();
  const runtime = createHookRuntime({
    config: {
      ...DEFAULT_CONFIG,
      privacy: { ...DEFAULT_CONFIG.privacy, contentMode: "raw", allowRawContent: true },
      exporter: {
        ...DEFAULT_EXPORTER_POLICY,
        timeoutMillis: 1_000,
        resourceAttributes,
        logs: { ...DEFAULT_EXPORTER_POLICY.logs, enabled: true, includeContent: true },
        metrics: { enabled: false, temporality: "delta", includeSessionId: true },
        ...exporter,
      },
      detection: { ...DEFAULT_CONFIG.detection, minimumConfidence: "weak" },
    },
    registry: createProviderRegistry([createClaudeCodeAdapter()]),
    stateRootDir,
    installationId: "test-install",
    providerNamespace: "claude-code",
    logger: createRecordingLogger("debug"),
    sessionContextReader: contextReader(repositories),
    worktreeLocator: null,
  });
  cleanups.push(async () => {
    await runtime.shutdown();
  });
  return { runtime, stateRootDir };
};

const prompt = (sessionId: string): Record<string, unknown> => ({
  hook_event_name: "UserPromptSubmit",
  session_id: sessionId,
  transcript_path: "/tmp/synthetic/transcript.jsonl",
  cwd: "/workspace/synthetic",
  prompt: `deploy with ${SECRET} now`,
});

const sessionStart = (sessionId: string): Record<string, unknown> => ({
  hook_event_name: "SessionStart",
  session_id: sessionId,
  transcript_path: "/tmp/synthetic/transcript.jsonl",
  cwd: "/workspace/synthetic",
  source: "startup",
  model: "synthetic-model",
});

const postToolUse = (sessionId: string): Record<string, unknown> => ({
  hook_event_name: "PostToolUse",
  session_id: sessionId,
  transcript_path: "/tmp/synthetic/transcript.jsonl",
  cwd: "/workspace/synthetic",
  tool_use_id: `toolu_${sessionId}`,
  tool_name: "Bash",
  tool_response: "ok",
});

const send = (runtime: HookRuntime, payload: Record<string, unknown>) =>
  runtime.process({ payload, transport: "hook-stdin", providerHint: "claude-code" });

const repositoriesIn = (records: readonly { attributes: Readonly<Record<string, unknown>> }[]): string[] =>
  [...new Set(records.map((record) => String(record.attributes["vcs.repository.url.full"])))].sort();

const SESSIONS = { "ses-scope-a": REPO_A, "ses-scope-b": REPO_B } as const;

describe("hook runtime: destination scopes", () => {
  it("sends a scoped destination only its repositories, while an unscoped one gets everything", async () => {
    const local = await collector();
    const hosted = await collector();
    const destinations: ExportDestinationConfig[] = [
      { name: "local", endpoint: local.url },
      { name: "hosted", endpoint: hosted.url, scopes: [{ repositories: [`${REPO_A}.git`] }] },
    ];
    const { runtime } = await buildRuntime({ destinations }, SESSIONS);

    for (const sessionId of ["ses-scope-a", "ses-scope-b", "ses-scope-none"]) {
      const outcome = await send(runtime, prompt(sessionId));
      expect(outcome.ingest.durability).toBe("delivered");
    }
    await runtime.shutdown();

    const localSpans = decodeAllExportedSpans(local.bodiesFor("/v1/traces"));
    const hostedSpans = decodeAllExportedSpans(hosted.bodiesFor("/v1/traces"));
    expect(repositoriesIn(localSpans)).toEqual([REPO_A, REPO_B, "undefined"]);
    expect(repositoriesIn(hostedSpans)).toEqual([REPO_A]);
    expect(repositoriesIn(decodeAllExportedLogRecords(hosted.bodiesFor("/v1/logs")))).toEqual([REPO_A]);
    // The callbacks the scope filtered out entirely sent the hosted collector nothing.
    expect(hosted.requests).toHaveLength(2);
  });

  it("keeps span identity and cross-callback pairing identical across scoped and unscoped destinations", async () => {
    const local = await collector();
    const hosted = await collector();
    const { runtime } = await buildRuntime(
      {
        destinations: [
          { name: "local", endpoint: local.url },
          // A content restriction makes the scoped share a set of copies, not the batch.
          { name: "hosted", endpoint: hosted.url, scopes: [{ repositories: [REPO_A], contentMode: "omit" }] },
        ],
      },
      SESSIONS,
    );
    for (const sessionId of ["ses-scope-a", "ses-scope-b"]) {
      await send(runtime, {
        hook_event_name: "PreToolUse",
        session_id: sessionId,
        transcript_path: "/tmp/synthetic/transcript.jsonl",
        cwd: "/workspace/synthetic",
        tool_use_id: `toolu_${sessionId}`,
        tool_name: "Bash",
        tool_input: { command: "true" },
      });
      await send(runtime, postToolUse(sessionId));
    }
    await runtime.shutdown();

    const toolSpans = (bodies: readonly Buffer[]) =>
      decodeAllExportedSpans(bodies)
        .filter((span) => span.attributes["vcs.repository.url.full"] === REPO_A)
        .map((span) => `${span.traceId}/${span.spanId}/${span.name}`)
        .sort();
    const hostedSpans = toolSpans(hosted.bodiesFor("/v1/traces"));
    expect(hostedSpans.length).toBeGreaterThan(0);
    // One tool span, published once at its end edge, under the same ids everywhere.
    expect(hostedSpans).toEqual(toolSpans(local.bodiesFor("/v1/traces")));
    expect(new Set(hostedSpans).size).toBe(hostedSpans.length);
  });

  it("uses the Resource's repository for records the session context does not stamp", async () => {
    const hosted = await collector();
    const { runtime } = await buildRuntime(
      { destinations: [{ name: "hosted", endpoint: hosted.url, scopes: [{ repositories: [REPO_B] }] }] },
      { "ses-scope-a": REPO_A },
      { "vcs.repository.url.full": REPO_B },
    );
    await send(runtime, prompt("ses-scope-a"));
    await send(runtime, prompt("ses-scope-unstamped"));
    await runtime.shutdown();
    const spans = decodeAllExportedSpans(hosted.bodiesFor("/v1/traces"));
    expect(repositoriesIn(spans)).toEqual([REPO_B]);
    expect(spans.every((span) => span.attributes["session.id"] === "ses-scope-unstamped")).toBe(true);
  });

  it("restricts signals and content per destination while another gets raw content", async () => {
    const local = await collector();
    const hosted = await collector();
    const { runtime } = await buildRuntime(
      {
        destinations: [
          { name: "local", endpoint: local.url },
          {
            name: "hosted",
            endpoint: hosted.url,
            scopes: [
              { repositories: [REPO_A], contentMode: "redact" },
              { repositories: [REPO_B], signals: ["traces"], contentMode: "omit" },
            ],
          },
        ],
      },
      SESSIONS,
    );
    await send(runtime, prompt("ses-scope-a"));
    await send(runtime, prompt("ses-scope-b"));
    await runtime.shutdown();

    const bodies = (records: ReturnType<typeof decodeAllExportedLogRecords>, repository: string) =>
      records
        .filter((record) => record.attributes["vcs.repository.url.full"] === repository)
        .map((record) => record.body)
        .filter((body) => body !== undefined);

    const localLogs = decodeAllExportedLogRecords(local.bodiesFor("/v1/logs"));
    expect(bodies(localLogs, REPO_A).join(" ")).toContain(SECRET);
    expect(bodies(localLogs, REPO_B).join(" ")).toContain(SECRET);

    const hostedLogs = decodeAllExportedLogRecords(hosted.bodiesFor("/v1/logs"));
    // Repository B takes traces only: no log record at all.
    expect(repositoriesIn(hostedLogs)).toEqual([REPO_A]);
    expect(bodies(hostedLogs, REPO_A)).toEqual(["deploy with [redacted] now"]);
    expect(JSON.stringify(hosted.requests.map((request) => request.body.toString("latin1")))).not.toContain(SECRET);
    expect(repositoriesIn(decodeAllExportedSpans(hosted.bodiesFor("/v1/traces")))).toEqual([REPO_A, REPO_B]);
  });

  it("splits metric points per repository and drops session.id where a scope asks", async () => {
    const local = await collector();
    const hosted = await collector();
    const { runtime } = await buildRuntime(
      {
        destinations: [
          { name: "local", endpoint: local.url, signals: ["traces", "metrics"] },
          {
            name: "hosted",
            endpoint: hosted.url,
            signals: ["traces", "metrics"],
            scopes: [{ repositories: [REPO_A], includeSessionId: false }],
          },
        ],
      },
      SESSIONS,
    );
    for (const sessionId of ["ses-scope-a", "ses-scope-b", "ses-scope-none"]) {
      await send(runtime, sessionStart(sessionId));
      await send(runtime, postToolUse(sessionId));
    }
    await runtime.shutdown();

    const localPoints = decodeAllExportedMetrics(local.bodiesFor("/v1/metrics"));
    const hostedPoints = decodeAllExportedMetrics(hosted.bodiesFor("/v1/metrics"));
    expect(repositoriesIn(localPoints)).toEqual([REPO_A, REPO_B, "undefined"]);
    expect(localPoints.every((point) => typeof point.attributes["session.id"] === "string")).toBe(true);
    expect(repositoriesIn(hostedPoints)).toEqual([REPO_A]);
    expect(new Set(hostedPoints.map((point) => point.name))).toEqual(
      new Set(["otelhook.sessions", "otelhook.tool.calls"]),
    );
    expect(hostedPoints.some((point) => "session.id" in point.attributes)).toBe(false);
  });

  it("spools only what passed the scope when the scoped destination is down", async () => {
    const local = await collector();
    const hosted = await collector(() => ({ status: 503 }));
    const { runtime, stateRootDir } = await buildRuntime(
      {
        destinations: [
          { name: "local", endpoint: local.url },
          { name: "hosted", endpoint: hosted.url, scopes: [{ repositories: [REPO_A], contentMode: "omit" }] },
        ],
      },
      SESSIONS,
    );
    await send(runtime, prompt("ses-scope-a"));
    await send(runtime, prompt("ses-scope-b"));
    await runtime.shutdown();

    const root = path.join(stateRootDir, "claude-code", "test-install", "destinations", "hosted");
    const spooled: string[] = [];
    for (const queue of ["spool", "spool-logs"]) {
      const dir = path.join(root, queue);
      for (const entry of (await readdir(dir).catch(() => [])).filter((name) => name.endsWith(".json"))) {
        spooled.push(await readFile(path.join(dir, entry), "utf8"));
      }
    }
    expect(spooled.length).toBeGreaterThan(0);
    const all = spooled.join("\n");
    expect(all).toContain("synthetic-org/repo-a");
    expect(all).not.toContain("synthetic-org/repo-b");
    expect(all).not.toContain(SECRET);
  });
});

describe("destination fanout: one batch, two repositories", () => {
  const identity = createTestIdentity();
  let sequence = 0;
  const privacy = createPrivacyService({ ...DEFAULT_PRIVACY_POLICY, contentMode: "raw", allowRawContent: true });
  const build = (fields: Record<string, unknown>, repository?: string): CanonicalEvent =>
    parseCanonicalEvent({
      schemaVersion: CANONICAL_SCHEMA_VERSION,
      invocationId: identity.invocationId,
      sessionId: identity.sessionId,
      provenance: identity.provenance,
      workspace: identity.workspace,
      extensions: {},
      eventId: `fanout-${String((sequence += 1))}`,
      sequence,
      occurredAt: Date.now(),
      ...(repository === undefined ? {} : { contextAttributes: { "vcs.repository.url.full": repository } }),
      ...fields,
    });

  it("gives the scoped destination only its repository's records from a mixed batch", async () => {
    const local = await collector();
    const hosted = await collector();
    const { destinations } = createExportDestinationSinks({
      exporter: {
        ...DEFAULT_EXPORTER_POLICY,
        timeoutMillis: 1_000,
        logs: { ...DEFAULT_EXPORTER_POLICY.logs, enabled: true, includeContent: true },
        destinations: [
          { name: "local", endpoint: local.url },
          { name: "hosted", endpoint: hosted.url, scopes: [{ repositories: [REPO_A], contentMode: "mask" }] },
        ],
      },
      providerId: "claude-code",
      installationId: "test-install",
      clock: createSystemClock(),
      logContent: { includeContent: true, allowRawContent: true },
      restrictContent: (fact, mode) => privacy.restrictContent(fact, mode),
    });
    const sink = createDestinationFanout(destinations);
    const content = privacy.describeContent({ kind: "prompt", text: "two words" });
    const batch = [
      build({ type: "prompt.submitted", promptSource: "user", content }, REPO_A),
      build({ type: "prompt.submitted", promptSource: "user", content }, REPO_B),
      build({ type: "prompt.submitted", promptSource: "user", content }),
    ];
    const result = await sink.emit(batch);
    await sink.shutdown();

    expect(result.rejected).toBe(0);
    expect(repositoriesIn(decodeAllExportedSpans(local.bodiesFor("/v1/traces")))).toEqual([
      REPO_A,
      REPO_B,
      "undefined",
    ]);
    const hostedLogs = decodeAllExportedLogRecords(hosted.bodiesFor("/v1/logs"));
    expect(repositoriesIn(hostedLogs)).toEqual([REPO_A]);
    expect(hostedLogs.map((record) => record.body)).toEqual(["*** *****"]);
    expect(decodeAllExportedLogRecords(local.bodiesFor("/v1/logs")).map((record) => record.body)).toEqual([
      "two words",
      "two words",
      "two words",
    ]);
  });
});
