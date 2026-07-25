import { describe, expect, it } from "vitest";

import { createCursorAdapter, CURSOR_CAPABILITIES } from "../../../src/providers/cursor/index.js";
import {
  describeAdapter,
  invocationIdentitySchema,
  providerDetectionSchema,
  type CanonicalEvent,
  type ProviderContext,
  type ProviderParseInput,
} from "../../../src/index.js";
import {
  batchContains,
  createDeterministicIdGenerator,
  createFixedClock,
  createRecordingLogger,
  createTestHook,
  createTestPrivacyService,
  findDisclosureViolations,
  type TestHarness,
} from "../../../src/testing/index.js";
import {
  afterAgentResponsePayload,
  afterAgentThoughtPayload,
  afterFileEditPayload,
  afterMCPExecutionPayload,
  afterShellExecutionPayload,
  afterToolUsePayload,
  BASE_TIMESTAMP,
  beforeMCPExecutionPayload,
  beforeReadFilePayload,
  beforeShellExecutionPayload,
  beforeSubmitPromptPayload,
  beforeToolUsePayload,
  CONVERSATION_A,
  CONVERSATION_B,
  legacyBeforeSubmitPromptPayload,
  legacySessionStartPayload,
  legacyStopPayload,
  malformedPayload,
  preCompactPayload,
  secretBearingPromptPayload,
  secretBearingToolInputPayload,
  sessionEndPayload,
  sessionStartPayload,
  stopPayload,
  subagentStartPayload,
  subagentStopPayload,
  toolUseFailedPayload,
  unknownProviderPayload,
  WORKSPACE_ROOT_MULTI,
} from "../../fixtures/cursor/payloads.js";

const harnessWithCursor = (): TestHarness => createTestHook({ adapters: [createCursorAdapter()] });

const ingest = (harness: TestHarness, payload: unknown) =>
  harness.hook.ingest({ payload, transport: "hook-stdin" });

const eventOfType = <T extends CanonicalEvent["type"]>(
  events: readonly CanonicalEvent[],
  type: T,
): Extract<CanonicalEvent, { type: T }> => {
  const found = events.find((event): event is Extract<CanonicalEvent, { type: T }> => event.type === type);
  if (found === undefined) {
    throw new Error(`expected an event of type ${type}, got: ${events.map((e) => e.type).join(", ")}`);
  }
  return found;
};

/** A manually-built context/identity pair for calling the adapter directly. */
const manualContext = (): ProviderContext => ({
  privacy: createTestPrivacyService(),
  clock: createFixedClock(),
  ids: createDeterministicIdGenerator({ namespace: "cursor-unit" }),
  logger: createRecordingLogger(),
  limits: createTestPrivacyService().policy.limits,
});

const manualParseInput = (payload: unknown, sequenceBase = 0): ProviderParseInput => ({
  payload,
  transport: "hook-stdin",
  environment: {},
  detection: providerDetectionSchema.parse({
    providerId: "cursor",
    confidence: "exact",
    reasons: ["manual test"],
  }),
  identity: invocationIdentitySchema.parse({
    invocationId: "inv_manual_0000000000000001",
    sessionId: CONVERSATION_A,
    provenance: {
      providerId: "cursor",
      adapterId: "cursor",
      adapterVersion: "1.0.0",
      detectionConfidence: "exact",
      transport: "hook-stdin",
    },
    workspace: { workspaceId: "unknown:0000000000000000", keySource: "unknown" },
    startedAt: BASE_TIMESTAMP,
    consumerAttributes: {},
  }),
  sequenceBase,
});

describe("cursor adapter: capabilities", () => {
  it("declares its identity and capabilities honestly", () => {
    const adapter = createCursorAdapter();
    expect(adapter.id).toBe("cursor");
    expect(describeAdapter(adapter)).toMatchObject({
      id: "cursor",
      lifecycleEvents: expect.arrayContaining(["session.start", "tool.start", "subagent.start"]) as unknown,
    });
    expect(CURSOR_CAPABILITIES.reportsCachedInput).toBe(false);
    expect(CURSOR_CAPABILITIES.reportsCacheCreation).toBe(false);
    expect(CURSOR_CAPABILITIES.cacheCreationAccounting).toBe("not-reported");
    expect(CURSOR_CAPABILITIES.reportsReasoningOutput).toBe(false);
    expect(CURSOR_CAPABILITIES.reportsProviderTotal).toBe(false);
    expect(CURSOR_CAPABILITIES.reportsCost).toBe(false);
    expect(CURSOR_CAPABILITIES.requiresHookResponse).toBe(true);
  });
});

