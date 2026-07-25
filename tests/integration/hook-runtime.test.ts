import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, DEFAULT_EXPORTER_POLICY } from "../../src/config/schema.js";
import { createHookRuntime, type HookRuntime } from "../../src/integration/hook-runtime.js";
import { createDefaultProviderRegistry } from "../../src/providers/defaults.js";
import { createProviderRegistry } from "../../src/providers/registry.js";
import { createClaudeCodeAdapter } from "../../src/providers/claude/adapter.js";
import { createCodexAdapter } from "../../src/providers/codex/adapter.js";
import { createRecordingLogger } from "../../src/runtime/memory.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const scratchDir = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), "otel-hook-runtime-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

const startCollector = async (
  respond: () => { readonly status: number } = () => ({ status: 200 }),
): Promise<{ readonly url: string; readonly count: () => number }> => {
  let count = 0;
  const server: Server = createServer((req, res) => {
    req.on("data", () => undefined);
    req.on("end", () => {
      count += 1;
      const { status } = respond();
      res.writeHead(status);
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

const claudePayload = (
  sessionId: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  hook_event_name: "Stop",
  session_id: sessionId,
  transcript_path: "/workspace/demo/.claude/transcript.jsonl",
  cwd: "/workspace/demo",
  prompt_id: "prompt-1",
  usage: {
    input_tokens: 100,
    cache_read_input_tokens: 40,
    output_tokens: 20,
  },
  ...overrides,
});

const buildRuntime = async (
  options: {
    readonly endpoint?: string;
    readonly stateRootDir?: string;
    readonly flushTimeoutMillis?: number;
    readonly enableSpool?: boolean;
  } = {},
): Promise<{ readonly runtime: HookRuntime; readonly logger: ReturnType<typeof createRecordingLogger> }> => {
  const stateRootDir = options.stateRootDir ?? (await scratchDir());
  const logger = createRecordingLogger("debug");
  const runtime = createHookRuntime({
    config: {
      ...DEFAULT_CONFIG,
      exporter:
        options.endpoint === undefined
          ? { ...DEFAULT_EXPORTER_POLICY, enabled: false }
          : { ...DEFAULT_EXPORTER_POLICY, endpoint: options.endpoint, timeoutMillis: 2_000, maxRetryAttempts: 0 },
      detection: { ...DEFAULT_CONFIG.detection, minimumConfidence: "weak" },
    },
    registry: createProviderRegistry([createClaudeCodeAdapter()]),
    stateRootDir,
    installationId: "test-install",
    providerNamespace: "claude-code",
    logger,
    ...(options.flushTimeoutMillis === undefined
      ? {}
      : { flushTimeoutMillis: options.flushTimeoutMillis }),
    ...(options.enableSpool === undefined ? {} : { enableSpool: options.enableSpool }),
  });
  cleanups.push(async () => {
    await runtime.shutdown();
  });
  return { runtime, logger };
};

describe("hook runtime: filesystem state across short-lived processes", () => {
  it("derives a delta from a cumulative baseline persisted by an earlier runtime", async () => {
    const stateRootDir = await scratchDir();
    const sessionId = "ses-cumulative";

    const first = await buildRuntime({ stateRootDir });
    const firstOutcome = await first.runtime.process({
      payload: claudePayload(sessionId),
      transport: "hook-stdin",
      providerHint: "claude-code",
    });
    expect(firstOutcome.ingest.attribution).toBe("attributed");
    await first.runtime.shutdown();

    // A second, independent runtime — the shape of a second hook process.
    const second = await buildRuntime({ stateRootDir });
    const secondOutcome = await second.runtime.process({
      payload: claudePayload(sessionId, {
        prompt_id: "prompt-2",
        usage: { input_tokens: 100, cache_read_input_tokens: 40, output_tokens: 20 },
      }),
      transport: "hook-stdin",
      providerHint: "claude-code",
    });

    expect(secondOutcome.ingest.attribution).toBe("attributed");
    // Sequence numbers continue rather than restarting: the baseline survived the
    // process boundary.
    expect(secondOutcome.ingest.events[0]?.sequence).toBeGreaterThan(0);
  });

  it("accumulates a running usage rollup per scope", async () => {
    const stateRootDir = await scratchDir();
    const { runtime } = await buildRuntime({ stateRootDir });

    const outcome = await runtime.process({
      payload: claudePayload("ses-rollup"),
      transport: "hook-stdin",
      providerHint: "claude-code",
    });

    expect(outcome.ingest.usageObservations.length).toBe(1);
    expect(outcome.usageRollups.length).toBe(1);
    const observed = outcome.ingest.usageObservations[0]?.delta.inputTokens;
    expect(observed).toBeGreaterThan(0);

    const [rollup] = outcome.usageRollups;
    expect(rollup?.snapshot.total.temporality).toBe("cumulative");
    // The rollup is exactly the sum of the deltas the orchestrator derived — it
    // never re-interprets the provider's numbers, so whatever the adapter's
    // cache-accounting rule produces is carried through unchanged.
    expect(rollup?.snapshot.total.inputTokens).toBe(observed);
    expect(rollup?.snapshot.epoch).toBe(0);

    // A second observation in the *same* generation scope doubles that scope's
    // running total, while the orchestrator's own per-event delta is unchanged.
    const again = await runtime.process({
      payload: claudePayload("ses-rollup"),
      transport: "hook-stdin",
      providerHint: "claude-code",
    });
    expect(again.usageRollups[0]?.scopeKey).toBe(rollup?.scopeKey);
    expect(again.usageRollups[0]?.snapshot.total.inputTokens).toBe((observed ?? 0) * 2);
    expect(again.ingest.usageObservations[0]?.delta.inputTokens).toBe(observed);

    // A different generation is a different scope, not a continuation of the
    // first one's total.
    const otherScope = await runtime.process({
      payload: claudePayload("ses-rollup", { prompt_id: "prompt-2" }),
      transport: "hook-stdin",
      providerHint: "claude-code",
    });
    expect(otherScope.usageRollups[0]?.scopeKey).not.toBe(rollup?.scopeKey);
    expect(otherScope.usageRollups[0]?.snapshot.total.inputTokens).toBe(observed);
  });
});

describe("hook runtime: delivery deduplication", () => {
  it("suppresses export for a repeated callback id but still parses and answers", async () => {
    const collector = await startCollector();
    const stateRootDir = await scratchDir();

    const first = await buildRuntime({ stateRootDir, endpoint: collector.url });
    const firstOutcome = await first.runtime.process({
      payload: claudePayload("ses-dedup"),
      transport: "hook-stdin",
      providerHint: "claude-code",
      delivery: { callbackId: "host-callback-1" },
    });
    await first.runtime.shutdown();

    expect(firstOutcome.duplicateDelivery).toBe(false);
    expect(firstOutcome.ingest.emitted).toBeGreaterThan(0);

    const second = await buildRuntime({ stateRootDir, endpoint: collector.url });
    const secondOutcome = await second.runtime.process({
      payload: claudePayload("ses-dedup"),
      transport: "hook-stdin",
      providerHint: "claude-code",
      delivery: { callbackId: "host-callback-1" },
    });
    await second.runtime.shutdown();

    expect(secondOutcome.duplicateDelivery).toBe(true);
    expect(secondOutcome.ingest.emitted).toBe(0);
    // The events were still produced, so the provider's hook response is derived
    // from a real parse rather than from a guess about a redelivery.
    expect(secondOutcome.ingest.events.length).toBeGreaterThan(0);
    expect(secondOutcome.ingest.hookResponse.exitCode).toBe(0);
    expect(collector.count()).toBe(1);
  });

  it("treats distinct callback ids as distinct deliveries", async () => {
    const stateRootDir = await scratchDir();
    const { runtime } = await buildRuntime({ stateRootDir });

    const first = await runtime.process({
      payload: claudePayload("ses-distinct"),
      transport: "hook-stdin",
      providerHint: "claude-code",
      delivery: { callbackId: "callback-a" },
    });
    const second = await runtime.process({
      payload: claudePayload("ses-distinct", { prompt_id: "prompt-2" }),
      transport: "hook-stdin",
      providerHint: "claude-code",
      delivery: { callbackId: "callback-b" },
    });

    expect(first.duplicateDelivery).toBe(false);
    expect(second.duplicateDelivery).toBe(false);
  });

  it("does not claim to dedupe when no callback id is supplied", async () => {
    const stateRootDir = await scratchDir();
    const { runtime } = await buildRuntime({ stateRootDir });
    const payload = claudePayload("ses-no-callback");

    const first = await runtime.process({ payload, transport: "hook-stdin", providerHint: "claude-code" });
    const second = await runtime.process({ payload, transport: "hook-stdin", providerHint: "claude-code" });

    // Documented limitation: without a host delivery id, a redelivered payload is
    // indistinguishable from a new observation, because the Claude Code adapter's
    // invocation id embeds a clock reading by design.
    expect(first.duplicateDelivery).toBe(false);
    expect(second.duplicateDelivery).toBe(false);
    expect(first.ingest.identity?.invocationId).not.toBe(second.ingest.identity?.invocationId);
  });
});

describe("hook runtime: bounded flush and containment", () => {
  it("returns within its flush bound when the collector never answers", async () => {
    // A server that accepts the connection and then says nothing at all.
    const server = createServer(() => undefined);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("failed to bind stalled collector");
    }
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const { runtime } = await buildRuntime({
      endpoint: `http://127.0.0.1:${String(address.port)}/v1/traces`,
      flushTimeoutMillis: 250,
    });
    await runtime.process({
      payload: claudePayload("ses-stalled"),
      transport: "hook-stdin",
      providerHint: "claude-code",
    });

    const startedAt = Date.now();
    const report = await runtime.shutdown();
    const elapsed = Date.now() - startedAt;

    expect(report.flushCompleted).toBe(false);
    expect(report.flushTimeoutMillis).toBe(250);
    // The bound is what the host actually pays; a generous ceiling here keeps the
    // assertion about "bounded", not about scheduler precision.
    expect(elapsed).toBeLessThan(5_000);
  }, 30_000);

  it("is idempotent on shutdown and reports health", async () => {
    const { runtime } = await buildRuntime({});
    const first = await runtime.shutdown();
    const second = await runtime.shutdown();
    expect(second).toBe(first);
    expect(runtime.health().subsystems.map((entry) => entry.subsystem)).toEqual(["telemetry-sink"]);
  });

  it("shows why the CLI refuses cross-provider auto-detection instead of letting confidence decide", async () => {
    const stateRootDir = await scratchDir();
    const logger = createRecordingLogger("debug");
    const runtime = createHookRuntime({
      config: DEFAULT_CONFIG,
      registry: createProviderRegistry([createClaudeCodeAdapter(), createCodexAdapter()]),
      stateRootDir,
      installationId: "test-install",
      providerNamespace: "unresolved",
      logger,
    });
    cleanups.push(async () => {
      await runtime.shutdown();
    });

    // With `transcript_path` present, Claude Code and Codex both score the shape
    // "strong", the registry's tie rule fires, and nothing is attributed. Good.
    const tied = await runtime.process({
      payload: claudePayload("ses-tied"),
      transport: "hook-stdin",
    });
    expect(tied.ingest.attribution).toBe("declined");
    expect(tied.ingest.attributionReason).toBe("provider-detection-ambiguous");

    // Drop `transcript_path` — a field Claude Code's own hook protocol does not
    // send on every event — and the tie disappears in the *wrong* direction:
    // Codex still validates the shape at "strong" while Claude Code, whose
    // payload this actually is, can only offer "weak" from shape alone. The
    // result is silent mis-attribution of one agent's telemetry to another.
    //
    // Neither adapter is at fault: self-reported confidence is not comparable
    // across providers. This is the concrete hazard `autoDetectProvider` exists
    // to close by refusing whenever more than one adapter recognizes a payload,
    // and why `--provider` is the supported way to process PascalCase payloads.
    const withoutTranscriptPath = { ...claudePayload("ses-misattribution") };
    delete withoutTranscriptPath.transcript_path;
    const misattributed = await runtime.process({
      payload: withoutTranscriptPath,
      transport: "hook-stdin",
    });
    expect(misattributed.ingest.attribution).toBe("attributed");
    expect(misattributed.ingest.providerId).toBe("codex");
  });

  it("exposes the whole default registry to a host that wants it", () => {
    expect(createDefaultProviderRegistry().adapters.map((adapter) => adapter.id)).toEqual([
      "antigravity",
      "claude-code",
      "codex",
      "cursor",
      "gemini-cli",
    ]);
  });
});
