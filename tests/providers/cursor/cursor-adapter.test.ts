import { describe, expect, it } from "vitest";

import {
  createCursorAdapter,
  CURSOR_CAPABILITIES,
  CURSOR_DECISION_EVENTS,
  CURSOR_HOOK_EVENT_NAMES,
  CURSOR_UNMODELLED_HOOK_EVENT_NAMES,
  recognizeCursorPayload,
} from "../../../src/providers/cursor/index.js";
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
  afterMcpExecutionPayload,
  afterShellExecutionPayload,
  beforeMcpExecutionPayload,
  beforeReadFilePayload,
  beforeShellExecutionPayload,
  beforeSubmitPromptPayload,
  CONVERSATION_A,
  CONVERSATION_B,
  GENERATION_A,
  malformedPayload,
  NEVER_EXPORTED_EMAIL,
  NEVER_EXPORTED_TRANSCRIPT_PATH,
  postToolUseFailurePayload,
  postToolUsePayload,
  preCompactPayload,
  preToolUsePayload,
  secretBearingPromptPayload,
  secretBearingToolInputPayload,
  sessionEndPayload,
  sessionlessPayload,
  sessionStartPayload,
  stopPayload,
  subagentStartPayload,
  subagentStopPayload,
  TOOL_CALL_A,
  unknownProviderPayload,
  workspaceOpenPayload,
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
      adapterVersion: "2.0.0",
      detectionConfidence: "exact",
      transport: "hook-stdin",
    },
    workspace: { workspaceId: "unknown:0000000000000000", keySource: "unknown" },
    startedAt: 1_753_400_000_000,
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
      lifecycleEvents: expect.arrayContaining(["session.start", "tool.start", "generation.end"]) as unknown,
    });
    // Cursor's cache_read_tokens is read as a subset of input_tokens; cache
    // *creation* accounting is undocumented, so it is not claimed.
    expect(CURSOR_CAPABILITIES.reportsCachedInput).toBe(true);
    expect(CURSOR_CAPABILITIES.reportsCacheCreation).toBe(false);
    expect(CURSOR_CAPABILITIES.cacheCreationAccounting).toBe("not-reported");
    expect(CURSOR_CAPABILITIES.reportsReasoningOutput).toBe(false);
    expect(CURSOR_CAPABILITIES.reportsProviderTotal).toBe(false);
    expect(CURSOR_CAPABILITIES.reportsCost).toBe(false);
    expect(CURSOR_CAPABILITIES.requiresHookResponse).toBe(true);
  });

  it("declares no subagent events, because subagentStop carries no id to pair with", () => {
    expect(CURSOR_CAPABILITIES.emitsSubagentEvents).toBe(false);
    expect(CURSOR_CAPABILITIES.lifecycleEvents).not.toContain("subagent.start");
    expect(CURSOR_CAPABILITIES.lifecycleEvents).not.toContain("subagent.end");
  });

  it("models Cursor's own event spellings, with no invented alias generation", () => {
    // The three tool events are the ones an earlier synthetic contract got wrong.
    expect(CURSOR_HOOK_EVENT_NAMES).toContain("preToolUse");
    expect(CURSOR_HOOK_EVENT_NAMES).toContain("postToolUse");
    expect(CURSOR_HOOK_EVENT_NAMES).toContain("postToolUseFailure");
    expect(CURSOR_HOOK_EVENT_NAMES as readonly string[]).not.toContain("beforeToolUse");
    expect(CURSOR_HOOK_EVENT_NAMES as readonly string[]).not.toContain("afterToolUse");
    expect(CURSOR_HOOK_EVENT_NAMES as readonly string[]).not.toContain("toolUseFailed");
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
    expect(event.agentName).toBe("cursor");
    expect(event.agentVersion).toBe("2026.07.17-synthetic");
    expect(event.model).toEqual({ modelId: "synthetic-composer-fast", family: "synthetic-composer" });
    expect(event.workspace.keySource).toBe("working-directory");
    expect(event.provenance.sourceEventName).toBe("sessionStart");
  });

  it("reports a background agent as a non-interactive session", async () => {
    const harness = harnessWithCursor();
    await ingest(harness, sessionStartPayload({ is_background_agent: true }));
    expect(eventOfType(harness.sink.events(), "session.start").sessionKind).toBe("non-interactive");
  });

  it("says unknown rather than guessing when is_background_agent is absent", async () => {
    const harness = harnessWithCursor();
    await ingest(harness, sessionStartPayload({ is_background_agent: undefined }));
    expect(eventOfType(harness.sink.events(), "session.start").sessionKind).toBe("unknown");
  });

  it("derives a stable workspace identity for multiple workspace roots", async () => {
    const harness = harnessWithCursor();
    const outcome = await ingest(
      harness,
      sessionStartPayload({ workspace_roots: WORKSPACE_ROOT_MULTI }),
    );
    expect(outcome.identity?.workspace.keySource).toBe("explicit");
  });

  it("treats the captured empty cwd as absent, not as the filesystem root", async () => {
    const harness = harnessWithCursor();
    const outcome = await ingest(
      harness,
      preToolUsePayload({ workspace_roots: undefined, cwd: "" }),
    );
    expect(outcome.identity?.workspace.keySource).toBe("unknown");
  });

  it("falls back to cwd when no workspace root is reported", async () => {
    const harness = harnessWithCursor();
    const outcome = await ingest(
      harness,
      beforeShellExecutionPayload({ workspace_roots: undefined }),
    );
    expect(outcome.identity?.workspace.keySource).toBe("working-directory");
  });

  it("maps sessionEnd to session.end, in milliseconds", async () => {
    const harness = harnessWithCursor();
    await ingest(harness, sessionEndPayload());
    const event = eventOfType(harness.sink.events(), "session.end");
    expect(event.reason).toBe("completed");
    expect(event.durationMillis).toBe(60_000);
    expect(event.extensions["cursor.final_status"]).toBe("completed");
  });

  it("maps Cursor's window_close and user_close reasons onto aborted", async () => {
    for (const reason of ["window_close", "user_close"]) {
      const harness = harnessWithCursor();
      await ingest(harness, sessionEndPayload({ reason }));
      expect(eventOfType(harness.sink.events(), "session.end").reason).toBe("aborted");
    }
  });

  it("degrades an unrecognized sessionEnd reason to unknown rather than rejecting the event", async () => {
    const harness = harnessWithCursor();
    const outcome = await ingest(harness, sessionEndPayload({ reason: "some-future-reason" }));
    expect(outcome.attribution).toBe("attributed");
    expect(eventOfType(harness.sink.events(), "session.end").reason).toBe("unknown");
  });

  it("maps beforeSubmitPrompt to prompt.submitted and generation.start", async () => {
    const harness = harnessWithCursor();
    await ingest(harness, beforeSubmitPromptPayload());
    const events = harness.sink.events();

    const prompt = eventOfType(events, "prompt.submitted");
    // Cursor reports no prompt provenance, so "user" would be a guess.
    expect(prompt.promptSource).toBe("unknown");
    expect(prompt.content?.disclosure).toBe("omitted");
    expect(prompt.content?.text).toBeUndefined();
    expect(prompt.content?.characterLength).toBeGreaterThan(0);
    expect(prompt.extensions["cursor.attachment_count"]).toBe(1);

    const generationStart = eventOfType(events, "generation.start");
    expect(generationStart.generationId).toBe(GENERATION_A);
    expect(generationStart.model).toEqual({
      modelId: "synthetic-composer-fast",
      family: "synthetic-composer",
    });
  });

  it("emits a prompt without a generation, and warns, when generation_id is absent", () => {
    const adapter = createCursorAdapter();
    const result = adapter.parse(
      manualParseInput(beforeSubmitPromptPayload({ generation_id: undefined })),
      manualContext(),
    );
    expect(result.status).toBe("parsed");
    if (result.status === "parsed") {
      expect(result.events.map((event) => event.type)).toEqual(["prompt.submitted"]);
      expect(result.warnings?.some((warning) => warning.includes("generation_id"))).toBe(true);
    }
  });

  it("maps preToolUse/postToolUse to a matching tool.start/tool.end pair", async () => {
    const harness = harnessWithCursor();
    await ingest(harness, preToolUsePayload());
    await ingest(harness, postToolUsePayload());
    const events = harness.sink.events();

    const start = eventOfType(events, "tool.start");
    const end = eventOfType(events, "tool.end");
    expect(start.toolCallId).toBe(TOOL_CALL_A);
    expect(end.toolCallId).toBe(TOOL_CALL_A);
    expect(start.toolName).toBe("Grep");
    // Cursor names its tools but does not classify them.
    expect(start.toolKind).toBe("unknown");
    expect(start.generationId).toBe(GENERATION_A);
    // postToolUse is the success path; failures go to postToolUseFailure.
    expect(end.outcome).toBe("ok");
    // `duration` is milliseconds, kept verbatim rather than scaled.
    expect(end.durationMillis).toBe(12.98);
  });

  it("pairs a tool call with no tool_use_id by deriving the same id on both edges", async () => {
    const harness = harnessWithCursor();
    await ingest(harness, preToolUsePayload({ tool_use_id: undefined }));
    await ingest(harness, postToolUsePayload({ tool_use_id: undefined }));
    const events = harness.sink.events();
    expect(eventOfType(events, "tool.start").toolCallId).toBe(
      eventOfType(events, "tool.end").toolCallId,
    );
  });

  it("maps postToolUseFailure onto the failure_type Cursor reported", async () => {
    const cases = [
      { failure_type: "error", outcome: "error" },
      { failure_type: "timeout", outcome: "timeout" },
      { failure_type: "permission_denied", outcome: "denied" },
    ] as const;
    for (const { failure_type, outcome } of cases) {
      const harness = harnessWithCursor();
      await ingest(harness, postToolUseFailurePayload({ failure_type }));
      const end = eventOfType(harness.sink.events(), "tool.end");
      expect(end.outcome).toBe(outcome);
      expect(end.output?.disclosure).toBe("omitted");
      expect(end.permissionDecision).toBe(
        failure_type === "permission_denied" ? "denied" : undefined,
      );
    }
  });

  it("reports an interrupt as cancelled rather than as an error", async () => {
    const harness = harnessWithCursor();
    await ingest(
      harness,
      postToolUseFailurePayload({ failure_type: undefined, is_interrupt: true }),
    );
    expect(eventOfType(harness.sink.events(), "tool.end").outcome).toBe("cancelled");
  });

  it("maps the dedicated shell pair, reporting unknown because Cursor sends no exit status", async () => {
    const harness = harnessWithCursor();
    await ingest(harness, beforeShellExecutionPayload());
    await ingest(harness, afterShellExecutionPayload());
    const events = harness.sink.events();

    const start = eventOfType(events, "tool.start");
    const end = eventOfType(events, "tool.end");
    expect(start.toolName).toBe("shell");
    expect(start.toolKind).toBe("execute");
    expect(start.toolCallId).toBe(end.toolCallId);
    expect(end.outcome).toBe("unknown");
    expect(end.durationMillis).toBe(169.812);
    expect(end.extensions["cursor.sandbox"]).toBe(false);
    expect(batchContains(events, "echo synthetic-build-step")).toBe(false);
  });

  it("maps the dedicated MCP pair the same way, and keeps Cursor's encoded tool name", async () => {
    const harness = harnessWithCursor();
    await ingest(harness, beforeMcpExecutionPayload());
    await ingest(harness, afterMcpExecutionPayload());
    const events = harness.sink.events();

    const start = eventOfType(events, "tool.start");
    const end = eventOfType(events, "tool.end");
    expect(start.toolName).toBe("mcp__synthetic-server__lookup");
    expect(start.toolKind).toBe("network");
    expect(start.toolCallId).toBe(end.toolCallId);
    expect(end.outcome).toBe("unknown");
    expect(end.durationMillis).toBe(84.5);
  });

  it("maps preCompact to compaction.performed without inventing an after-total", async () => {
    const harness = harnessWithCursor();
    await ingest(harness, preCompactPayload());
    const event = eventOfType(harness.sink.events(), "compaction.performed");
    expect(event.trigger).toBe("automatic");
    expect(event.contextTokensBefore).toBe(128_000);
    // Cursor exposes no post-compaction callback, so this is structurally
    // unavailable and is never estimated.
    expect(event.contextTokensAfter).toBeUndefined();
    expect(event.droppedMessageCount).toBe(40);
    expect(event.extensions["cursor.context_window_size"]).toBe(160_000);
    expect(event.extensions["cursor.is_first_compaction"]).toBe(true);
  });

  it("maps afterFileEdit to a self-contained tool.start/tool.end pair, without the diff", async () => {
    const harness = harnessWithCursor();
    await ingest(harness, afterFileEditPayload());
    const events = harness.sink.events();
    const start = eventOfType(events, "tool.start");
    const end = eventOfType(events, "tool.end");
    expect(start.toolCallId).toBe(end.toolCallId);
    expect(start.toolKind).toBe("write");
    expect(end.outcome).toBe("ok");
    expect(end.extensions["cursor.edit_count"]).toBe(1);
    expect(batchContains(events, "/workspace/synthetic-repo-a/src/billing.ts")).toBe(false);
    expect(batchContains(events, "export const rate")).toBe(false);
  });
});