describe("cursor adapter: lifecycle contract", () => {
  it("maps sessionStart to session.start", async () => {
    const harness = harnessWithCursor();
    const outcome = await ingest(harness, sessionStartPayload());

    expect(outcome.attribution).toBe("attributed");
    expect(outcome.identity?.sessionId).toBe(CONVERSATION_A);
    const event = eventOfType(harness.sink.events(), "session.start");
    expect(event.sessionKind).toBe("interactive");
    expect(event.agentName).toBe("cursor-cli");
    expect(event.model).toEqual({ modelId: "synthetic-model-large", vendor: "synthetic-labs" });
    expect(event.workspace.keySource).toBe("working-directory");
  });

  it("derives a stable workspace identity for multiple workspace roots", async () => {
    const harness = harnessWithCursor();
    const outcome = await ingest(
      harness,
      sessionStartPayload({ workspaceRoots: WORKSPACE_ROOT_MULTI }),
    );
    expect(outcome.identity?.workspace.keySource).toBe("explicit");
  });

  it("maps sessionEnd to session.end", async () => {
    const harness = harnessWithCursor();
    await ingest(harness, sessionEndPayload());
    const event = eventOfType(harness.sink.events(), "session.end");
    expect(event.reason).toBe("completed");
    expect(event.durationMillis).toBe(60_000);
  });

  it("maps beforeSubmitPrompt to prompt.submitted and generation.start", async () => {
    const harness = harnessWithCursor();
    await ingest(harness, beforeSubmitPromptPayload());
    const events = harness.sink.events();

    const prompt = eventOfType(events, "prompt.submitted");
    expect(prompt.promptSource).toBe("user");
    expect(prompt.turnIndex).toBe(0);
    expect(prompt.content?.disclosure).toBe("omitted");
    expect(prompt.content?.text).toBeUndefined();
    expect(prompt.content?.characterLength).toBeGreaterThan(0);

    const generationStart = eventOfType(events, "generation.start");
    expect(generationStart.generationId).toBe("gen_0001");
    expect(generationStart.model).toEqual({ modelId: "synthetic-model-large", vendor: "synthetic-labs" });
  });

  it("maps afterAgentResponse to generation.end carrying the response", async () => {
    const harness = harnessWithCursor();
    await ingest(harness, afterAgentResponsePayload());
    const event = eventOfType(harness.sink.events(), "generation.end");
    expect(event.generationId).toBe("gen_0001");
    expect(event.outcome).toBe("ok");
    expect(event.outputContent?.[0]?.disclosure).toBe("omitted");
    expect(event.outputContent?.[0]?.text).toBeUndefined();
    expect(event.usage).toBeUndefined();
  });

  it("never defaults an absent model to a Claude model", async () => {
    const harness = harnessWithCursor();
    await ingest(harness, afterAgentResponsePayload({ model: undefined }));
    const event = eventOfType(harness.sink.events(), "generation.end");
    expect(event.model).toEqual({ modelId: "unknown" });
    expect(JSON.stringify(event.model).toLowerCase()).not.toContain("claude");
    expect(JSON.stringify(event.model).toLowerCase()).not.toContain("anthropic");
  });

  it("maps beforeToolUse/afterToolUse to a matching tool.start/tool.end pair", async () => {
    const harness = harnessWithCursor();
    await ingest(harness, beforeToolUsePayload());
    await ingest(harness, afterToolUsePayload());
    const events = harness.sink.events();

    const start = eventOfType(events, "tool.start");
    const end = eventOfType(events, "tool.end");
    expect(start.toolCallId).toBe("call_0001");
    expect(end.toolCallId).toBe("call_0001");
    expect(start.toolKind).toBe("search");
    expect(end.outcome).toBe("ok");
  });

  it("maps toolUseFailed to a tool.end with outcome error", async () => {
    const harness = harnessWithCursor();
    await ingest(harness, toolUseFailedPayload());
    const event = eventOfType(harness.sink.events(), "tool.end");
    expect(event.outcome).toBe("error");
    expect(event.output?.disclosure).toBe("omitted");
  });

  it("maps subagentStart/subagentStop and preserves Cursor's own subagent id exactly", async () => {
    const harness = harnessWithCursor();
    await ingest(harness, subagentStartPayload());
    await ingest(harness, subagentStopPayload());
    const events = harness.sink.events();

    const start = eventOfType(events, "subagent.start");
    const end = eventOfType(events, "subagent.end");
    expect(start.subagentInvocationId).toBe("inv_subagent_0001");
    expect(end.subagentInvocationId).toBe("inv_subagent_0001");
    expect(start.delegationDepth).toBe(1);
    expect(end.outcome).toBe("ok");
  });

  it("maps preCompact to compaction.performed without inventing an after-total", async () => {
    const harness = harnessWithCursor();
    await ingest(harness, preCompactPayload());
    const event = eventOfType(harness.sink.events(), "compaction.performed");
    expect(event.trigger).toBe("automatic");
    expect(event.contextTokensBefore).toBe(128_000);
    expect(event.contextTokensAfter).toBeUndefined();
  });

  it("recognizes beforeReadFile but ignores it rather than fabricating an unclosable tool lifecycle", async () => {
    const harness = harnessWithCursor();
    const outcome = await ingest(harness, beforeReadFilePayload());
    expect(outcome.attribution).toBe("not-applicable");
    expect(outcome.attributionReason).toBe("adapter-ignored-input");
    expect(harness.sink.events()).toEqual([]);
    expect(outcome.hookResponse.contract).toBe("provider-protocol");
    expect(outcome.hookResponse.stdout).toBe('{"continue":true}');
    expect(batchContains(harness.sink.events(), "/workspace/synthetic-repo-a/src/billing.ts")).toBe(false);
  });

  it("maps afterFileEdit to a self-contained tool.start/tool.end pair", async () => {
    const harness = harnessWithCursor();
    await ingest(harness, afterFileEditPayload());
    const events = harness.sink.events();
    const start = eventOfType(events, "tool.start");
    const end = eventOfType(events, "tool.end");
    expect(start.toolCallId).toBe(end.toolCallId);
    expect(start.toolKind).toBe("write");
    expect(end.outcome).toBe("ok");
    expect(batchContains(events, "/workspace/synthetic-repo-a/src/billing.ts")).toBe(false);
  });

  it("recognizes afterAgentThought but ignores it rather than fabricating a second generation.end", async () => {
    const harness = harnessWithCursor();
    await ingest(harness, afterAgentResponsePayload());
    const outcome = await ingest(harness, afterAgentThoughtPayload());

    expect(outcome.attribution).toBe("not-applicable");
    expect(outcome.attributionReason).toBe("adapter-ignored-input");
    const generationEnds = harness.sink.events().filter((event) => event.type === "generation.end");
    expect(generationEnds).toHaveLength(1);
    expect(generationEnds[0]?.generationId).toBe("gen_0001");
    expect(batchContains(harness.sink.events(), "billing module tests")).toBe(false);
  });
});

