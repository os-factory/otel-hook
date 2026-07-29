import { describe, expect, it } from "vitest";

import { SILENT_HOOK_RESPONSE, type ProviderContext, type ProviderDetectionInput } from "../../../src/index.js";
import {
  createGeminiCliAdapter,
  DEFAULT_GEMINI_CAPABILITIES,
  GEMINI_HOOK_EVENT_NAMES,
  GEMINI_PROVIDER_ID,
} from "../../../src/providers/gemini/index.js";
import {
  createDeterministicIdGenerator,
  createFixedClock,
  createRecordingLogger,
  createTestIdentity,
  createTestPrivacyService,
} from "../../../src/testing/index.js";
import { loadGeminiFixture } from "./fixtures.js";

const privacy = createTestPrivacyService();
const context: ProviderContext = {
  privacy,
  clock: createFixedClock({ startMillis: 1_753_437_600_000 }),
  ids: createDeterministicIdGenerator({ namespace: "test" }),
  logger: createRecordingLogger(),
  limits: privacy.policy.limits,
};

const detectionInput = (payload: unknown): ProviderDetectionInput => ({
  payload,
  transport: "hook-stdin",
  environment: {},
});

describe("gemini-cli adapter: identity and capabilities", () => {
  it("declares the documented lifecycle events and usage semantics", () => {
    const adapter = createGeminiCliAdapter();
    expect(adapter.id).toBe(GEMINI_PROVIDER_ID);
    expect(adapter.capabilities).toEqual(DEFAULT_GEMINI_CAPABILITIES);
    expect(adapter.capabilities.lifecycleEvents).toEqual([
      "session.start",
      "session.end",
      "prompt.submitted",
      "generation.start",
      "generation.end",
      "tool.start",
      "tool.end",
      "compaction.performed",
    ]);
    // AfterModel fires per streaming chunk and each usageMetadata is a snapshot
    // of the response so far, so the counters compose by diffing, not by adding.
    expect(adapter.capabilities.usageTemporality).toBe("cumulative");
    // The CLI's hook translator rebuilds usageMetadata as exactly
    // { promptTokenCount, candidatesTokenCount, totalTokenCount }, dropping the
    // cache and thought counters before any hook runs.
    expect(adapter.capabilities.reportsCachedInput).toBe(false);
    expect(adapter.capabilities.reportsReasoningOutput).toBe(false);
    expect(adapter.capabilities.reportsProviderTotal).toBe(true);
    // No subagent hook events exist; delegation is visible only as the
    // `invoke_agent` tool's BeforeTool/AfterTool pair.
    expect(adapter.capabilities.emitsSubagentEvents).toBe(false);
    expect(adapter.capabilities.reportsCacheCreation).toBe(false);
    expect(adapter.capabilities.cacheCreationAccounting).toBe("not-reported");
  });

  it("recognizes every event name in the CLI's HookEventName enum, and no others", () => {
    // packages/core/src/hooks/types.ts at google-gemini/gemini-cli@3499c84.
    expect([...GEMINI_HOOK_EVENT_NAMES].sort()).toEqual(
      [
        "BeforeTool",
        "AfterTool",
        "BeforeAgent",
        "Notification",
        "AfterAgent",
        "SessionStart",
        "SessionEnd",
        "PreCompress",
        "BeforeModel",
        "AfterModel",
        "BeforeToolSelection",
      ].sort(),
    );
  });

  it("always returns the silent hook response", () => {
    const adapter = createGeminiCliAdapter();
    const response = adapter.hookResponse(
      { attribution: "attributed", emittedEvents: 3, errors: [] },
      context,
    );
    expect(response).toEqual(SILENT_HOOK_RESPONSE);
  });

  it("detects every documented hook event at exact confidence", () => {
    const adapter = createGeminiCliAdapter();
    const fixtures = [
      "session-start",
      "session-end",
      "before-agent",
      "after-agent",
      "before-model",
      "after-model-final",
      "before-tool-selection",
      "before-tool",
      "after-tool",
      "pre-compress",
      "notification",
    ];
    for (const name of fixtures) {
      const detection = adapter.detect(detectionInput(loadGeminiFixture(name)), context);
      expect(detection.confidence, `${name} should detect at exact confidence`).toBe("exact");
      expect(detection.providerId).toBe(GEMINI_PROVIDER_ID);
    }
  });

  it("stays unknown for a payload that does not look like this protocol", () => {
    const adapter = createGeminiCliAdapter();
    const detection = adapter.detect(detectionInput(loadGeminiFixture("malformed")), context);
    expect(detection.confidence).toBe("none");
    expect(detection.providerId).toBe("unknown");
  });

  it("reports weak confidence for a recognized event missing required fields", () => {
    const adapter = createGeminiCliAdapter();
    const detection = adapter.detect(detectionInput(loadGeminiFixture("malformed-known-event")), context);
    expect(detection.confidence).toBe("weak");
    expect(detection.providerId).toBe(GEMINI_PROVIDER_ID);
  });

  it("never throws from detect on arbitrary garbage", () => {
    const adapter = createGeminiCliAdapter();
    for (const payload of [null, undefined, 42, "a string", [], { hook_event_name: 5 }]) {
      expect(() => adapter.detect(detectionInput(payload), context)).not.toThrow();
    }
  });

  it("contributes matching sessionId claims across every hook event in one session", () => {
    const adapter = createGeminiCliAdapter();
    const names = ["session-start", "before-agent", "before-model", "before-tool"];
    const sessionIds = names.map((name) => {
      const payload = loadGeminiFixture(name);
      const detection = adapter.detect(detectionInput(payload), context);
      const claims = adapter.identify({ payload, transport: "hook-stdin", environment: {}, detection }, context);
      expect(claims).toHaveLength(1);
      return claims[0]?.fields.sessionId;
    });
    expect(new Set(sessionIds).size).toBe(1);
  });

  it("returns no claims when the payload cannot be parsed", () => {
    const adapter = createGeminiCliAdapter();
    const payload = loadGeminiFixture("malformed");
    const detection = adapter.detect(detectionInput(payload), context);
    const claims = adapter.identify({ payload, transport: "hook-stdin", environment: {}, detection }, context);
    expect(claims).toEqual([]);
  });
});

