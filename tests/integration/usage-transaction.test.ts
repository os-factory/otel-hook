import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, DEFAULT_EXPORTER_POLICY } from "../../src/config/schema.js";
import { createHookRuntime, type HookRuntime } from "../../src/integration/hook-runtime.js";
import type { CanonicalEvent } from "../../src/model/events.js";
import { createClaudeCodeAdapter } from "../../src/providers/claude/adapter.js";
import { createProviderRegistry } from "../../src/providers/registry.js";
import { createFixedClock } from "../../src/runtime/clock.js";
import {
  classifyDurability,
  createOtelHook,
  isCommittable,
  type HookIngestInput,
} from "../../src/runtime/hook.js";
import { createInMemoryStateStore } from "../../src/runtime/memory.js";
import type { TelemetryEmitResult, TelemetrySink } from "../../src/runtime/ports.js";
import { createFixtureAdapter } from "../../src/testing/index.js";
import { startCapturingCollector, type CapturingCollector } from "../helpers/collector.js";

/**
 * The usage half of the delivery transaction.
 *
 * Accounting is a *commit*, not a side effect of parsing. Deriving a delta moves
 * the stored cumulative baseline forward, which is irreversible, and accumulating a
 * delta into a rollup is not idempotent. Both must therefore happen exactly once,
 * and only for a callback that is actually committed — otherwise a released claim
 * has already consumed its own usage, and the retry either double-counts (delta) or
 * finds nothing left to count (cumulative).
 */

let rootDir: string;
const cleanups: (() => Promise<void>)[] = [];

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(tmpdir(), "otel-hook-usage-tx-"));
});

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  await rm(rootDir, { recursive: true, force: true });
});

const withCollector = async (): Promise<CapturingCollector> => {
  const collector = await startCapturingCollector();
  cleanups.push(() => collector.close());
  return collector;
};

// ---------------------------------------------------------------------------
// Delta usage, end to end through the runtime.
// ---------------------------------------------------------------------------

const SESSION = "ses-usage-tx";

const stopPayload = (promptId: string): unknown => ({
  hook_event_name: "Stop",
  session_id: SESSION,
  transcript_path: "/workspace/fixture-repo/.claude/transcript.jsonl",
  cwd: "/workspace/fixture-repo",
  prompt_id: promptId,
  usage: { input_tokens: 100, cache_read_input_tokens: 40, output_tokens: 20 },
});

const buildRuntime = (options: {
  readonly endpoint?: string;
  readonly enableSpool?: boolean;
}): HookRuntime =>
  createHookRuntime({
    config: {
      ...DEFAULT_CONFIG,
      exporter: {
        ...DEFAULT_EXPORTER_POLICY,
        ...(options.endpoint === undefined
          ? { enabled: false }
          : { endpoint: options.endpoint, timeoutMillis: 300, maxRetryAttempts: 0 }),
      },
      detection: { ...DEFAULT_CONFIG.detection, minimumConfidence: "weak" },
    },
    registry: createProviderRegistry([createClaudeCodeAdapter()]),
    stateRootDir: rootDir,
    installationId: "install-1",
    providerNamespace: "claude-code",
    ...(options.enableSpool === undefined ? {} : { enableSpool: options.enableSpool }),
  });

type Delivered = Awaited<ReturnType<HookRuntime["process"]>>;

const deliver = async (
  options: { readonly endpoint?: string; readonly enableSpool?: boolean },
  payload: unknown,
  callbackId: string,
): Promise<Delivered> => {
  const runtime = buildRuntime(options);
  try {
    return await runtime.process({
      payload,
      transport: "hook-stdin",
      providerHint: "claude-code",
      delivery: { callbackId },
    });
  } finally {
    await runtime.shutdown();
  }
};

/** Highest running total across this invocation's rollups, whatever scope it landed on. */
const runningTotal = (outcome: Delivered): number =>
  outcome.usageRollups.reduce(
    (total, rollup) => Math.max(total, rollup.snapshot.total.inputTokens),
    0,
  );