describe("cursor adapter: stop is generation status", () => {
  it("does not duplicate a generation already reported by afterAgentResponse", async () => {
    const harness = harnessWithCursor();
    await ingest(harness, afterAgentResponsePayload());
    const outcome = await ingest(harness, stopPayload({ generationCompleted: true }));

    expect(outcome.attribution).toBe("not-applicable");
    expect(outcome.attributionReason).toBe("adapter-ignored-input");
    const generationEnds = harness.sink.events().filter((event) => event.type === "generation.end");
    expect(generationEnds).toHaveLength(1);
  });

  it("is the sole reporter of an interrupted generation's outcome", async () => {
    const harness = harnessWithCursor();
    const outcome = await ingest(
      harness,
      stopPayload({ stopReason: "cancelled", generationCompleted: false }),
    );

    expect(outcome.attribution).toBe("attributed");
    const event = eventOfType(harness.sink.events(), "generation.end");
    expect(event.outcome).toBe("cancelled");
    expect(event.stopReason).toBe("cancelled");
  });
});

describe("cursor adapter: dedicated shell/MCP correlation", () => {
  it("correlates via an explicit shared tool call id", async () => {
    const harness = harnessWithCursor();
    await ingest(harness, beforeShellExecutionPayload({ toolCallId: "call_shell_1" }));
    await ingest(harness, afterShellExecutionPayload({ toolCallId: "call_shell_1" }));
    const events = harness.sink.events();
    const end = eventOfType(events, "tool.end");
    expect(end.toolCallId).toBe("call_shell_1");
    expect(end.extensions["cursor.tool_correlation"]).toBe("explicit");
  });

  it("correlates against exactly one compatible open invocation", async () => {
    const harness = harnessWithCursor();
    const outcome = await ingest(
      harness,
      afterShellExecutionPayload({
        command: "echo synthetic-build-step",
        openInvocations: [
          { toolCallId: "call_open_1", command: "echo synthetic-build-step" },
          { toolCallId: "call_open_2", command: "echo something-else" },
        ],
      }),
    );
    expect(outcome.attribution).toBe("attributed");
    const end = eventOfType(harness.sink.events(), "tool.end");
    expect(end.toolCallId).toBe("call_open_1");
    expect(end.extensions["cursor.tool_correlation"]).toBe("matched");
  });

  it("stays uncorrelated when zero candidates are compatible", async () => {
    const harness = harnessWithCursor();
    await ingest(harness, afterShellExecutionPayload({ openInvocations: [] }));
    const end = eventOfType(harness.sink.events(), "tool.end");
    expect(end.extensions["cursor.tool_correlation"]).toBe("uncorrelated");
  });

  it("stays uncorrelated when multiple candidates are compatible (ambiguous)", async () => {
    const harness = harnessWithCursor();
    await ingest(
      harness,
      afterShellExecutionPayload({
        command: "echo synthetic-build-step",
        openInvocations: [
          { toolCallId: "call_open_1", command: "echo synthetic-build-step" },
          { toolCallId: "call_open_2", command: "echo synthetic-build-step" },
        ],
      }),
    );
    const end = eventOfType(harness.sink.events(), "tool.end");
    expect(end.extensions["cursor.tool_correlation"]).toBe("uncorrelated");
    expect(["call_open_1", "call_open_2"]).not.toContain(end.toolCallId);
  });

  it("mints a deterministic id when uncorrelated, stable across replay", async () => {
    const harnessA = harnessWithCursor();
    const harnessB = harnessWithCursor();
    const payload = afterShellExecutionPayload({ openInvocations: [] });

    await ingest(harnessA, payload);
    await ingest(harnessB, payload);

    const endA = eventOfType(harnessA.sink.events(), "tool.end");
    const endB = eventOfType(harnessB.sink.events(), "tool.end");
    expect(endA.toolCallId).toBe(endB.toolCallId);
  });

  it("applies the same correlation rules to dedicated MCP callbacks", async () => {
    const harness = harnessWithCursor();
    await ingest(harness, beforeMCPExecutionPayload());
    const outcome = await ingest(
      harness,
      afterMCPExecutionPayload({
        openInvocations: [{ toolCallId: "call_mcp_1", server: "synthetic-mcp-server", tool: "lookup" }],
      }),
    );
    expect(outcome.attribution).toBe("attributed");
    const end = eventOfType(harness.sink.events(), "tool.end");
    expect(end.toolCallId).toBe("call_mcp_1");
    expect(end.extensions["cursor.tool_correlation"]).toBe("matched");
  });

  it("reports an MCP failure via isError", async () => {
    const harness = harnessWithCursor();
    await ingest(harness, afterMCPExecutionPayload({ isError: true, openInvocations: [] }));
    const end = eventOfType(harness.sink.events(), "tool.end");
    expect(end.outcome).toBe("error");
  });
});

