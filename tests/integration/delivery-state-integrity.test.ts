import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, DEFAULT_EXPORTER_POLICY } from "../../src/config/schema.js";
import {
  createHookRuntime,
  minimumStaleClaimMillis,
  type HookRuntime,
} from "../../src/integration/hook-runtime.js";
import { createClaudeCodeAdapter } from "../../src/providers/claude/adapter.js";
import { createProviderRegistry } from "../../src/providers/registry.js";
import { createFixedClock } from "../../src/runtime/clock.js";
import { createFilesystemStateStore } from "../../src/state/filesystem-store.js";
import { startCapturingCollector, type CapturingCollector } from "../helpers/collector.js";
import { decodeAllExportedSpans } from "../helpers/otlp.js";

/**
 * State integrity around delivery deduplication.
 *
 * These are the invariants that make the at-most-once claim mean anything: a
 * suppressed redelivery must leave canonical state untouched, a claim must only
 * be committed once the observation is durable somewhere, and the stale window
 * must never be short enough to expire under a live process.
 */

let rootDir: string;
const cleanups: (() => Promise<void>)[] = [];

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(tmpdir(), "otel-hook-delivery-state-"));
});

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  await rm(rootDir, { recursive: true, force: true });
});

const withCollector = async (
  respond?: () => { readonly status: number },
): Promise<CapturingCollector> => {
  const collector = await startCapturingCollector(respond);
  cleanups.push(() => collector.close());
  return collector;
};

const SESSION = "ses-state-integrity";
const TOOL_USE_ID = "toolu_state_1";

const postToolUse = {
  hook_event_name: "PostToolUse",
  session_id: SESSION,
  cwd: "/workspace/fixture-repo",
  tool_name: "Read",
  tool_use_id: TOOL_USE_ID,
  tool_response: { content: "ok" },
};

type RuntimeOptions = {
  readonly endpoint?: string;
  readonly enableSpool?: boolean;
  readonly staleClaimMillis?: number;
  readonly clock?: ReturnType<typeof createFixedClock>;
};

