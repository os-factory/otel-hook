import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { ExportDestinationConfig } from "../../src/config/destinations.js";
import { DEFAULT_CONFIG, DEFAULT_EXPORTER_POLICY, type ExporterPolicy } from "../../src/config/schema.js";
import { createHookRuntime, type HookRuntime, type HookRuntimeOptions } from "../../src/integration/hook-runtime.js";
import { parseCanonicalEvent, type CanonicalEvent } from "../../src/model/events.js";
import { CANONICAL_SCHEMA_VERSION } from "../../src/model/version.js";
import { DEFAULT_PRIVACY_POLICY } from "../../src/privacy/policy.js";
import { createPrivacyService } from "../../src/privacy/service.js";
import { createClaudeCodeAdapter } from "../../src/providers/claude/adapter.js";
import { createProviderRegistry } from "../../src/providers/registry.js";
import { createFixedClock, createSystemClock } from "../../src/runtime/clock.js";
import { createFilesystemWorktreeLocator } from "../../src/runtime/git-worktree.js";
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
  overrides: Partial<HookRuntimeOptions> = {},
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
    ...overrides,
  });
  cleanups.push(async () => {
    await runtime.shutdown();
  });
  return { runtime, stateRootDir };
};

const SYNTHETIC_CWD = "/workspace/synthetic";

const prompt = (sessionId: string, cwd = SYNTHETIC_CWD): Record<string, unknown> => ({
  hook_event_name: "UserPromptSubmit",
  session_id: sessionId,
  transcript_path: "/tmp/synthetic/transcript.jsonl",
  cwd,
  prompt: `deploy with ${SECRET} now`,
});

const sessionStart = (sessionId: string, cwd = SYNTHETIC_CWD): Record<string, unknown> => ({
  hook_event_name: "SessionStart",
  session_id: sessionId,
  transcript_path: "/tmp/synthetic/transcript.jsonl",
  cwd,
  source: "startup",
  model: "synthetic-model",
});

const preToolUse = (sessionId: string, cwd = SYNTHETIC_CWD): Record<string, unknown> => ({
  hook_event_name: "PreToolUse",
  session_id: sessionId,
  transcript_path: "/tmp/synthetic/transcript.jsonl",
  cwd,
  tool_use_id: `toolu_${sessionId}`,
  tool_name: "Bash",
  tool_input: { command: "true" },
});