describe("cursor adapter: current and legacy event aliases", () => {
  it("normalizes a legacy snake_case sessionStart identically to the current shape", async () => {
    const current = harnessWithCursor();
    const legacy = harnessWithCursor();

    await ingest(current, sessionStartPayload());
    const legacyOutcome = await ingest(legacy, legacySessionStartPayload());

    expect(legacyOutcome.attribution).toBe("attributed");
    const currentEvent = eventOfType(current.sink.events(), "session.start");
    const legacyEvent = eventOfType(legacy.sink.events(), "session.start");
    expect(legacyEvent.sessionKind).toBe(currentEvent.sessionKind);
    expect(legacyEvent.agentName).toBe(currentEvent.agentName);
    expect(legacyEvent.provenance.sourceEventName).toBe("session_start");
    expect(currentEvent.provenance.sourceEventName).toBe("sessionStart");
  });

  it("normalizes the renamed before_user_prompt/agent_stop legacy events", async () => {
    const harness = harnessWithCursor();
    await ingest(harness, legacyBeforeSubmitPromptPayload());
    const prompt = eventOfType(harness.sink.events(), "prompt.submitted");
    expect(prompt.promptSource).toBe("user");
    expect(prompt.provenance.sourceEventName).toBe("before_user_prompt");

    const stopOutcome = await ingest(harness, legacyStopPayload());
    expect(stopOutcome.attribution).toBe("attributed");
    const stopEvents = harness.sink.events().filter((event) => event.type === "generation.end");
    expect(stopEvents.some((event) => event.provenance.sourceEventName === "agent_stop")).toBe(true);
  });

  it("emits a warning noting the legacy alias was used", () => {
    const adapter = createCursorAdapter();
    const context = manualContext();
    const detection = adapter.detect(
      { payload: legacySessionStartPayload(), transport: "hook-stdin", environment: {} },
      context,
    );
    expect(detection.confidence).toBe("exact");
    expect(detection.sourceEventName).toBe("session_start");

    const result = adapter.parse(manualParseInput(legacySessionStartPayload()), context);
    expect(result.status).toBe("parsed");
    if (result.status === "parsed") {
      expect(result.warnings?.some((warning) => warning.includes("legacy"))).toBe(true);
    }
  });
});

