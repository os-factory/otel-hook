/**
 * Replay-stable delivery deduplication, exercised through the real integration
 * runtime over a real filesystem state store.
 *
 * Every test here builds a *fresh* runtime per delivery wherever a restart is the
 * thing under test: a hook process lives for milliseconds and then exits, so
 * "does this survive a restart" is not a detail — it is the whole guarantee, and
 * an in-process runtime reused across deliveries would prove nothing about it.
 */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, DEFAULT_EXPORTER_POLICY } from "../../src/config/schema.js";
import {
  createHookRuntime,
  minimumStaleClaimMillis,
  type HookRuntime,
} from "../../src/integration/hook-runtime.js";
import { createCallbackDeduplicator } from "../../src/lifecycle/dedup.js";
import { createClaudeCodeAdapter } from "../../src/providers/claude/adapter.js";
import { createFixedClock, type FixedClock } from "../../src/runtime/clock.js";
import { createRecordingLogger } from "../../src/runtime/memory.js";
import { createProviderRegistry } from "../../src/providers/registry.js";
import { createFilesystemStateStore } from "../../src/state/filesystem-store.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const scratchDir = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), "otel-hook-delivery-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

const startCollector = async (): Promise<{ readonly url: string; readonly count: () => number }> => {
  let count = 0;
  const server: Server = createServer((req, res) => {
    req.on("data", () => undefined);
    req.on("end", () => {
      count += 1;
      res.writeHead(200);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("failed to bind collector");
  }
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${String(address.port)}/v1/traces`, count: (): number => count };
};

/**
 * A `PostToolUse` payload: the Claude Code callback that *does* carry a
 * replay-stable id (`tool_use_id`), plus usage, so one payload exercises
 * deduplication and usage accounting together.
 */
const toolPayload = (
  sessionId: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  hook_event_name: "PostToolUse",
  session_id: sessionId,
  cwd: "/workspace/demo",
  tool_name: "Read",
  tool_use_id: "tool-1",
  tool_response: { content: "synthetic file contents" },
  ...overrides,
});

/** A `Stop` payload: no replay-stable id in this protocol, but it does carry usage. */
const stopPayload = (
  sessionId: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  hook_event_name: "Stop",
  session_id: sessionId,
  cwd: "/workspace/demo",
  prompt_id: "prompt-1",
  usage: { input_tokens: 100, cache_read_input_tokens: 40, output_tokens: 20 },
  ...overrides,
});

type BuildOptions = {
  readonly stateRootDir: string;
  readonly endpoint?: string;
  readonly installationId?: string;
  readonly clock?: FixedClock;
  readonly requireCallbackId?: boolean;
  readonly deriveDeliveryIdentity?: boolean;
  readonly staleClaimMillis?: number;
  readonly deliveryRetentionMillis?: number;
  readonly sweepOnSessionEnd?: boolean;
};

/** One runtime, standing in for one hook process. */
const buildRuntime = (
  options: BuildOptions,
): { readonly runtime: HookRuntime; readonly logger: ReturnType<typeof createRecordingLogger> } => {
  const logger = createRecordingLogger("debug");
  const runtime = createHookRuntime({
    config: {
      ...DEFAULT_CONFIG,
      exporter:
        options.endpoint === undefined
          ? { ...DEFAULT_EXPORTER_POLICY, enabled: false }
          : {
              ...DEFAULT_EXPORTER_POLICY,
              endpoint: options.endpoint,
              timeoutMillis: 2_000,
              maxRetryAttempts: 0,
            },
      detection: { ...DEFAULT_CONFIG.detection, minimumConfidence: "weak" },
    },
    registry: createProviderRegistry([createClaudeCodeAdapter()]),
    stateRootDir: options.stateRootDir,
    installationId: options.installationId ?? "test-install",
    providerNamespace: "claude-code",
    logger,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.requireCallbackId === undefined
      ? {}
      : { requireCallbackId: options.requireCallbackId }),
    ...(options.deriveDeliveryIdentity === undefined
      ? {}
      : { deriveDeliveryIdentity: options.deriveDeliveryIdentity }),
    ...(options.staleClaimMillis === undefined ? {} : { staleClaimMillis: options.staleClaimMillis }),
    ...(options.deliveryRetentionMillis === undefined
      ? {}
      : { deliveryRetentionMillis: options.deliveryRetentionMillis }),
    ...(options.sweepOnSessionEnd === undefined
      ? {}
      : { sweepOnSessionEnd: options.sweepOnSessionEnd }),
  });
  cleanups.push(async () => {
    await runtime.shutdown();
  });
  return { runtime, logger };
};

/** Process one payload in a runtime of its own, then shut it down. */
const deliverOnce = async (
  options: BuildOptions,
  payload: unknown,
): Promise<Awaited<ReturnType<HookRuntime["process"]>>> => {
  const { runtime } = buildRuntime(options);
  const outcome = await runtime.process({
    payload,
    transport: "hook-stdin",
    providerHint: "claude-code",
  });
  await runtime.shutdown();
  return outcome;
};

describe("delivery deduplication: provider-derived identity across process restarts", () => {
  it("exports a redelivered tool callback exactly once, in a second process", async () => {
    const collector = await startCollector();
    const stateRootDir = await scratchDir();
    const options = { stateRootDir, endpoint: collector.url };
    const payload = toolPayload("ses-restart");

    const first = await deliverOnce(options, payload);
    const second = await deliverOnce(options, payload);
    const third = await deliverOnce(options, payload);

    expect(first.delivery).toMatchObject({
      deduplicated: true,
      origin: "provider",
      outcome: "fresh",
    });
    expect(first.delivery.evidence?.[0]).toContain("tool_use_id");
    expect(first.duplicateDelivery).toBe(false);
    expect(first.ingest.emitted).toBeGreaterThan(0);

    for (const redelivery of [second, third]) {
      expect(redelivery.delivery).toMatchObject({ deduplicated: true, outcome: "duplicate" });
      expect(redelivery.duplicateDelivery).toBe(true);
      expect(redelivery.ingest.emitted).toBe(0);
      // Still parsed, so the provider's protocol response is real rather than a
      // guess about a redelivery.
      expect(redelivery.ingest.events.length).toBeGreaterThan(0);
      expect(redelivery.ingest.hookResponse.exitCode).toBe(0);
    }

    expect(collector.count()).toBe(1);
  }, 60_000);

  it("treats a different tool call in the same session as a distinct delivery", async () => {
    const stateRootDir = await scratchDir();
    const options = { stateRootDir };

    const first = await deliverOnce(options, toolPayload("ses-distinct"));
    const other = await deliverOnce(options, toolPayload("ses-distinct", { tool_use_id: "tool-2" }));

    expect(first.duplicateDelivery).toBe(false);
    expect(other.duplicateDelivery).toBe(false);
  }, 60_000);

  it("keeps the before-edge and after-edge of one tool call distinct", async () => {
    const stateRootDir = await scratchDir();
    const options = { stateRootDir };

    const pre = await deliverOnce(options, {
      hook_event_name: "PreToolUse",
      session_id: "ses-edges",
      cwd: "/workspace/demo",
      tool_name: "Read",
      tool_use_id: "tool-1",
      tool_input: { file_path: "/workspace/demo/README.md" },
    });
    const post = await deliverOnce(options, toolPayload("ses-edges"));

    expect(pre.duplicateDelivery).toBe(false);
    expect(post.duplicateDelivery).toBe(false);
    expect(post.delivery.outcome).toBe("fresh");
  }, 60_000);
});

describe("delivery deduplication: isolation", () => {
  it("does not let one session's tool-call id suppress another session's", async () => {
    const stateRootDir = await scratchDir();
    const options = { stateRootDir };

    // Byte-identical payloads apart from the session: `tool_use_id` is only
    // unique within a session, so the scope digest has to carry the session too.
    const alpha = await deliverOnce(options, toolPayload("ses-alpha"));
    const beta = await deliverOnce(options, toolPayload("ses-beta"));
    const alphaAgain = await deliverOnce(options, toolPayload("ses-alpha"));

    expect(alpha.duplicateDelivery).toBe(false);
    expect(beta.duplicateDelivery).toBe(false);
    expect(alphaAgain.duplicateDelivery).toBe(true);
  }, 60_000);

  it("does not let one installation's state suppress another's", async () => {
    const stateRootDir = await scratchDir();
    const payload = toolPayload("ses-shared");

    const first = await deliverOnce({ stateRootDir, installationId: "install-a" }, payload);
    const other = await deliverOnce({ stateRootDir, installationId: "install-b" }, payload);

    expect(first.duplicateDelivery).toBe(false);
    expect(other.duplicateDelivery).toBe(false);
  }, 60_000);
});

describe("delivery deduplication: concurrency and ordering", () => {
  it("lets exactly one of many concurrent redeliveries export", async () => {
    const collector = await startCollector();
    const stateRootDir = await scratchDir();
    const payload = toolPayload("ses-concurrent");

    // Eight runtimes, eight concurrent deliveries of the same callback, one shared
    // state directory: the shape of a host that fired its hook eight times at once.
    const runtimes = Array.from({ length: 8 }, () =>
      buildRuntime({ stateRootDir, endpoint: collector.url }),
    );
    const outcomes = await Promise.all(
      runtimes.map(({ runtime }) =>
        runtime.process({ payload, transport: "hook-stdin", providerHint: "claude-code" }),
      ),
    );
    await Promise.all(runtimes.map(({ runtime }) => runtime.shutdown()));

    expect(outcomes.filter((outcome) => !outcome.duplicateDelivery)).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.duplicateDelivery)).toHaveLength(7);
    expect(outcomes.reduce((total, outcome) => total + outcome.ingest.emitted, 0)).toBeGreaterThan(0);
    expect(collector.count()).toBe(1);
  }, 90_000);

  it("serializes same-scope deliveries in arrival order inside one runtime", async () => {
    const stateRootDir = await scratchDir();
    const { runtime } = buildRuntime({ stateRootDir });

    // Three distinct tool calls in one session, started concurrently. All three are
    // fresh, and their canonical sequence numbers are consecutive rather than
    // colliding — deduplication must not reorder or interleave what it lets pass.
    const outcomes = await Promise.all(
      ["tool-a", "tool-b", "tool-c"].map((toolUseId) =>
        runtime.process({
          payload: toolPayload("ses-ordered", { tool_use_id: toolUseId }),
          transport: "hook-stdin",
          providerHint: "claude-code",
        }),
      ),
    );

    expect(outcomes.every((outcome) => !outcome.duplicateDelivery)).toBe(true);
    const sequences = outcomes
      .flatMap((outcome) => outcome.ingest.events.map((event) => event.sequence))
      .sort((left, right) => left - right);
    expect(sequences).toEqual(sequences.map((_, index) => index));
  }, 60_000);
});

describe("delivery deduplication: usage accounting is applied at most once", () => {
  it("does not accumulate a redelivered callback's usage into the rollup", async () => {
    const stateRootDir = await scratchDir();
    const options = { stateRootDir };
    // SubagentStop carries both a replay-stable `agent_id` and usage, so one
    // payload proves accounting and deduplication agree.
    const payload = {
      hook_event_name: "SubagentStop",
      session_id: "ses-usage",
      cwd: "/workspace/demo",
      agent_type: "Explore",
      agent_id: "agent-1",
      usage: { input_tokens: 100, cache_read_input_tokens: 40, output_tokens: 20 },
    };

    const first = await deliverOnce(options, payload);
    expect(first.usageRollups).toHaveLength(1);
    const accounted = first.usageRollups[0]?.snapshot.total.inputTokens;
    expect(accounted).toBeGreaterThan(0);

    const second = await deliverOnce(options, payload);
    expect(second.duplicateDelivery).toBe(true);
    expect(second.usageRollups).toHaveLength(0);

    // Read the rollup back through a third process: the running total is exactly
    // what the first delivery contributed, not double it.
    const { runtime } = buildRuntime(options);
    const rollup = await runtime.usageAccumulator.read({
      sessionId: "ses-usage",
      scope: "subagent",
      scopeKey: first.usageRollups[0]?.scopeKey ?? "",
    });
    expect(rollup?.total.inputTokens).toBe(accounted);
  }, 60_000);

  it("still accounts a callback whose identity could not be established", async () => {
    const stateRootDir = await scratchDir();
    const options = { stateRootDir };

    // `Stop` has no replay-stable id in this protocol. Losing its usage would be a
    // certain harm to avoid a possible one, so it is exported and accounted.
    const first = await deliverOnce(options, stopPayload("ses-unidentified"));
    const second = await deliverOnce(options, stopPayload("ses-unidentified"));

    expect(first.delivery).toEqual({
      deduplicated: false,
      reason: "callback-not-identifiable",
      capability: "partial",
    });
    expect(second.delivery.deduplicated).toBe(false);
    expect(first.usageRollups).toHaveLength(1);
    expect(second.usageRollups).toHaveLength(1);
  }, 60_000);
});

describe("delivery deduplication: capability diagnostics", () => {
  it("stays silent about an unidentifiable callback unless a callback id is required", async () => {
    const stateRootDir = await scratchDir();

    const quiet = await deliverOnce({ stateRootDir }, stopPayload("ses-quiet"));
    expect(
      [...quiet.diagnostics, ...quiet.ingest.diagnostics].map((info) => info.code),
    ).not.toContain("delivery-identifier-unavailable");
  }, 60_000);

  it("names the provider, the capability, and the remedy when one is required", async () => {
    const stateRootDir = await scratchDir();

    const outcome = await deliverOnce(
      { stateRootDir, requireCallbackId: true },
      stopPayload("ses-required"),
    );

    const info = outcome.diagnostics.find(
      (candidate) => candidate.code === "delivery-identifier-unavailable",
    );
    expect(info).toBeDefined();
    expect(info?.severity).toBe("warning");
    expect(info?.posture).toBe("fail-open");
    expect(info?.details?.["provider.id"]).toBe("claude-code");
    expect(info?.details?.["provider.delivery_identifier"]).toBe("partial");
    expect(info?.details?.["delivery.reason"]).toBe("callback-not-identifiable");
    expect(info?.details?.["delivery.remedy"]).toContain("--callback-id");
    // Fail-open: the diagnostic reports a missing guarantee, it does not withhold
    // the telemetry.
    expect(outcome.ingest.attribution).toBe("attributed");
    expect(outcome.ingest.events.length).toBeGreaterThan(0);
  }, 60_000);

  it("says nothing is available when no provider could be attributed at all", async () => {
    const stateRootDir = await scratchDir();

    const outcome = await deliverOnce({ stateRootDir, requireCallbackId: true }, {
      not_a: "recognizable payload",
    });

    const info = outcome.diagnostics.find(
      (candidate) => candidate.code === "delivery-identifier-unavailable",
    );
    expect(info?.details?.["delivery.reason"]).toBe("provider-unattributed");
    expect(info?.details?.["provider.id"]).toBeUndefined();
  }, 60_000);

  it("does not consult the adapter at all when derivation is switched off", async () => {
    const stateRootDir = await scratchDir();
    const options = { stateRootDir, deriveDeliveryIdentity: false, requireCallbackId: true };
    const payload = toolPayload("ses-no-derive");

    const first = await deliverOnce(options, payload);
    const second = await deliverOnce(options, payload);

    // The callback *is* identifiable; the host asked not to use that.
    expect(first.delivery).toEqual({ deduplicated: false });
    expect(second.duplicateDelivery).toBe(false);
    // And with nothing attempted, `--require-callback-id` has nothing to report:
    // the absence is the host's own explicit choice, not a provider gap.
    expect(second.diagnostics.map((info) => info.code)).not.toContain(
      "delivery-identifier-unavailable",
    );
  }, 60_000);
});

describe("delivery deduplication: explicit host callback ids stay compatible", () => {
  it("prefers a host id over the one the adapter could have derived", async () => {
    const stateRootDir = await scratchDir();
    const { runtime } = buildRuntime({ stateRootDir });

    // Same host id, two payloads the adapter would have identified *differently*.
    // The host's assertion wins, so the second is a duplicate.
    const first = await runtime.process({
      payload: toolPayload("ses-host", { tool_use_id: "tool-a" }),
      transport: "hook-stdin",
      providerHint: "claude-code",
      delivery: { callbackId: "host-1" },
    });
    const second = await runtime.process({
      payload: toolPayload("ses-host", { tool_use_id: "tool-b" }),
      transport: "hook-stdin",
      providerHint: "claude-code",
      delivery: { callbackId: "host-1" },
    });

    expect(first.delivery).toMatchObject({ deduplicated: true, origin: "host", outcome: "fresh" });
    expect(second.delivery).toMatchObject({ origin: "host", outcome: "duplicate" });
    expect(second.duplicateDelivery).toBe(true);
  }, 60_000);

  it("recognizes one host id across two sessions, because the host said it is unique", async () => {
    const stateRootDir = await scratchDir();
    const { runtime } = buildRuntime({ stateRootDir });

    const first = await runtime.process({
      payload: stopPayload("ses-one"),
      transport: "hook-stdin",
      providerHint: "claude-code",
      delivery: { callbackId: "host-42" },
    });
    const second = await runtime.process({
      payload: stopPayload("ses-two"),
      transport: "hook-stdin",
      providerHint: "claude-code",
      delivery: { callbackId: "host-42" },
    });

    expect(first.duplicateDelivery).toBe(false);
    expect(second.duplicateDelivery).toBe(true);
  }, 60_000);

  it("keeps two host-chosen scopes independent", async () => {
    const stateRootDir = await scratchDir();
    const { runtime } = buildRuntime({ stateRootDir });

    const base = {
      payload: stopPayload("ses-scoped"),
      transport: "hook-stdin" as const,
      providerHint: "claude-code",
    };
    const first = await runtime.process({ ...base, delivery: { callbackId: "id-1", scope: "a" } });
    const second = await runtime.process({ ...base, delivery: { callbackId: "id-1", scope: "b" } });
    const third = await runtime.process({ ...base, delivery: { callbackId: "id-1", scope: "a" } });

    expect(first.duplicateDelivery).toBe(false);
    expect(second.duplicateDelivery).toBe(false);
    expect(third.duplicateDelivery).toBe(true);
  }, 60_000);
});

describe("delivery deduplication: stale state left by a crashed process", () => {
  it("recovers a callback whose claim no process ever committed", async () => {
    const stateRootDir = await scratchDir();
    const clock = createFixedClock();
    const payload = toolPayload("ses-crashed");

    // Stand in for a process that claimed the callback and then died before it
    // could export: the claim is on disk, the telemetry never left.
    const stateStore = createFilesystemStateStore({
      rootDir: stateRootDir,
      providerId: "claude-code",
      installationId: "test-install",
      clock,
    });
    const { runtime: probe } = buildRuntime({ stateRootDir, clock });
    const resolved = probe.hook.resolveDelivery({
      payload,
      transport: "hook-stdin",
      providerHint: "claude-code",
    });
    if (resolved.status !== "resolved") {
      throw new Error(`expected a resolvable delivery identity, got ${resolved.status}`);
    }
    await createCallbackDeduplicator({ stateStore, clock }).claim(
      resolved.identity.scope,
      resolved.identity.callbackId,
    );
    await probe.shutdown();

    // The requested window is raised to cover this installation's own export
    // budget, so the test asks the runtime what the effective window is rather
    // than assuming its request was honoured — a shorter window than one
    // process's work would let a peer reclaim a live claim and double-export.
    const effectiveStaleClaim = minimumStaleClaimMillis({
      exportTimeoutMillis: DEFAULT_EXPORTER_POLICY.timeoutMillis,
      maxRetryAttempts: DEFAULT_EXPORTER_POLICY.maxRetryAttempts,
      flushTimeoutMillis: 2_000,
      stateLockTimeoutMillis: 1_000,
    });

    // Inside the stale window the abandoned claim is still respected: a peer that
    // might still be exporting must not be double-counted.
    const inFlight = await deliverOnce({ stateRootDir, clock, staleClaimMillis: 30_000 }, payload);
    expect(inFlight.delivery.outcome).toBe("in-flight");
    expect(inFlight.duplicateDelivery).toBe(true);

    // Past it, the claim is assumed dead and the telemetry is recovered rather
    // than lost forever to a crash.
    clock.advance(effectiveStaleClaim + 1_000);
    const recovered = await deliverOnce({ stateRootDir, clock, staleClaimMillis: 30_000 }, payload);
    expect(recovered.delivery.outcome).toBe("reclaimed");
    expect(recovered.duplicateDelivery).toBe(false);
    expect(recovered.ingest.events.length).toBeGreaterThan(0);

    // And once it *is* committed, it is a duplicate again.
    const afterRecovery = await deliverOnce(
      { stateRootDir, clock, staleClaimMillis: 30_000 },
      payload,
    );
    expect(afterRecovery.delivery.outcome).toBe("duplicate");
  }, 90_000);

  it("exports rather than drops when the dedup record cannot be read at all", async () => {
    const stateRootDir = await scratchDir();
    const payload = toolPayload("ses-unreadable");

    const first = await deliverOnce({ stateRootDir }, payload);
    expect(first.duplicateDelivery).toBe(false);

    // Make the store unusable by replacing its records directory with a file.
    const { runtime } = buildRuntime({ stateRootDir });
    await rm(runtime.stateStore.recordsDir, { recursive: true, force: true });
    await rm(path.dirname(runtime.stateStore.recordsDir), { recursive: true, force: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.dirname(runtime.stateStore.recordsDir), "not a directory", "utf8");

    const degraded = await runtime.process({
      payload,
      transport: "hook-stdin",
      providerHint: "claude-code",
    });
    await runtime.shutdown();

    // Losing a real observation is unrecoverable; exporting a possible duplicate
    // is not. So the guarantee lapses, visibly, and the telemetry still flows.
    expect(degraded.duplicateDelivery).toBe(false);
    expect(degraded.delivery).toMatchObject({
      deduplicated: false,
      origin: "provider",
      reason: "state-unavailable",
    });
    expect(degraded.diagnostics.map((info) => info.code)).toContain("state-store-failure");
  }, 60_000);
});

describe("delivery deduplication: retention", () => {
  it("sweeps dedup records at the end of a session, whatever scope they sit in", async () => {
    const stateRootDir = await scratchDir();
    const clock = createFixedClock();
    const options = { stateRootDir, clock, deliveryRetentionMillis: 5_000 };

    await deliverOnce(options, toolPayload("ses-retention"));
    const { runtime: probe } = buildRuntime(options);
    const before = await probe.stateStore.keys("lifecycle:dedup:");
    await probe.shutdown();
    expect(before).toHaveLength(1);

    // Age the record past its retention, then end the session: a delivery scope is
    // a digest, not a session id, so a session-scoped sweep would miss it entirely.
    clock.advance(10_000);
    const ended = await deliverOnce(options, {
      hook_event_name: "SessionEnd",
      session_id: "ses-retention",
      cwd: "/workspace/demo",
      reason: "completed",
    });
    expect(ended.cleanup?.dedup?.removed).toBe(1);

    const { runtime: after } = buildRuntime(options);
    expect(await after.stateStore.keys("lifecycle:dedup:")).toHaveLength(0);
    await after.shutdown();
  }, 60_000);

  it("keeps a record that has not aged out, so a redelivery is still caught", async () => {
    const stateRootDir = await scratchDir();
    const clock = createFixedClock();
    const options = { stateRootDir, clock, deliveryRetentionMillis: 60 * 60 * 1000 };
    const payload = toolPayload("ses-kept");

    await deliverOnce(options, payload);
    clock.advance(10_000);
    await deliverOnce(options, {
      hook_event_name: "SessionEnd",
      session_id: "ses-kept",
      cwd: "/workspace/demo",
      reason: "completed",
    });

    expect((await deliverOnce(options, payload)).duplicateDelivery).toBe(true);
  }, 60_000);

  it("leaves no stray files behind beyond the records it keeps", async () => {
    const stateRootDir = await scratchDir();
    const options = { stateRootDir };

    for (const toolUseId of ["t1", "t2", "t3"]) {
      await deliverOnce(options, toolPayload("ses-files", { tool_use_id: toolUseId }));
    }

    const { runtime } = buildRuntime(options);
    const entries = await readdir(runtime.stateStore.recordsDir);
    await runtime.shutdown();
    // No orphaned temp files: every write landed via rename.
    expect(entries.filter((entry) => entry.startsWith(".tmp-"))).toEqual([]);
    expect(await runtime.stateStore.keys("lifecycle:dedup:")).toHaveLength(3);
  }, 60_000);
});

describe("delivery deduplication: malformed input", () => {
  const malformed: readonly [string, unknown][] = [
    ["null", null],
    ["a bare string", "not a payload"],
    ["an array", []],
    ["an empty object", {}],
    ["a known event missing its session", { hook_event_name: "PostToolUse", tool_use_id: "t" }],
    ["a known event with a numeric session", { hook_event_name: "PostToolUse", session_id: 3 }],
    [
      "a tool callback with no tool_use_id",
      { hook_event_name: "PostToolUse", session_id: "ses-x", tool_name: "Read" },
    ],
  ];

  for (const [label, payload] of malformed) {
    it(`processes ${label} without claiming an identity or throwing`, async () => {
      const stateRootDir = await scratchDir();
      const outcome = await deliverOnce({ stateRootDir, requireCallbackId: true }, payload);

      expect(outcome.ingest.ok).toBe(true);
      expect(outcome.duplicateDelivery).toBe(false);
      expect(outcome.delivery.deduplicated).toBe(false);
      expect(outcome.delivery.reason).toBeDefined();

      // Nothing unidentifiable may ever land in the dedup key space.
      const { runtime } = buildRuntime({ stateRootDir });
      expect(await runtime.stateStore.keys("lifecycle:dedup:")).toHaveLength(0);
      await runtime.shutdown();
    }, 60_000);
  }

  it("does not deduplicate against an identity an adapter reported malformed", async () => {
    const stateRootDir = await scratchDir();
    // A payload whose `tool_use_id` is well-formed for the adapter but not for the
    // component guard: a path is content, and content may not become an id.
    const payload = toolPayload("ses-guarded", { tool_use_id: "/home/someone/secret.txt" });

    const outcome = await deliverOnce({ stateRootDir, requireCallbackId: true }, payload);

    expect(outcome.delivery).toMatchObject({ deduplicated: false, reason: "claim-rejected" });
    const info = outcome.diagnostics.find(
      (candidate) => candidate.code === "delivery-identifier-unavailable",
    );
    expect(info).toBeDefined();
    expect(JSON.stringify(info)).not.toContain("secret.txt");
  }, 60_000);
});