const postToolUse = (sessionId: string, cwd = SYNTHETIC_CWD): Record<string, unknown> => ({
  hook_event_name: "PostToolUse",
  session_id: sessionId,
  transcript_path: "/tmp/synthetic/transcript.jsonl",
  cwd,
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

/**
 * A checkout as git leaves it on disk: `.git/HEAD`, and a `config` naming the
 * `origin` remote when one is given. The directory name says nothing about the
 * repository, so a payload that mentions it would show up in the assertions.
 */
const checkout = async (originUrl?: string): Promise<string> => {
  const dir = path.join(await scratchDir(), "checkout");
  await mkdir(path.join(dir, ".git"), { recursive: true });
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  if (originUrl !== undefined) {
    await writeFile(
      path.join(dir, ".git", "config"),
      `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${originUrl}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
    );
  }
  return dir;
};

/** Session context that can appear mid-session, as a launch writes it. */
const mutableContextReader = (): {
  readonly reader: SessionContextReader;
  readonly set: (sessionId: string, repository: string) => void;
} => {
  const repositories = new Map<string, string>();
  return {
    reader: {
      read: (request) => {
        const repository = repositories.get(request.sessionId);
        return Promise.resolve(
          repository === undefined
            ? undefined
            : [{ from: 0, to: null, attributes: { "vcs.repository.url.full": repository } }],
        );
      },
    },
    set: (sessionId, repository) => {
      repositories.set(sessionId, repository);
    },
  };
};

const bodiesText = (target: CapturingCollector): string =>
  target.requests.map((request) => request.body.toString("latin1")).join("\n");

describe("hook runtime: routing by the session workspace's own remote", () => {
  const ORIGIN_A = "git@github.com:synthetic-org/repo-a.git";

  const threeDestinations = (
    local: CapturingCollector,
    hostedA: CapturingCollector,
    hostedB: CapturingCollector,
  ): ExportDestinationConfig[] => [
    { name: "local", endpoint: local.url, signals: ["traces", "logs", "metrics"] },
    { name: "hosted-a", endpoint: hostedA.url, signals: ["traces", "logs", "metrics"], scopes: [{ repositories: [REPO_A] }] },
    { name: "hosted-b", endpoint: hostedB.url, signals: ["traces", "logs", "metrics"], scopes: [{ repositories: [REPO_B] }] },
  ];

  it("sends a session with no context to the destination scoped to its checkout's origin, and no other", async () => {
    const local = await collector();
    const hostedA = await collector();
    const hostedB = await collector();
    const cwd = await checkout(ORIGIN_A);
    const { runtime } = await buildRuntime(
      { destinations: threeDestinations(local, hostedA, hostedB) },
      {},
      {},
      { worktreeLocator: createFilesystemWorktreeLocator() },
    );
    const sessionId = "ses-workspace-a";
    for (const payload of [sessionStart(sessionId, cwd), prompt(sessionId, cwd), postToolUse(sessionId, cwd)]) {
      const outcome = await send(runtime, payload);
      expect(outcome.ingest.durability).toBe("delivered");
      expect(outcome.ingest.workspaceRepositoryKey).toBe("github.com/synthetic-org/repo-a");
    }
    await runtime.shutdown();

    const spanNames = (target: CapturingCollector) =>
      decodeAllExportedSpans(target.bodiesFor("/v1/traces"))
        .map((span) => span.name)
        .sort();
    expect(spanNames(hostedA).length).toBeGreaterThan(0);
    expect(spanNames(hostedA)).toEqual(spanNames(local));
    expect(decodeAllExportedLogRecords(hostedA.bodiesFor("/v1/logs")).map((record) => record.body)).toContain(
      `deploy with ${SECRET} now`,
    );
    expect(decodeAllExportedMetrics(hostedA.bodiesFor("/v1/metrics")).length).toBeGreaterThan(0);
    expect(hostedB.requests).toHaveLength(0);
    // The scoped copies name the repository they were routed by, in canonical
    // form (never the raw `git@` remote); the unscoped destination's do not.
    const canonicalA = "https://github.com/synthetic-org/repo-a";
    expect(repositoriesIn(decodeAllExportedSpans(hostedA.bodiesFor("/v1/traces")))).toEqual([canonicalA]);
    expect(repositoriesIn(decodeAllExportedLogRecords(hostedA.bodiesFor("/v1/logs")))).toEqual([canonicalA]);
    expect(repositoriesIn(decodeAllExportedMetrics(hostedA.bodiesFor("/v1/metrics")))).toEqual([canonicalA]);
    expect(bodiesText(hostedA)).not.toContain("git@");
    expect(bodiesText(local)).not.toContain("repo-a");
    expect(bodiesText(local)).not.toContain("vcs.repository.url.full");
  });

  it("lets the session context win over the checkout's origin", async () => {
    const local = await collector();
    const hostedA = await collector();
    const hostedB = await collector();
    const cwd = await checkout(ORIGIN_A);
    const { runtime } = await buildRuntime(
      { destinations: threeDestinations(local, hostedA, hostedB) },
      { "ses-stamped-b": REPO_B },
      {},
      { worktreeLocator: createFilesystemWorktreeLocator() },
    );
    await send(runtime, prompt("ses-stamped-b", cwd));
    await runtime.shutdown();

    expect(hostedA.requests).toHaveLength(0);
    expect(repositoriesIn(decodeAllExportedSpans(hostedB.bodiesFor("/v1/traces")))).toEqual([REPO_B]);
  });

  it("drops a session whose checkout has no usable origin for scoped destinations, and keeps it for the rest", async () => {
    for (const origin of [undefined, "/srv/git/repo-a.git"]) {
      const local = await collector();
      const hostedA = await collector();
      const hostedB = await collector();
      const cwd = await checkout(origin);
      const { runtime } = await buildRuntime(
        { destinations: threeDestinations(local, hostedA, hostedB) },
        {},
        {},
        { worktreeLocator: createFilesystemWorktreeLocator() },
      );
      const outcome = await send(runtime, prompt("ses-no-origin", cwd));
      expect(outcome.ingest.workspaceRepositoryKey).toBeUndefined();
      await runtime.shutdown();

      expect(decodeAllExportedSpans(local.bodiesFor("/v1/traces")).length).toBeGreaterThan(0);
      expect(hostedA.requests).toHaveLength(0);
      expect(hostedB.requests).toHaveLength(0);
    }
  });

  it("leaves an unscoped destination's payload byte-identical", async () => {
    const cwd = await checkout(ORIGIN_A);
    const run = async (readsRemote: boolean): Promise<readonly string[]> => {
      const local = await collector();
      const hostedA = await collector();
      const fsLocator = createFilesystemWorktreeLocator();
      const { runtime } = await buildRuntime(
        {
          destinations: [
            { name: "local", endpoint: local.url, signals: ["traces", "logs", "metrics"] },
            { name: "hosted-a", endpoint: hostedA.url, scopes: [{ repositories: [REPO_A] }] },
          ],
        },
        {},
        {},
        {
          clock: createFixedClock({ startMillis: 1_700_000_100_000 }),
          // Without `originRepositoryKey` the locator still resolves targets, but
          // nothing is routed by remote: the payload as it was before this existed.
          worktreeLocator: readsRemote ? fsLocator : { locate: (target) => fsLocator.locate(target) },
        },
      );
      const sessionId = "ses-identical";
      for (const payload of [sessionStart(sessionId, cwd), prompt(sessionId, cwd), postToolUse(sessionId, cwd)]) {
        await send(runtime, payload);
      }
      await runtime.shutdown();
      expect(hostedA.requests.length > 0).toBe(readsRemote);
      return local.requests.map((request) => `${request.path} ${request.body.toString("base64")}`).sort();
    };
    const before = await run(false);
    expect(before.length).toBeGreaterThan(0);
    expect(await run(true)).toEqual(before);
  });

  it("gets the prompt to the scoped destination when the session context only appears later (launch mid-session)", async () => {
    const local = await collector();
    const hostedA = await collector();
    const hostedB = await collector();
    const cwd = await checkout(ORIGIN_A);
    const context = mutableContextReader();
    const { runtime } = await buildRuntime(
      { destinations: threeDestinations(local, hostedA, hostedB) },
      {},
      {},
      { worktreeLocator: createFilesystemWorktreeLocator(), sessionContextReader: context.reader },
    );
    const sessionId = "ses-launch-later";
    // Before the launch: no session context, as in the end-to-end capture.
    await send(runtime, sessionStart(sessionId, cwd));
    await send(runtime, prompt(sessionId, cwd));
    await send(runtime, preToolUse(sessionId, cwd));
    // The agent ran the launch: from here on every event is stamped.
    context.set(sessionId, REPO_A);
    await send(runtime, postToolUse(sessionId, cwd));
    await runtime.shutdown();

    const hostedLogs = decodeAllExportedLogRecords(hostedA.bodiesFor("/v1/logs"));
    expect(hostedLogs.map((record) => record.body)).toContain(`deploy with ${SECRET} now`);
    const hostedSpans = decodeAllExportedSpans(hostedA.bodiesFor("/v1/traces"));
    const localSpans = decodeAllExportedSpans(local.bodiesFor("/v1/traces"));
    expect(hostedSpans.map((span) => span.spanId).sort()).toEqual(localSpans.map((span) => span.spanId).sort());
    // The scoped copies of the records from before the launch name the repository
    // they were routed by; the unscoped destination's name none.
    expect(repositoriesIn(localSpans)).toEqual([REPO_A, "undefined"]);
    expect(repositoriesIn(hostedSpans)).toEqual([REPO_A]);
    const hostedPrompt = hostedLogs.find((record) => record.body === `deploy with ${SECRET} now`);
    expect(hostedPrompt?.attributes["vcs.repository.url.full"]).toBe(REPO_A);
    expect(hostedB.requests).toHaveLength(0);
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