describe("cursor adapter: malformed and unknown input", () => {
  it("declines a structurally unrelated payload", async () => {
    const harness = harnessWithCursor();
    const outcome = await ingest(harness, unknownProviderPayload());
    expect(outcome.attribution).toBe("declined");
    expect(outcome.attributionReason).toBe("provider-unknown");
    expect(harness.sink.events()).toEqual([]);
  });

  it("declines a recognized-but-malformed payload rather than guessing", async () => {
    const harness = harnessWithCursor();
    const outcome = await ingest(harness, malformedPayload());
    expect(outcome.attribution).toBe("declined");
    expect(harness.sink.events()).toEqual([]);
  });
});

describe("cursor adapter: interleaved sessions and instance isolation", () => {
  it("keeps interleaved sessions on one hook fully isolated", async () => {
    const harness = harnessWithCursor();
    await ingest(harness, sessionStartPayload({ conversationId: CONVERSATION_A }));
    await ingest(harness, sessionStartPayload({ conversationId: CONVERSATION_B }));
    await ingest(harness, beforeSubmitPromptPayload({ conversationId: CONVERSATION_A }));
    await ingest(harness, beforeSubmitPromptPayload({ conversationId: CONVERSATION_B, generationId: "gen_b_0001" }));

    const events = harness.sink.events();
    const forA = events.filter((event) => event.sessionId === CONVERSATION_A);
    const forB = events.filter((event) => event.sessionId === CONVERSATION_B);

    expect(forA.map((event) => event.sequence)).toEqual([0, 1, 2]);
    expect(forB.map((event) => event.sequence)).toEqual([0, 1, 2]);
    expect(forA.every((event) => event.sessionId === CONVERSATION_A)).toBe(true);
    expect(forB.every((event) => event.sessionId === CONVERSATION_B)).toBe(true);
  });

  it("never leaks consumer attributes between two provider instances", async () => {
    const harnessX = harnessWithCursor();
    const harnessY = harnessWithCursor();

    const outcomeX = await harnessX.hook.ingest({
      payload: sessionStartPayload(),
      transport: "hook-stdin",
      consumerAttributes: { "consumer.tenant": "tenant-x" },
    });
    const outcomeY = await harnessY.hook.ingest({
      payload: sessionStartPayload(),
      transport: "hook-stdin",
      consumerAttributes: { "consumer.tenant": "tenant-y" },
    });

    expect(outcomeX.identity?.consumerAttributes["consumer.tenant"]).toBe("tenant-x");
    expect(outcomeY.identity?.consumerAttributes["consumer.tenant"]).toBe("tenant-y");
    expect(batchContains(harnessX.sink.events(), "tenant-y")).toBe(false);
    expect(batchContains(harnessY.sink.events(), "tenant-x")).toBe(false);
  });
});

