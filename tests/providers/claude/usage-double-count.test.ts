/**
 * A redelivered Claude Code callback must not count its tokens twice.
 *
 * Run through the real integration runtime over a real filesystem state store,
 * with a **fresh runtime per delivery**: a hook process lives for milliseconds and
 * then exits, so "does suppression survive a restart" is the whole guarantee, and
 * a reused in-process runtime would prove nothing about it.
 *
 * `Stop` is the callback that matters here. It carries a turn's usage, and until
 * `stop_hook_active` was read it had no replay-stable identity at all, so a
 * redelivery double-counted the turn. See docs/claude-code-usage-contract.md,
 * finding 7, and `src/providers/claude/delivery.ts` for why the gate is one-sided.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../../../src/config/schema.js";
import {
  createHookRuntime,
  type HookProcessOutcome,
  type HookRuntimeOptions,
} from "../../../src/integration/hook-runtime.js";
import { createClaudeCodeAdapter } from "../../../src/providers/claude/index.js";
import { createProviderRegistry } from "../../../src/providers/registry.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const scratchDir = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), "otel-hook-claude-usage-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

/**
 * One hook *process*: build a runtime, handle one callback, shut it down. The
 * exporter points nowhere reachable, so telemetry is spooled rather than
 * exported — accounting is what is under test, and it commits under the claim's
 * own lock regardless.
 */
const deliverOnce = async (
  stateRootDir: string,
  payload: unknown,
  options: Partial<HookRuntimeOptions> = {},
): Promise<HookProcessOutcome> => {
  const runtime = createHookRuntime({
    config: {
      ...DEFAULT_CONFIG,
      exporter: { ...DEFAULT_CONFIG.exporter, enabled: false },
    },
    registry: createProviderRegistry([createClaudeCodeAdapter()]),
    stateRootDir,
    installationId: "test-install",
    providerNamespace: "claude-code",
    ...options,
  });
  try {
    return await runtime.process({
      payload,
      transport: "hook-stdin",
      providerHint: "claude-code",
    });
  } finally {
    await runtime.shutdown();
  }
};

const stopPayload = (overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> => ({
  hook_event_name: "Stop",
  session_id: "ses-double-count-0001",
  cwd: "/workspace/contract-repo",
  prompt_id: "prompt-double-count-0001",
  stop_hook_active: false,
  usage: {
    input_tokens: 12,
    output_tokens: 340,
    cache_read_input_tokens: 88_000,
    cache_creation_input_tokens: 4_000,
  },
  ...overrides,
});

const TURN_INPUT_TOKENS = 12 + 88_000 + 4_000;

describe("Claude Code: a redelivered Stop cannot double-count a turn", () => {
  it("suppresses the second delivery of the once-per-prompt stop", async () => {
    const stateRootDir = await scratchDir();
    const payload = stopPayload();

    const first = await deliverOnce(stateRootDir, payload);
    expect(first.duplicateDelivery).toBe(false);
    expect(first.delivery.deduplicated).toBe(true);
    expect(first.usageRollups).toHaveLength(1);
    expect(first.usageRollups[0]?.snapshot.total.inputTokens).toBe(TURN_INPUT_TOKENS);

    // Same callback, delivered again to a brand-new process.
    const second = await deliverOnce(stateRootDir, payload);
    expect(second.duplicateDelivery).toBe(true);
    expect(second.usageRollups).toHaveLength(0);

    // Read the running total back through a third process: exactly one turn.
    const probe = createHookRuntime({
      config: { ...DEFAULT_CONFIG, exporter: { ...DEFAULT_CONFIG.exporter, enabled: false } },
      registry: createProviderRegistry([createClaudeCodeAdapter()]),
      stateRootDir,
      installationId: "test-install",
      providerNamespace: "claude-code",
    });
    const rollup = await probe.usageAccumulator.read({
      sessionId: "ses-double-count-0001",
      scope: "generation",
      scopeKey: first.usageRollups[0]?.scopeKey ?? "",
    });
    await probe.shutdown();
    expect(rollup?.total.inputTokens).toBe(TURN_INPUT_TOKENS);
    expect(rollup?.total.outputTokens).toBe(340);
  }, 60_000);

  it("still accounts a genuine continuation stop rather than mistaking it for a redelivery", async () => {
    const stateRootDir = await scratchDir();

    // The turn stopped, a hook continued it, and it stopped again. Two real
    // firings sharing one prompt_id: both sets of tokens are real.
    const first = await deliverOnce(stateRootDir, stopPayload());
    const continued = await deliverOnce(stateRootDir, stopPayload({ stop_hook_active: true }));

    expect(first.duplicateDelivery).toBe(false);
    expect(continued.duplicateDelivery).toBe(false);
    // A continuation stop is deliberately unidentifiable: suppressing it would
    // lose real tokens, which is worse than exporting a possible duplicate.
    expect(continued.delivery.deduplicated).toBe(false);
    expect(continued.delivery.reason).toBe("callback-not-identifiable");
    expect(continued.usageRollups).toHaveLength(1);
  }, 60_000);

  it("keeps two prompts in one session independent", async () => {
    const stateRootDir = await scratchDir();

    const first = await deliverOnce(stateRootDir, stopPayload());
    const other = await deliverOnce(
      stateRootDir,
      stopPayload({ prompt_id: "prompt-double-count-0002" }),
    );

    expect(first.duplicateDelivery).toBe(false);
    expect(other.duplicateDelivery).toBe(false);
    expect(other.usageRollups).toHaveLength(1);
  }, 60_000);
});

describe("Claude Code: a redelivered SubagentStop cannot double-count a subagent", () => {
  const subagentStop = (
    overrides: Readonly<Record<string, unknown>> = {},
  ): Record<string, unknown> => ({
    hook_event_name: "SubagentStop",
    session_id: "ses-double-count-0002",
    cwd: "/workspace/contract-repo",
    agent_id: "agent-double-count-0001",
    agent_type: "Explore",
    stop_hook_active: false,
    usage: { input_tokens: 5, output_tokens: 700, cache_read_input_tokens: 30_000 },
    ...overrides,
  });

  it("suppresses a redelivery but not a hook-continued second stop", async () => {
    const stateRootDir = await scratchDir();

    const first = await deliverOnce(stateRootDir, subagentStop());
    expect(first.duplicateDelivery).toBe(false);
    expect(first.usageRollups).toHaveLength(1);

    const redelivered = await deliverOnce(stateRootDir, subagentStop());
    expect(redelivered.duplicateDelivery).toBe(true);
    expect(redelivered.usageRollups).toHaveLength(0);

    // Previously this was keyed on agent_id alone, so a continuation stop was
    // suppressed as a redelivery and its tokens were lost.
    const continued = await deliverOnce(stateRootDir, subagentStop({ stop_hook_active: true }));
    expect(continued.duplicateDelivery).toBe(false);
    expect(continued.usageRollups).toHaveLength(1);
  }, 60_000);
});