describe("delta usage is accounted exactly once across a retry", () => {
  it("accounts nothing for a callback whose telemetry was fully lost", async () => {
    const unreachable = { endpoint: "http://127.0.0.1:1/v1/traces", enableSpool: false };

    const lost = await deliver(unreachable, stopPayload("p1"), "cb-delta-1");
    expect(lost.ingest.durability).toBe("lost");
    expect(lost.delivery.retryable).toBe(true);
    // Nothing survived, so nothing may have been accounted — otherwise the retry
    // below would add the same delta a second time. A delta needs no baseline, so
    // there is nothing to make a double-count detectable after the fact.
    expect(lost.ingest.usageObservations).toEqual([]);
    expect(lost.usageRollups).toEqual([]);

    const collector = await withCollector();
    const retry = await deliver({ endpoint: collector.url }, stopPayload("p1"), "cb-delta-1");
    expect(retry.duplicateDelivery).toBe(false);
    expect(retry.ingest.durability).toBe("delivered");

    // Exactly one delta's worth: 100 fresh + 40 cache-read = 140 inclusive.
    expect(runningTotal(retry)).toBe(140);
  });

  it("accounts nothing for a suppressed redelivery", async () => {
    const collector = await withCollector();
    const options = { endpoint: collector.url };

    const first = await deliver(options, stopPayload("p2"), "cb-delta-2");
    expect(runningTotal(first)).toBe(140);

    const again = await deliver(options, stopPayload("p2"), "cb-delta-2");
    expect(again.duplicateDelivery).toBe(true);
    expect(again.ingest.usageObservations).toEqual([]);
    expect(again.usageRollups).toEqual([]);

    // Proven by a genuine second firing of the *same* generation scope — same
    // prompt, new delivery id — so the running total is directly comparable. It
    // moved by exactly one more delta, which means the redelivery in between
    // contributed nothing.
    const genuineSecond = await deliver(options, stopPayload("p2"), "cb-delta-2b");
    expect(genuineSecond.duplicateDelivery).toBe(false);
    expect(runningTotal(genuineSecond)).toBe(280);
  });
});

// ---------------------------------------------------------------------------
// Cumulative usage, at the orchestrator level where the baseline lives.
// ---------------------------------------------------------------------------

/** A sink whose acceptance is scripted, standing in for a collector and a spool. */
const scriptedSink = (
  script: () => { readonly accepted: number; readonly rejected: number },
): TelemetrySink & { readonly batches: CanonicalEvent[][] } => {
  const batches: CanonicalEvent[][] = [];
  return {
    batches,
    emit: (events): Promise<TelemetryEmitResult> => {
      batches.push([...events]);
      const { accepted, rejected } = script();
      return Promise.resolve({ accepted, rejected, errors: [] });
    },
    flush: (): Promise<void> => Promise.resolve(),
    shutdown: (): Promise<void> => Promise.resolve(),
  };
};

const fixtureInput = (usage: Record<string, unknown>): HookIngestInput => ({
  payload: {
    provider: "fixture",
    sessionId: "ses_cumulative",
    event: "session.end",
    occurredAt: 1_700_000_000_000,
    usage,
  },
  transport: "hook-stdin",
});

const cumulative = (inputTokens: number, outputTokens: number): Record<string, unknown> => ({
  temporality: "cumulative",
  inputTokens,
  outputTokens,
});