describe("cursor adapter: privacy (zero leakage by default)", () => {
  it("never discloses prompt secrets", async () => {
    const harness = harnessWithCursor();
    await ingest(harness, secretBearingPromptPayload());
    expect(findDisclosureViolations(harness.sink.events())).toEqual([]);
    expect(batchContains(harness.sink.events(), "sk-abcdefghijklmnopqrstuvwx0123")).toBe(false);
  });

  it("never discloses secret-shaped tool input", async () => {
    const harness = harnessWithCursor();
    await ingest(harness, secretBearingToolInputPayload());
    expect(findDisclosureViolations(harness.sink.events())).toEqual([]);
    expect(batchContains(harness.sink.events(), "sk-live-1234567890abcdef")).toBe(false);
    expect(batchContains(harness.sink.events(), "abc123")).toBe(false);
  });
});

describe("cursor adapter: hook response / stdout protocol", () => {
  it("emits a provider-protocol continue response for decision hooks", async () => {
    const harness = harnessWithCursor();
    const outcome = await ingest(harness, beforeSubmitPromptPayload());
    expect(outcome.hookResponse.contract).toBe("provider-protocol");
    expect(outcome.hookResponse.stdout).toBe('{"continue":true}');
    expect(outcome.hookResponse.exitCode).toBe(0);
  });

  it("stays silent for notification-only hooks", async () => {
    const harness = harnessWithCursor();
    const outcome = await ingest(harness, afterAgentResponsePayload());
    expect(outcome.hookResponse.contract).toBe("silent");
    expect(outcome.hookResponse.stdout).toBeUndefined();
    expect(outcome.hookResponse.exitCode).toBe(0);
  });

  it("stays fail-open (exit code 0) even when attribution is declined", async () => {
    const harness = harnessWithCursor();
    const outcome = await ingest(harness, unknownProviderPayload());
    expect(outcome.hookResponse.exitCode).toBe(0);
  });
});

describe("cursor adapter: exporter and replay resilience", () => {
  it("stays fail-open when the telemetry sink rejects a batch", async () => {
    const harness = harnessWithCursor();
    harness.sink.failNext(1);
    const outcome = await ingest(harness, sessionStartPayload());

    expect(outcome.ok).toBe(true);
    expect(outcome.attribution).toBe("attributed");
    expect(outcome.emitted).toBe(0);
    expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain("telemetry-export-failure");
    expect(outcome.hookResponse.exitCode).toBe(0);
  });

  it("is replay-safe: identical payloads across independent hook instances derive identical ids", async () => {
    const harnessA = harnessWithCursor();
    const harnessB = harnessWithCursor();
    const payload = sessionStartPayload();

    const outcomeA = await ingest(harnessA, payload);
    const outcomeB = await ingest(harnessB, payload);

    expect(outcomeA.identity?.invocationId).toBe(outcomeB.identity?.invocationId);
    expect(harnessA.sink.events()[0]?.eventId).toBe(harnessB.sink.events()[0]?.eventId);
  });
});