const buildRuntime = (options: RuntimeOptions = {}): HookRuntime =>
  createHookRuntime({
    config: {
      ...DEFAULT_CONFIG,
      exporter:
        options.endpoint === undefined
          ? { ...DEFAULT_EXPORTER_POLICY, enabled: false }
          : {
              ...DEFAULT_EXPORTER_POLICY,
              endpoint: options.endpoint,
              timeoutMillis: 300,
              maxRetryAttempts: 0,
            },
      detection: { ...DEFAULT_CONFIG.detection, minimumConfidence: "weak" },
    },
    registry: createProviderRegistry([createClaudeCodeAdapter()]),
    stateRootDir: rootDir,
    installationId: "install-1",
    providerNamespace: "claude-code",
    ...(options.enableSpool === undefined ? {} : { enableSpool: options.enableSpool }),
    ...(options.staleClaimMillis === undefined ? {} : { staleClaimMillis: options.staleClaimMillis }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });

const deliver = async (
  options: RuntimeOptions,
  payload: unknown,
): Promise<Awaited<ReturnType<HookRuntime["process"]>>> => {
  const runtime = buildRuntime(options);
  try {
    return await runtime.process({ payload, transport: "hook-stdin", providerHint: "claude-code" });
  } finally {
    await runtime.shutdown();
  }
};

const readSequence = async (): Promise<number | undefined> => {
  const store = createFilesystemStateStore({
    rootDir,
    providerId: "claude-code",
    installationId: "install-1",
    clock: createFixedClock(),
  });
  const record = await store.read(`sequence:${SESSION}`);
  return record?.value.kind === "sequence" ? record.value.next : undefined;
};

describe("a suppressed redelivery does not mutate canonical state", () => {
  it("leaves the session sequence exactly where the first delivery left it", async () => {
    const collector = await withCollector();
    const options = { endpoint: collector.url };

    const first = await deliver(options, postToolUse);
    expect(first.duplicateDelivery).toBe(false);
    const afterFirst = await readSequence();
    expect(afterFirst).toBeGreaterThan(0);

    // The same callback again. It is recognized as a redelivery, so nothing about
    // the session may move: the sequence seeds every event id, so advancing it
    // would renumber the next genuine event and change its derived id — the exact
    // replay-stability the dedup guard exists to protect.
    const second = await deliver(options, postToolUse);
    expect(second.duplicateDelivery).toBe(true);
    expect(await readSequence()).toBe(afterFirst);

    // ...and a third, to prove it is not merely off by one per delivery.
    await deliver(options, postToolUse);
    expect(await readSequence()).toBe(afterFirst);
  });

  it("still answers the provider's protocol from a real parse", async () => {
    const collector = await withCollector();
    const options = { endpoint: collector.url };

    const first = await deliver(options, postToolUse);
    const second = await deliver(options, postToolUse);

    // A redelivered callback still expects its response, and the response comes
    // from parsing the real payload rather than from a guess.
    expect(second.ingest.hookResponse).toEqual(first.ingest.hookResponse);
    expect(second.ingest.attribution).toBe("attributed");
    expect(second.ingest.events.length).toBeGreaterThan(0);
    // But nothing was exported or accounted for it.
    expect(second.ingest.emitted).toBe(0);
    expect(second.usageRollups).toEqual([]);
  });

  it("does not export a second copy of the span", async () => {
    const collector = await withCollector();
    const options = { endpoint: collector.url };

    await deliver(options, postToolUse);
    const before = decodeAllExportedSpans(collector.bodies()).length;
    await deliver(options, postToolUse);

    expect(decodeAllExportedSpans(collector.bodies())).toHaveLength(before);
  });
});

describe("a claim is only committed once the observation is durable", () => {
  it("releases the claim when export fails and spooling is disabled", async () => {
    // A collector that refuses everything, and no spool: the batch is gone.
    const collector = await withCollector(() => ({ status: 503 }));
    const options = { endpoint: collector.url, enableSpool: false };

    const first = await deliver(options, postToolUse);
    expect(first.ingest.exportRejected).toBeGreaterThan(0);
    // The guarantee lapsed, and the report says so rather than claiming it held.
    expect(first.delivery.retryable).toBe(true);
    expect(first.delivery.deduplicated).toBe(false);

    // Because the claim was released, redelivering is treated as fresh work rather
    // than suppressed. Committing here would have been an at-most-*zero* guarantee:
    // the telemetry lost and the claim saying never to retry.
    const retry = await deliver(options, postToolUse);
    expect(retry.duplicateDelivery).toBe(false);
    expect(retry.ingest.events.length).toBeGreaterThan(0);
  });

  it("commits when the collector refuses but the spool accepts", async () => {
    let up = false;
    const collector = await withCollector(() => ({ status: up ? 200 : 503 }));
    const options = { endpoint: collector.url, enableSpool: true };

    const first = await deliver(options, postToolUse);
    // A successful spool enqueue *is* delivery: a later invocation drains it.
    expect(first.ingest.exportRejected).toBe(0);
    expect(first.delivery.retryable).toBeUndefined();
    expect(first.delivery.deduplicated).toBe(true);

    up = true;
    const retry = await deliver(options, postToolUse);
    expect(retry.duplicateDelivery).toBe(true);
  });

  it("commits on a healthy export", async () => {
    const collector = await withCollector();
    const options = { endpoint: collector.url };

    const first = await deliver(options, postToolUse);
    expect(first.ingest.exportRejected).toBe(0);
    expect(first.delivery.deduplicated).toBe(true);
    expect(first.delivery.outcome).toBe("fresh");

    expect((await deliver(options, postToolUse)).delivery.outcome).toBe("duplicate");
  });
});

describe("the stale-claim window cannot expire under a live process", () => {
  it("derives a floor from the export budget it has to cover", () => {
    const floor = minimumStaleClaimMillis({
      exportTimeoutMillis: 10_000,
      maxRetryAttempts: 2,
      flushTimeoutMillis: 2_000,
      stateLockTimeoutMillis: 1_000,
    });
    // Every bounded post-claim operation, not just the export:
    //   4 locked steps (ingest phase 1, ingest phase 3, the correlator inside the
    //   sink, the dedup commit) + 2 locks per budgeted usage observation × 8,
    //   then the export attempts, the flush, a spool-write and sweep allowance,
    //   and a scheduling margin.
    const lockBudget = 1_000 * (4 + 2 * 8);
    expect(floor).toBe(lockBudget + 10_000 * 3 + 2_000 + 2 * 1_000 + 1_000);
    // Comfortably larger than the export budget alone, which is what the previous
    // formula covered and what made the window too short in practice.
    expect(floor).toBeGreaterThan(10_000 * 3 + 2_000);

    // It tracks the policy rather than being a constant a later timeout change
    // could silently outgrow.
    expect(
      minimumStaleClaimMillis({
        exportTimeoutMillis: 60_000,
        maxRetryAttempts: 5,
        flushTimeoutMillis: 30_000,
        stateLockTimeoutMillis: 5_000,
      }),
    ).toBeGreaterThan(floor);
  });

  it("raises a configured window that is shorter than one process's own work", async () => {
    const clock = createFixedClock();
    const collector = await withCollector();

    // 50ms looks like a harmless tuning knob and is catastrophic: a peer arriving
    // 51ms in would declare a live process abandoned and export the same callback
    // a second time.
    const first = await deliver(
      { endpoint: collector.url, staleClaimMillis: 50, clock },
      postToolUse,
    );
    expect(first.delivery.outcome).toBe("fresh");

    // Far past the *requested* window, well short of the effective one: still
    // treated as committed, not reclaimable.
    clock.advance(5_000);
    const soon = await deliver(
      { endpoint: collector.url, staleClaimMillis: 50, clock },
      postToolUse,
    );
    expect(soon.delivery.outcome).toBe("duplicate");
  });
});

describe("a claim reclaimed under a live holder is detected, not silently overwritten", () => {
  it("refuses a commit whose owner token no longer matches", async () => {
    const clock = createFixedClock();
    const stateStore = createFilesystemStateStore({
      rootDir,
      providerId: "claude-code",
      installationId: "install-1",
      clock,
    });
    const { createCallbackDeduplicator } = await import("../../src/lifecycle/dedup.js");
    const dedup = createCallbackDeduplicator({ stateStore, clock });

    const scope = "delivery";
    const callbackId = "cb-superseded";

    // A first delivery claims the id and starts working.
    const mine = await dedup.claim(scope, callbackId);
    expect(mine.owned).toBe(true);
    expect(mine.owner).toBeDefined();

    // It takes longer than the stale window, so a peer reclaims — which is exactly
    // what a mis-sized floor produces, and no floor computation can be proven
    // exact.
    clock.advance(120_000);
    const peer = await dedup.claim(scope, callbackId, { staleClaimMillis: 1_000 });
    expect(peer.outcome).toBe("reclaimed");
    expect(peer.owner).not.toBe(mine.owner);

    // The original holder now finishes and tries to commit. Overwriting here would
    // tell the peer's live delivery to stand down after it had already exported, so
    // the commit is refused and the condition is reportable.
    const superseded = await dedup.commit(scope, callbackId, mine.owner);
    expect(superseded.status).toBe("superseded");

    // The peer's claim is still in flight, not completed.
    const stillInFlight = await dedup.claim(scope, callbackId, { staleClaimMillis: 600_000 });
    expect(stillInFlight.outcome).toBe("in-flight");

    // And the peer's own commit succeeds.
    expect((await dedup.commit(scope, callbackId, peer.owner)).status).toBe("committed");
  });

  it("commits without a token for callers that do not track ownership", async () => {
    const clock = createFixedClock();
    const stateStore = createFilesystemStateStore({
      rootDir,
      providerId: "claude-code",
      installationId: "install-1",
      clock,
    });
    const { createCallbackDeduplicator } = await import("../../src/lifecycle/dedup.js");
    const dedup = createCallbackDeduplicator({ stateStore, clock });

    await dedup.claim("delivery", "cb-untokened");
    // Backwards compatible: an omitted token means "do not verify", so an existing
    // caller keeps its previous behaviour rather than silently failing to commit.
    expect((await dedup.commit("delivery", "cb-untokened")).status).toBe("committed");
  });
});