describe("cursor adapter: generation.end comes from stop", () => {
  it("maps stop to generation.end with its status, usage, and loop count", async () => {
    const harness = harnessWithCursor();
    const outcome = await ingest(harness, stopPayload());

    expect(outcome.attribution).toBe("attributed");
    const event = eventOfType(harness.sink.events(), "generation.end");
    expect(event.generationId).toBe(GENERATION_A);
    expect(event.outcome).toBe("ok");
    expect(event.stopReason).toBe("completed");
    expect(event.extensions["cursor.loop_count"]).toBe(1);
    expect(event.usage).toMatchObject({
      temporality: "delta",
      inputTokens: 43_859,
      cachedInputTokens: 28_384,
      uncachedInputTokens: 15_475,
      outputTokens: 1_076,
      cacheCreationInputTokens: 0,
      cacheCreationAccounting: "not-reported",
      providerTotalAgreement: "unreported",
    });
  });

  it("drops a non-zero cache_write_tokens with a warning rather than guessing its accounting", () => {
    const adapter = createCursorAdapter();
    const result = adapter.parse(
      manualParseInput(stopPayload({ cache_write_tokens: 4_096 })),
      manualContext(),
    );
    expect(result.status).toBe("parsed");
    if (result.status !== "parsed") {
      return;
    }
    const [event] = result.events;
    expect(event?.type === "generation.end" ? event.usage?.cacheCreationInputTokens : undefined).toBe(0);
    expect(event?.type === "generation.end" ? event.usage?.cacheCreationAccounting : undefined).toBe(
      "not-reported",
    );
    expect(result.warnings?.some((warning) => warning.includes("cache_write_tokens"))).toBe(true);
  });

  it("maps an aborted and an errored stop onto distinct outcomes", async () => {
    for (const [status, outcome] of [
      ["aborted", "cancelled"],
      ["error", "error"],
    ] as const) {
      const harness = harnessWithCursor();
      await ingest(harness, stopPayload({ status }));
      expect(eventOfType(harness.sink.events(), "generation.end").outcome).toBe(outcome);
    }
  });

  it("ignores afterAgentResponse rather than double-counting the same generation", async () => {
    const harness = harnessWithCursor();
    const responseOutcome = await ingest(harness, afterAgentResponsePayload());
    await ingest(harness, stopPayload());

    expect(responseOutcome.attribution).toBe("not-applicable");
    expect(responseOutcome.attributionReason).toBe("adapter-ignored-input");
    const generationEnds = harness.sink.events().filter((event) => event.type === "generation.end");
    expect(generationEnds).toHaveLength(1);
    expect(batchContains(harness.sink.events(), "I refactored the synthetic billing module.")).toBe(
      false,
    );
  });

  it("ignores a stop with no generation_id rather than minting one", async () => {
    const harness = harnessWithCursor();
    const outcome = await ingest(harness, stopPayload({ generation_id: undefined }));
    expect(outcome.attribution).toBe("not-applicable");
    expect(outcome.attributionReason).toBe("adapter-ignored-input");
    expect(harness.sink.events()).toEqual([]);
  });

  it("never defaults an absent model to a Claude model", async () => {
    const harness = harnessWithCursor();
    await ingest(harness, stopPayload({ model: undefined, model_id: undefined }));
    const event = eventOfType(harness.sink.events(), "generation.end");
    expect(event.model).toEqual({ modelId: "unknown" });
    expect(JSON.stringify(event.model).toLowerCase()).not.toContain("claude");
    expect(JSON.stringify(event.model).toLowerCase()).not.toContain("anthropic");
  });

  it("drops the cache breakdown, with a warning, when it contradicts the inclusive reading", () => {
    const adapter = createCursorAdapter();
    const result = adapter.parse(
      manualParseInput(stopPayload({ input_tokens: 100, cache_read_tokens: 900 })),
      manualContext(),
    );
    expect(result.status).toBe("parsed");
    if (result.status !== "parsed") {
      return;
    }
    const [event] = result.events;
    expect(event?.type).toBe("generation.end");
    if (event?.type !== "generation.end") {
      return;
    }
    expect(event.usage?.inputTokens).toBe(100);
    expect(event.usage?.cachedInputTokens).toBe(0);
    expect(result.warnings?.some((warning) => warning.includes("cache_read_tokens"))).toBe(true);
  });

  it("emits no usage at all when Cursor reported no counters", async () => {
    const harness = harnessWithCursor();
    await ingest(
      harness,
      stopPayload({
        input_tokens: undefined,
        output_tokens: undefined,
        cache_read_tokens: undefined,
        cache_write_tokens: undefined,
      }),
    );
    expect(eventOfType(harness.sink.events(), "generation.end").usage).toBeUndefined();
  });
});

