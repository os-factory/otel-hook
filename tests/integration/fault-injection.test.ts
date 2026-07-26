import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../../src/config/schema.js";
import { createUsageAccumulator } from "../../src/lifecycle/usage-accumulator.js";
import { normalizeUsageOrThrow } from "../../src/model/usage.js";
import { createProviderRegistry } from "../../src/providers/registry.js";
import { createFixedClock } from "../../src/runtime/clock.js";
import { createOtelHook } from "../../src/runtime/hook.js";
import { createFilesystemStateStore } from "../../src/state/filesystem-store.js";
import { createOtlpTraceSink } from "../../src/telemetry/otlp-sink.js";
import { createFixtureAdapter } from "../../src/testing/index.js";

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(tmpdir(), "otel-hook-fault-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

/**
 * Blocks every filesystem operation the state store would attempt beneath
 * `<blocked>/state`, standing in for "the disk is unusable" (full, permission
 * denied, read-only remount) without depending on OS-specific privilege
 * behavior — a plain file where a directory is expected fails `mkdir` with
 * ENOTDIR regardless of who is running the test.
 */
const brokenStateRoot = async (): Promise<string> => {
  const blocked = path.join(rootDir, "blocked");
  await writeFile(blocked, "not a directory", "utf8");
  return path.join(blocked, "state");
};

describe("fail-open under combined state store and collector failure", () => {
  it("never fails the host: ingest still reports ok, exit code 0, and both failures as diagnostics", async () => {
    const clock = createFixedClock();
    const stateStore = createFilesystemStateStore({
      rootDir: await brokenStateRoot(),
      providerId: "fixture",
      installationId: "install-1",
      clock,
      lockTimeoutMillis: 200,
    });
    const sink = createOtlpTraceSink({
      exporter: {
        ...DEFAULT_CONFIG.exporter,
        endpoint: "http://127.0.0.1:1/v1/traces",
        timeoutMillis: 300,
        maxRetryAttempts: 0,
      },
      providerId: "fixture",
      installationId: "install-1",
      clock,
    });
    const registry = createProviderRegistry([createFixtureAdapter()]);
    const hook = createOtelHook({ sink, stateStore, registry, clock, config: DEFAULT_CONFIG });

    const outcome = await hook.ingest({
      payload: { provider: "fixture", sessionId: "ses_1", event: "session.start", occurredAt: 1_000 },
      transport: "hook-stdin",
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.hookResponse.exitCode).toBe(0);
    expect(outcome.attribution).toBe("attributed");
    expect(outcome.diagnostics.some((diagnostic) => diagnostic.code === "state-store-failure")).toBe(true);
    expect(outcome.diagnostics.some((diagnostic) => diagnostic.code === "telemetry-export-failure")).toBe(true);

    // flush/shutdown must also degrade quietly rather than throw.
    await expect(hook.flush()).resolves.toBeUndefined();
    await expect(hook.shutdown()).resolves.toBeUndefined();
  }, 10_000);

  it("keeps working across repeated invocations despite a permanently broken state store", async () => {
    const clock = createFixedClock({ tickMillis: 1 });
    const stateStore = createFilesystemStateStore({
      rootDir: await brokenStateRoot(),
      providerId: "fixture",
      installationId: "install-1",
      clock,
      lockTimeoutMillis: 200,
    });
    const sink = createOtlpTraceSink({
      exporter: { ...DEFAULT_CONFIG.exporter, enabled: false },
      providerId: "fixture",
      installationId: "install-1",
      clock,
    });
    const registry = createProviderRegistry([createFixtureAdapter()]);
    const hook = createOtelHook({ sink, stateStore, registry, clock, config: DEFAULT_CONFIG });

    for (let index = 0; index < 5; index += 1) {
      const outcome = await hook.ingest({
        payload: { provider: "fixture", sessionId: "ses_1", event: "prompt", occurredAt: 1_000 },
        transport: "hook-stdin",
      });
      expect(outcome.ok).toBe(true);
      expect(outcome.hookResponse.exitCode).toBe(0);
    }
  });
});

describe("fail-open under lock contention", () => {
  it("bounds the wait for a held session lock rather than hanging, and the caller can degrade instead of crashing", async () => {
    const clock = createFixedClock();
    const stateStore = createFilesystemStateStore({
      rootDir: path.join(rootDir, "state"),
      providerId: "fixture",
      installationId: "install-1",
      clock,
      lockTimeoutMillis: 50,
      lockPollIntervalMillis: 5,
      lockStaleMillis: 10_000,
    });
    const accumulator = createUsageAccumulator({ stateStore, clock });
    const key = { sessionId: "ses_contended", scope: "session", scopeKey: "ses_contended" };

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The holder's own wait-and-run window is generous: only the *contended*
    // caller below is expected to hit the store's short default bound.
    const holder = stateStore.withSessionLock("ses_contended", () => gate, { timeoutMillis: 10_000 });

    // A caller that treats a lock-wait failure as just another contained
    // diagnostic, exactly like `ingest` does for every other port failure.
    const contended = await accumulator
      .accumulateDelta(key, normalizeUsageOrThrow({ temporality: "delta", inputTokens: 1 }))
      .then(
        (snapshot) => ({ ok: true as const, snapshot }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    expect(contended.ok).toBe(false);

    release();
    await holder;

    const afterRelease = await accumulator.accumulateDelta(
      key,
      normalizeUsageOrThrow({ temporality: "delta", inputTokens: 1 }),
    );
    // The contended call's work was **cancelled**, not merely queued. Its caller
    // has already been handed a failure and has reported that nothing happened; if
    // the write then landed once the holder released, the total would move after
    // the fact with nobody watching — and a caller that released a delivery claim
    // on the strength of that failure would have double-counted on retry.
    //
    // So exactly one delta is accounted here: this one.
    expect(afterRelease.total.inputTokens).toBe(1);
  });
});