describe("gemini-cli adapter: parse per event", () => {
  const adapter = createGeminiCliAdapter();

  const parseFixture = (name: string) => {
    const payload = loadGeminiFixture(name);
    const detection = adapter.detect(detectionInput(payload), context);
    const claims = adapter.identify({ payload, transport: "hook-stdin", environment: {}, detection }, context);
    const claim = claims[0];
    const identity =
      claim?.fields.invocationId === undefined || claim.fields.sessionId === undefined
        ? createTestIdentity()
        : createTestIdentity({
            invocationId: claim.fields.invocationId,
            sessionId: claim.fields.sessionId,
            ...(claim.fields.startedAt === undefined ? {} : { startedAt: claim.fields.startedAt }),
            ...(claim.fields.workspace === undefined ? {} : { workspace: claim.fields.workspace }),
            provenance: {
              providerId: adapter.id,
              adapterId: adapter.id,
              adapterVersion: adapter.version,
              detectionConfidence: detection.confidence,
              transport: "hook-stdin",
            },
          });
    return adapter.parse({ payload, transport: "hook-stdin", environment: {}, detection, identity, sequenceBase: 0 }, context);
  };

  it("parses SessionStart into session.start", () => {
    const result = parseFixture("session-start");
    expect(result.status).toBe("parsed");
    if (result.status === "parsed") {
      expect(result.events).toHaveLength(1);
      expect(result.events[0]?.type).toBe("session.start");
    }
  });

  it("parses SessionEnd into session.end with a completed reason", () => {
    const result = parseFixture("session-end");
    expect(result.status).toBe("parsed");
    if (result.status === "parsed" && result.events[0]?.type === "session.end") {
      expect(result.events[0].reason).toBe("completed");
    }
  });

  it("parses BeforeAgent into prompt.submitted with content omitted by default", () => {
    const result = parseFixture("before-agent");
    expect(result.status).toBe("parsed");
    if (result.status === "parsed" && result.events[0]?.type === "prompt.submitted") {
      expect(result.events[0].promptSource).toBe("user");
      expect(result.events[0].content?.disclosure).toBe("omitted");
      expect(result.events[0].content?.text).toBeUndefined();
      expect(result.events[0].content?.characterLength).toBeGreaterThan(0);
    }
  });

  it("ignores AfterAgent: no canonical event models turn completion", () => {
    const result = parseFixture("after-agent");
    expect(result.status).toBe("ignored");
  });

  it("parses BeforeModel into generation.start with the requested model", () => {
    const result = parseFixture("before-model");
    expect(result.status).toBe("parsed");
    if (result.status === "parsed" && result.events[0]?.type === "generation.start") {
      expect(result.events[0].model.modelId).toBe("gemini-2.5-pro");
      expect(result.events[0].requestedMaxOutputTokens).toBe(8192);
      expect(result.events[0].inputContent).toHaveLength(1);
    }
  });

  it("ignores an AfterModel streaming chunk that carries no usageMetadata snapshot", () => {
    const result = parseFixture("after-model-chunk");
    expect(result.status).toBe("ignored");
  });

  it("reads the string parts the CLI's translator emits, not just the SDK's { text } form", () => {
    // toHookLLMResponse maps candidates to `parts: string[]`, so a fixture using
    // the object spelling would be testing a shape no hook ever receives.
    const payload = loadGeminiFixture("after-model-final") as {
      llm_response: { candidates: [{ content: { parts: unknown[] } }] };
    };
    expect(payload.llm_response.candidates[0]?.content.parts.every((part) => typeof part === "string")).toBe(
      true,
    );

    const result = parseFixture("after-model-final");
    if (result.status === "parsed" && result.events[0]?.type === "generation.end") {
      expect(result.events[0].outputContent).toHaveLength(1);
      expect(result.events[0].outputContent?.[0]?.characterLength).toBeGreaterThan(0);
    }
  });

  it("parses a closing AfterModel into generation.end with the usage snapshot it carries", () => {
    const result = parseFixture("after-model-final");
    expect(result.status).toBe("parsed");
    if (result.status === "parsed" && result.events[0]?.type === "generation.end") {
      const event = result.events[0];
      expect(event.outcome).toBe("ok");
      expect(event.stopReason).toBe("STOP");
      expect(event.usage).toMatchObject({
        temporality: "cumulative",
        inputTokens: 512,
        outputTokens: 136,
        providerTotalTokens: 648,
        providerTotalAgreement: "agrees",
        cacheCreationAccounting: "not-reported",
        cacheCreationInputTokens: 0,
      });
      // Not reported by this protocol, so normalization pins them to zero rather
      // than the adapter inventing a cache read or a reasoning bucket.
      expect(event.usage?.cachedInputTokens).toBe(0);
      expect(event.usage?.reasoningOutputTokens).toBe(0);
      expect(event.outputContent).toHaveLength(1);
    }
  });

  it("closes the same generation from an earlier usage-bearing chunk of one stream", () => {
    const chunk = parseFixture("after-model-chunk-usage");
    const final = parseFixture("after-model-final");
    expect(chunk.status).toBe("parsed");
    expect(final.status).toBe("parsed");
    if (
      chunk.status === "parsed" &&
      final.status === "parsed" &&
      chunk.events[0]?.type === "generation.end" &&
      final.events[0]?.type === "generation.end"
    ) {
      // Both chunks carry the same llm_request, which is what correlates them.
      expect(chunk.events[0].generationId).toBe(final.events[0].generationId);
      // The earlier chunk has no finishReason yet; only the closing one does.
      expect(chunk.events[0].stopReason).toBeUndefined();
      expect(chunk.events[0].outcome).toBe("unknown");
      // Each carries a snapshot of the whole response so far, not an increment.
      expect(chunk.events[0].usage?.inputTokens).toBe(512);
      expect(final.events[0].usage?.inputTokens).toBe(512);
    }
  });

  it("flags a provider total that disagrees with the canonical sum, keeping both numbers", () => {
    const result = parseFixture("after-model-total-disagrees");
    expect(result.status).toBe("parsed");
    if (result.status === "parsed" && result.events[0]?.type === "generation.end") {
      expect(result.events[0].usage?.providerTotalAgreement).toBe("disagrees");
      expect(result.events[0].usage?.providerTotalTokens).toBe(999);
      expect(result.events[0].usage?.totalTokens).toBe(220);
    }
  });

  it("ignores BeforeToolSelection: tool-choice configuration only", () => {
    expect(parseFixture("before-tool-selection").status).toBe("ignored");
  });

  it("parses BeforeTool into tool.start with a classified tool kind", () => {
    const result = parseFixture("before-tool");
    expect(result.status).toBe("parsed");
    if (result.status === "parsed" && result.events[0]?.type === "tool.start") {
      expect(result.events[0].toolName).toBe("read_file");
      expect(result.events[0].toolKind).toBe("read");
    }
  });

  it("parses AfterTool into tool.end with outcome ok", () => {
    const result = parseFixture("after-tool");
    expect(result.status).toBe("parsed");
    if (result.status === "parsed" && result.events[0]?.type === "tool.end") {
      expect(result.events[0].outcome).toBe("ok");
    }
  });

  it("parses an AfterTool carrying a tool_response.error as outcome error", () => {
    const result = parseFixture("after-tool-error");
    expect(result.status).toBe("parsed");
    if (result.status === "parsed" && result.events[0]?.type === "tool.end") {
      expect(result.events[0].outcome).toBe("error");
    }
  });

  it("correlates BeforeTool/AfterTool across a hook's tool_input rewrite", () => {
    // A BeforeTool hook's `hookSpecificOutput.tool_input` is merged into
    // `invocation.params` in place, so AfterTool echoes arguments BeforeTool
    // never saw. Keying on the input would split one call into two halves.
    const before = parseFixture("before-tool-input-rewritten");
    const after = parseFixture("after-tool-input-rewritten");
    expect(before.status).toBe("parsed");
    expect(after.status).toBe("parsed");
    if (
      before.status === "parsed" &&
      after.status === "parsed" &&
      before.events[0]?.type === "tool.start" &&
      after.events[0]?.type === "tool.end"
    ) {
      expect(after.events[0].toolCallId).toBe(before.events[0].toolCallId);
    }
  });

  it("keeps a tail tool call apart from the call it replaced, and paired with itself", () => {
    // `original_request_name` names the tool the model asked for; `tool_name`
    // names the tool the CLI substituted. Keying on the original alone would
    // hand two different tools one span.
    const original = parseFixture("before-tool-input-rewritten");
    const tailBefore = parseFixture("before-tool-tail-call");
    const tailAfter = parseFixture("after-tool-tail-call");
    expect(tailBefore.status).toBe("parsed");
    expect(tailAfter.status).toBe("parsed");
    if (
      original.status === "parsed" &&
      tailBefore.status === "parsed" &&
      tailAfter.status === "parsed" &&
      original.events[0]?.type === "tool.start" &&
      tailBefore.events[0]?.type === "tool.start" &&
      tailAfter.events[0]?.type === "tool.end"
    ) {
      expect(tailBefore.events[0].toolCallId).not.toBe(original.events[0].toolCallId);
      expect(tailAfter.events[0].toolCallId).toBe(tailBefore.events[0].toolCallId);
      // The provider's own names survive: the executing tool is reported, not
      // the one it stood in for.
      expect(tailBefore.events[0].toolName).toBe("run_shell_command");
      expect(tailBefore.events[0].toolKind).toBe("execute");
    }
  });

  it("classifies Gemini's subagent entry point as delegation", () => {
    const result = parseFixture("before-tool-invoke-agent");
    expect(result.status).toBe("parsed");
    if (result.status === "parsed" && result.events[0]?.type === "tool.start") {
      expect(result.events[0].toolName).toBe("invoke_agent");
      expect(result.events[0].toolKind).toBe("delegate");
    }
  });

  it("leaves an MCP tool unknown: its behaviour is defined by the connected server", () => {
    const result = parseFixture("before-tool-mcp");
    expect(result.status).toBe("parsed");
    if (result.status === "parsed" && result.events[0]?.type === "tool.start") {
      expect(result.events[0].toolName).toBe("mcp_issue_tracker_list_open_issues");
      expect(result.events[0].toolKind).toBe("unknown");
    }
  });

  it("parses PreCompress into compaction.performed", () => {
    const result = parseFixture("pre-compress");
    expect(result.status).toBe("parsed");
    if (result.status === "parsed" && result.events[0]?.type === "compaction.performed") {
      expect(result.events[0].trigger).toBe("automatic");
    }
  });

  it("ignores Notification: observability-only, no canonical event type", () => {
    expect(parseFixture("notification").status).toBe("ignored");
  });

  it("fails on a payload that does not match the protocol at all", () => {
    const result = parseFixture("malformed");
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe("invalid-input");
    }
  });
});