describe("cursor adapter: events recognized but deliberately not mapped", () => {
  const ignoredCases = [
    { name: "afterAgentThought", payload: afterAgentThoughtPayload() },
    { name: "beforeReadFile", payload: beforeReadFilePayload() },
    { name: "subagentStart", payload: subagentStartPayload() },
    { name: "subagentStop", payload: subagentStopPayload() },
  ];

  for (const { name, payload } of ignoredCases) {
    it(`recognizes ${name} and ignores it rather than fabricating a lifecycle`, async () => {
      const harness = harnessWithCursor();
      const outcome = await ingest(harness, payload);
      expect(outcome.attribution).toBe("not-applicable");
      expect(outcome.attributionReason).toBe("adapter-ignored-input");
      expect(harness.sink.events()).toEqual([]);
      // Ignoring is not failing: the hook still answers 0.
      expect(outcome.hookResponse.exitCode).toBe(0);
    });
  }

  it("never exports the thought text or the file content it declined to map", async () => {
    const harness = harnessWithCursor();
    await ingest(harness, afterAgentThoughtPayload());
    await ingest(harness, beforeReadFilePayload());
    expect(batchContains(harness.sink.events(), "billing module tests")).toBe(false);
    expect(batchContains(harness.sink.events(), "export const rate")).toBe(false);
  });

  it("ignores a documented Cursor event outside the agent session, naming it", async () => {
    const harness = harnessWithCursor();
    const outcome = await ingest(harness, workspaceOpenPayload());
    // No conversation to attribute it to, so it is declined at detection.
    expect(outcome.attribution).toBe("declined");
    expect(harness.sink.events()).toEqual([]);

    const detection = createCursorAdapter().detect(
      { payload: workspaceOpenPayload(), transport: "hook-stdin", environment: {} },
      manualContext(),
    );
    expect(detection.reasons.join(" ")).toContain("workspaceOpen");
    expect(Object.keys(CURSOR_UNMODELLED_HOOK_EVENT_NAMES)).toContain("workspaceOpen");
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

  it("distinguishes malformed from foreign, so a schema slip is not read as another provider", () => {
    expect(recognizeCursorPayload(unknownProviderPayload())).toBeUndefined();
    expect(recognizeCursorPayload(malformedPayload())).toMatchObject({
      status: "invalid",
      eventName: "preToolUse",
    });
    expect(recognizeCursorPayload(workspaceOpenPayload())).toMatchObject({
      status: "unmodelled",
      eventName: "workspaceOpen",
    });
    expect(recognizeCursorPayload(sessionStartPayload())).toMatchObject({ status: "modelled" });
  });

  it("declines a payload with no conversation to attribute it to", async () => {
    const harness = harnessWithCursor();
    const outcome = await ingest(harness, sessionlessPayload());
    expect(outcome.attribution).toBe("declined");
    expect(harness.sink.events()).toEqual([]);
  });

  it("tolerates a payload that gained an undocumented field", async () => {
    const harness = harnessWithCursor();
    const outcome = await ingest(
      harness,
      sessionStartPayload({ some_field_cursor_added_later: { nested: true } }),
    );
    expect(outcome.attribution).toBe("attributed");
    expect(eventOfType(harness.sink.events(), "session.start").sessionKind).toBe("interactive");
  });

  it("accepts every non-string type Cursor uses for tool_output", async () => {
    for (const toolOutput of ["{\"ok\":true}", { output: "done\n", exitCode: 0 }, 42, null]) {
      const harness = harnessWithCursor();
      const outcome = await ingest(harness, postToolUsePayload({ tool_output: toolOutput }));
      expect(outcome.attribution).toBe("attributed");
    }
  });

  it("declines every modelled event whose payload lost a required field", () => {
    const required: Readonly<Record<string, unknown>> = {
      preToolUse: preToolUsePayload({ tool_name: undefined }),
      postToolUse: postToolUsePayload({ tool_name: undefined }),
      postToolUseFailure: postToolUseFailurePayload({ tool_name: undefined }),
      beforeShellExecution: beforeShellExecutionPayload({ command: undefined }),
      afterShellExecution: afterShellExecutionPayload({ command: undefined }),
      beforeMCPExecution: beforeMcpExecutionPayload({ tool_name: undefined }),
      afterMCPExecution: afterMcpExecutionPayload({ tool_name: undefined }),
      beforeReadFile: beforeReadFilePayload({ file_path: undefined }),
      afterFileEdit: afterFileEditPayload({ file_path: undefined }),
    };
    for (const [eventName, payload] of Object.entries(required)) {
      expect(recognizeCursorPayload(payload), eventName).toMatchObject({ status: "invalid" });
    }
  });
});

describe("cursor adapter: interleaved sessions and instance isolation", () => {
  it("keeps interleaved sessions on one hook fully isolated", async () => {
    const harness = harnessWithCursor();
    await ingest(harness, sessionStartPayload({ conversation_id: CONVERSATION_A }));
    await ingest(harness, sessionStartPayload({ conversation_id: CONVERSATION_B }));
    await ingest(harness, beforeSubmitPromptPayload({ conversation_id: CONVERSATION_A }));
    await ingest(
      harness,
      beforeSubmitPromptPayload({ conversation_id: CONVERSATION_B, generation_id: "gen-b-0001" }),
    );

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

  /**
   * Cursor puts the signed-in account address and a real transcript path on
   * *every* agent hook. The schema accepts both so they parse rather than being
   * silently stripped, and no code path reads either.
   */
  it("never propagates the account email or the transcript path from any event", async () => {
    const harness = harnessWithCursor();
    for (const payload of [
      sessionStartPayload(),
      beforeSubmitPromptPayload(),
      preToolUsePayload(),
      postToolUsePayload(),
      postToolUseFailurePayload(),
      beforeShellExecutionPayload(),
      afterShellExecutionPayload(),
      beforeMcpExecutionPayload(),
      afterMcpExecutionPayload(),
      afterFileEditPayload(),
      preCompactPayload(),
      stopPayload(),
      sessionEndPayload(),
    ]) {
      await ingest(harness, payload);
    }

    const events = harness.sink.events();
    expect(events.length).toBeGreaterThan(0);
    expect(findDisclosureViolations(events)).toEqual([]);
    expect(batchContains(events, NEVER_EXPORTED_EMAIL)).toBe(false);
    expect(batchContains(events, "cursor-fixture-account")).toBe(false);
    expect(batchContains(events, NEVER_EXPORTED_TRANSCRIPT_PATH)).toBe(false);
    expect(batchContains(events, "agent-transcripts")).toBe(false);
  });
});

describe("cursor adapter: hook response / stdout protocol", () => {
  it("answers beforeSubmitPrompt with continue, the only event keyed that way", async () => {
    const harness = harnessWithCursor();
    const outcome = await ingest(harness, beforeSubmitPromptPayload());
    expect(outcome.hookResponse.contract).toBe("provider-protocol");
    expect(outcome.hookResponse.stdout).toBe('{"continue":true}');
    expect(outcome.hookResponse.exitCode).toBe(0);
  });

  it("answers the permission-gated events with permission: allow", async () => {
    for (const payload of [
      preToolUsePayload(),
      beforeShellExecutionPayload(),
      beforeMcpExecutionPayload(),
      beforeReadFilePayload(),
      subagentStartPayload(),
    ]) {
      const harness = harnessWithCursor();
      const outcome = await ingest(harness, payload);
      expect(outcome.hookResponse.contract).toBe("provider-protocol");
      expect(outcome.hookResponse.stdout).toBe('{"permission":"allow"}');
      expect(outcome.hookResponse.exitCode).toBe(0);
    }
  });

  it("never writes deny or ask: a telemetry hook must not gate the host agent", () => {
    const adapter = createCursorAdapter();
    for (const sourceEventName of Object.keys(CURSOR_DECISION_EVENTS)) {
      const response = adapter.hookResponse(
        {
          attribution: "declined",
          detection: providerDetectionSchema.parse({
            providerId: "cursor",
            confidence: "exact",
            reasons: ["test"],
            sourceEventName,
          }),
          emittedEvents: 0,
          errors: [],
        },
        manualContext(),
      );
      expect(response.exitCode).toBe(0);
      expect(response.stdout).not.toContain("deny");
      expect(response.stdout).not.toContain("ask");
    }
  });

  it("stays silent for notification-only hooks", async () => {
    const harness = harnessWithCursor();
    const outcome = await ingest(harness, stopPayload());
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
