import { describe, expect, it } from "vitest";

import type { CanonicalEvent, HookIngestInput } from "../../../src/index.js";
import { createClaudeCodeAdapter } from "../../../src/providers/claude/index.js";
import { createTestHook } from "../../../src/testing/index.js";
import * as fixtures from "../../fixtures/claude/index.js";

const ingest = (payload: unknown, overrides: Partial<HookIngestInput> = {}) => {
  const harness = createTestHook({ adapters: [createClaudeCodeAdapter()] });
  return { harness, run: () => harness.hook.ingest({ payload, transport: "hook-stdin", ...overrides }) };
};

const eventOfType = (events: readonly CanonicalEvent[], type: CanonicalEvent["type"]): CanonicalEvent => {
  const found = events.find((event) => event.type === type);
  if (found === undefined) {
    throw new Error(`expected an event of type ${type}, got: ${events.map((event) => event.type).join(", ")}`);
  }
  return found;
};

describe("Claude Code adapter: lifecycle mapping", () => {
  it("SessionStart -> session.start", async () => {
    const { run } = ingest(fixtures.sessionStart);
    const outcome = await run();
    expect(outcome.attribution).toBe("attributed");
    expect(outcome.events).toHaveLength(1);
    const event = eventOfType(outcome.events, "session.start");
    if (event.type !== "session.start") throw new Error("unreachable");
    expect(event.sessionKind).toBe("unknown");
    expect(event.agentName).toBe("claude-code");
    expect(event.model).toEqual({ modelId: "claude-opus-5" });
    expect(event.provenance.providerId).toBe("claude-code");
    expect(event.workspace.keySource).toBe("working-directory");
  });

  it("SessionStart without a model omits the model descriptor", async () => {
    const { run } = ingest(fixtures.sessionStartResumed);
    const outcome = await run();
    const event = eventOfType(outcome.events, "session.start");
    if (event.type !== "session.start") throw new Error("unreachable");
    expect(event.model).toBeUndefined();
  });

  it("UserPromptSubmit -> prompt.submitted, content omitted by default policy", async () => {
    const { run } = ingest(fixtures.userPromptSubmit);
    const outcome = await run();
    const event = eventOfType(outcome.events, "prompt.submitted");
    if (event.type !== "prompt.submitted") throw new Error("unreachable");
    expect(event.promptSource).toBe("user");
    expect(event.content?.disclosure).toBe("omitted");
    expect(event.content?.text).toBeUndefined();
    expect(event.content?.characterLength).toBe(fixtures.userPromptSubmit.prompt.length);
  });

  it("PreToolUse -> tool.start with inferred tool kind", async () => {
    const { run } = ingest(fixtures.preToolUseBash);
    const outcome = await run();
    const event = eventOfType(outcome.events, "tool.start");
    if (event.type !== "tool.start") throw new Error("unreachable");
    expect(event.toolCallId).toBe("toolu_synthetic_0001");
    expect(event.toolName).toBe("Bash");
    expect(event.toolKind).toBe("execute");
  });

  it("PostToolUse -> tool.end with outcome ok", async () => {
    const { run } = ingest(fixtures.postToolUseBash);
    const outcome = await run();
    const event = eventOfType(outcome.events, "tool.end");
    if (event.type !== "tool.end") throw new Error("unreachable");
    expect(event.outcome).toBe("ok");
    expect(event.toolCallId).toBe("toolu_synthetic_0001");
  });

  it("PostToolUseFailure -> tool.end with outcome error", async () => {
    const { run } = ingest(fixtures.postToolUseFailure);
    const outcome = await run();
    const event = eventOfType(outcome.events, "tool.end");
    if (event.type !== "tool.end") throw new Error("unreachable");
    expect(event.outcome).toBe("error");
  });

  it("PermissionRequest is recognized but carries no telemetry", async () => {
    const { run } = ingest(fixtures.permissionRequest);
    const outcome = await run();
    expect(outcome.attribution).toBe("not-applicable");
    expect(outcome.attributionReason).toBe("adapter-ignored-input");
    expect(outcome.events).toHaveLength(0);
  });

  it("PreCompact is recognized but carries no telemetry (reported at PostCompact instead)", async () => {
    const { run } = ingest(fixtures.preCompact);
    const outcome = await run();
    expect(outcome.attribution).toBe("not-applicable");
    expect(outcome.events).toHaveLength(0);
  });

  it("PostCompact -> compaction.performed with usage", async () => {
    const { run } = ingest(fixtures.postCompact);
    const outcome = await run();
    const event = eventOfType(outcome.events, "compaction.performed");
    if (event.type !== "compaction.performed") throw new Error("unreachable");
    expect(event.trigger).toBe("automatic");
    expect(event.usage?.temporality).toBe("delta");
    expect(event.usage?.cachedInputTokens).toBe(42_000);
    expect(event.usage?.cacheCreationInputTokens).toBe(6_000);
    expect(event.usage?.uncachedInputTokens).toBe(300);
    expect(event.usage?.totalTokens).toBe(event.usage!.inputTokens + event.usage!.outputTokens);
  });

  it("SubagentStart -> subagent.start, SubagentStop -> subagent.end with the same subagentInvocationId", async () => {
    const startHarness = createTestHook({ adapters: [createClaudeCodeAdapter()] });
    const startOutcome = await startHarness.hook.ingest({ payload: fixtures.subagentStart, transport: "hook-stdin" });
    const stopHarness = createTestHook({ adapters: [createClaudeCodeAdapter()] });
    const stopOutcome = await stopHarness.hook.ingest({ payload: fixtures.subagentStop, transport: "hook-stdin" });

    const startEvent = eventOfType(startOutcome.events, "subagent.start");
    const stopEvent = eventOfType(stopOutcome.events, "subagent.end");
    if (startEvent.type !== "subagent.start" || stopEvent.type !== "subagent.end") {
      throw new Error("unreachable");
    }
    expect(startEvent.subagentInvocationId).toBe(stopEvent.subagentInvocationId);
    expect(startEvent.delegationDepth).toBe(1);
    expect(startEvent.subagentType).toBe("Explore");
    expect(stopEvent.outcome).toBe("ok");
    expect(stopEvent.usage?.cachedInputTokens).toBe(4096);
  });

  it("a tool call from inside a subagent links back via parentInvocationId", async () => {
    const subagentHarness = createTestHook({ adapters: [createClaudeCodeAdapter()] });
    const subagentOutcome = await subagentHarness.hook.ingest({
      payload: fixtures.subagentStart,
      transport: "hook-stdin",
    });
    const startEvent = eventOfType(subagentOutcome.events, "subagent.start");
    if (startEvent.type !== "subagent.start") throw new Error("unreachable");

    const toolHarness = createTestHook({ adapters: [createClaudeCodeAdapter()] });
    const toolOutcome = await toolHarness.hook.ingest({
      payload: fixtures.preToolUseFromSubagent,
      transport: "hook-stdin",
    });

    expect(toolOutcome.identity?.parentInvocationId).toBe(startEvent.subagentInvocationId);
    expect(toolOutcome.identity?.agentInstanceId).toBe("agent-explore-0001");
  });

  it("Stop -> generation.start + generation.end with usage", async () => {
    const { run } = ingest(fixtures.stop);
    const outcome = await run();
    expect(outcome.events.map((event) => event.type)).toEqual(["generation.start", "generation.end"]);
    const end = eventOfType(outcome.events, "generation.end");
    if (end.type !== "generation.end") throw new Error("unreachable");
    expect(end.outcome).toBe("ok");
    expect(end.model).toEqual({ modelId: "unknown" });
    expect(end.usage?.temporality).toBe("delta");
  });

  it("Stop without usage omits the usage field entirely", async () => {
    const { run } = ingest(fixtures.stopNoUsage);
    const outcome = await run();
    const end = eventOfType(outcome.events, "generation.end");
    if (end.type !== "generation.end") throw new Error("unreachable");
    expect(end.usage).toBeUndefined();
  });

  it("StopFailure(rate_limit) -> generation.end outcome error with stopReason", async () => {
    const { run } = ingest(fixtures.stopFailureRateLimit);
    const outcome = await run();
    const end = eventOfType(outcome.events, "generation.end");
    if (end.type !== "generation.end") throw new Error("unreachable");
    expect(end.outcome).toBe("error");
    expect(end.stopReason).toBe("rate_limit");
  });

  it("StopFailure(authentication_failed) -> generation.end outcome denied", async () => {
    const { run } = ingest(fixtures.stopFailureAuth);
    const outcome = await run();
    const end = eventOfType(outcome.events, "generation.end");
    if (end.type !== "generation.end") throw new Error("unreachable");
    expect(end.outcome).toBe("denied");
  });

  it.each([
    ["clear", fixtures.sessionEndClear, "completed"],
    ["logout", fixtures.sessionEndLogout, "aborted"],
    ["a future reason", fixtures.sessionEndUnknownReason, "unknown"],
  ] as const)("SessionEnd(%s) -> session.end reason=%s", async (_label, payload, expected) => {
    const { run } = ingest(payload);
    const outcome = await run();
    const event = eventOfType(outcome.events, "session.end");
    if (event.type !== "session.end") throw new Error("unreachable");
    expect(event.reason).toBe(expected);
  });
});