describe("cumulative usage keeps its baseline until the callback is committed", () => {
  const buildHook = (
    script: () => { readonly accepted: number; readonly rejected: number },
  ): {
    readonly hook: ReturnType<typeof createOtelHook>;
    readonly stateStore: ReturnType<typeof createInMemoryStateStore>;
  } => {
    const clock = createFixedClock();
    const stateStore = createInMemoryStateStore({ clock });
    const hook = createOtelHook({
      sink: scriptedSink(script),
      stateStore,
      registry: createProviderRegistry([createFixtureAdapter()]),
      clock,
      config: {
        ...DEFAULT_CONFIG,
        detection: { ...DEFAULT_CONFIG.detection, minimumConfidence: "weak" },
      },
    });
    return { hook, stateStore };
  };

  const baselineOf = (
    stateStore: ReturnType<typeof createInMemoryStateStore>,
  ): number | undefined => {
    const record = stateStore.snapshot().get("usage:ses_cumulative:session:ses_cumulative");
    return record?.value.kind === "usage-cumulative" ? record.value.usage.inputTokens : undefined;
  };

  it("does not advance the baseline when nothing was delivered", async () => {
    let accept = true;
    const { hook, stateStore } = buildHook(() =>
      accept ? { accepted: 1, rejected: 0 } : { accepted: 0, rejected: 1 },
    );

    // Establish the baseline at 100 with a delivered callback.
    const established = await hook.ingest(fixtureInput(cumulative(100, 20)));
    expect(established.durability).toBe("delivered");
    expect(baselineOf(stateStore)).toBe(100);

    // A report at 150 that reaches nobody.
    accept = false;
    const lost = await hook.ingest(fixtureInput(cumulative(150, 25)));
    expect(lost.durability).toBe("lost");
    expect(lost.usageObservations).toEqual([]);
    // The baseline must still read 100. Had it advanced to 150, the 50-token
    // difference would be unrecoverable: the retry would diff 150 against 150 and
    // report zero, so the tokens would be silently gone rather than merely delayed.
    expect(baselineOf(stateStore)).toBe(100);

    // The retry still has the difference to count.
    accept = true;
    const retry = await hook.ingest(fixtureInput(cumulative(150, 25)));
    expect(retry.durability).toBe("delivered");
    const observed = retry.usageObservations.find((o) => o.scope === "session");
    expect(observed?.reportedTemporality).toBe("cumulative");
    expect(observed?.delta.inputTokens).toBe(50);
    expect(baselineOf(stateStore)).toBe(150);
  });

  it("advances the baseline exactly once for a delivered callback", async () => {
    const { hook, stateStore } = buildHook(() => ({ accepted: 1, rejected: 0 }));

    await hook.ingest(fixtureInput(cumulative(100, 20)));
    const second = await hook.ingest(fixtureInput(cumulative(180, 35)));

    expect(second.usageObservations.find((o) => o.scope === "session")?.delta.inputTokens).toBe(80);
    expect(baselineOf(stateStore)).toBe(180);
  });

  it("does not advance the baseline for a suppressed redelivery", async () => {
    const { hook, stateStore } = buildHook(() => ({ accepted: 1, rejected: 0 }));

    await hook.ingest(fixtureInput(cumulative(100, 20)));
    const suppressed = await hook.ingest(fixtureInput(cumulative(150, 25)), { suppress: true });

    expect(suppressed.usageObservations).toEqual([]);
    expect(baselineOf(stateStore)).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Partial batches.
// ---------------------------------------------------------------------------

describe("a partial batch is terminal, not retryable", () => {
  it("commits and accounts once when some spans survived", async () => {
    const clock = createFixedClock();
    const stateStore = createInMemoryStateStore({ clock });
    const hook = createOtelHook({
      // One span accepted, one refused: the shape of a chunked export where the
      // collector went away midway.
      sink: scriptedSink(() => ({ accepted: 1, rejected: 1 })),
      stateStore,
      registry: createProviderRegistry([createFixtureAdapter()]),
      clock,
      config: {
        ...DEFAULT_CONFIG,
        detection: { ...DEFAULT_CONFIG.detection, minimumConfidence: "weak" },
      },
    });

    const outcome = await hook.ingest(fixtureInput(cumulative(100, 20)));

    expect(outcome.durability).toBe("partial");
    expect(isCommittable(outcome.durability)).toBe(true);
    // Committable, so the accounting applies — once. Retrying the callback would
    // re-export the span the collector already accepted, turning a reported loss
    // into a silent double-count.
    expect(outcome.usageObservations.length).toBeGreaterThan(0);
    expect(
      stateStore.snapshot().get("usage:ses_cumulative:session:ses_cumulative")?.value.kind,
    ).toBe("usage-cumulative");
  });

  it("keeps a partial batch out of the retryable bucket", () => {
    // The runtime's claim decision is `isCommittable(ingest.durability)`, so this
    // pins the property that matters: `partial` is on the commit side of the line,
    // together with the outcomes that lost nothing, and only `lost` is retryable.
    //
    // Note on coverage: a genuine multi-chunk partial is not reachable by feeding
    // one payload to a real adapter, because each shipped adapter maps a single
    // callback to a single span — an in-batch start/end pair merges into one
    // record. The sink-level semantics are therefore pinned by the scripted-sink
    // test above, and the claim-side consequence by these two assertions plus the
    // release path in `delivery-state-integrity.test.ts`.
    expect(isCommittable("partial")).toBe(true);
    expect(isCommittable("lost")).toBe(false);
  });
});

describe("classifyDurability draws the any-versus-all boundary", () => {
  it("treats a partial batch as terminal and only a total loss as retryable", () => {
    expect(classifyDurability({ attempted: false, accepted: 0, rejected: 0 })).toBe(
      "nothing-to-deliver",
    );
    expect(classifyDurability({ attempted: true, accepted: 3, rejected: 0 })).toBe("delivered");
    expect(classifyDurability({ attempted: true, accepted: 1, rejected: 2 })).toBe("partial");
    expect(classifyDurability({ attempted: true, accepted: 0, rejected: 2 })).toBe("lost");

    // Only a total loss may be retried, because only then is there nothing to
    // duplicate.
    expect(isCommittable("nothing-to-deliver")).toBe(true);
    expect(isCommittable("delivered")).toBe(true);
    expect(isCommittable("partial")).toBe(true);
    expect(isCommittable("lost")).toBe(false);
  });
});
