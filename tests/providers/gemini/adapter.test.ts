import { describe, expect, it } from "vitest";

import { SILENT_HOOK_RESPONSE, type ProviderContext, type ProviderDetectionInput } from "../../../src/index.js";
import {
  createGeminiCliAdapter,
  DEFAULT_GEMINI_CAPABILITIES,
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
    expect(adapter.capabilities.emitsSubagentEvents).toBe(false);
    expect(adapter.capabilities.reportsCacheCreation).toBe(false);
    expect(adapter.capabilities.cacheCreationAccounting).toBe("not-reported");
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

  it("ignores an intermediate AfterModel streaming chunk with no terminal usage", () => {
    const result = parseFixture("after-model-chunk");
    expect(result.status).toBe("ignored");
  });

  it("parses a terminal AfterModel into generation.end with mapped usage", () => {
    const result = parseFixture("after-model-final");
    expect(result.status).toBe("parsed");
    if (result.status === "parsed" && result.events[0]?.type === "generation.end") {
      const event = result.events[0];
      expect(event.outcome).toBe("ok");
      expect(event.stopReason).toBe("STOP");
      expect(event.usage).toMatchObject({
        inputTokens: 512,
        cachedInputTokens: 128,
        outputTokens: 136,
        reasoningOutputTokens: 40,
        providerTotalTokens: 648,
        providerTotalAgreement: "agrees",
        cacheCreationAccounting: "not-reported",
        cacheCreationInputTokens: 0,
      });
      expect(event.outputContent).toHaveLength(1);
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

  it("correlates BeforeTool/AfterTool ids across a host-side input replacement", () => {
    const before = parseFixture("before-tool-replaced");
    const after = parseFixture("after-tool-replaced");
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
