import { describe, expect, it } from "vitest";

import { describeAdapter, providerDetectionSchema, type ProviderContext } from "../../../src/providers/adapter.js";
import { createProviderRegistry } from "../../../src/providers/registry.js";
import {
  ANTIGRAVITY_CAPABILITIES,
  ANTIGRAVITY_CONTRACT_EXCLUSIONS,
  ANTIGRAVITY_PROMOTION_GATES,
  ANTIGRAVITY_PROVIDER_MATURITY,
  createAntigravityAdapter,
} from "../../../src/providers/antigravity/index.js";
import {
  batchContains,
  createDeterministicIdGenerator,
  createFixedClock,
  createRecordingLogger,
  createTestHook,
  createTestIdentity,
  findDisclosureViolations,
} from "../../../src/testing/index.js";
import { loadAntigravityFixture } from "./fixtures.js";

const privacy = () => createTestHook().privacy;

const unitContext = (): ProviderContext => {
  const service = privacy();
  return {
    privacy: service,
    clock: createFixedClock(),
    ids: createDeterministicIdGenerator({ namespace: "test" }),
    logger: createRecordingLogger(),
    limits: service.policy.limits,
  };
};

const detectionInput = (payload: unknown) => ({
  payload,
  transport: "hook-stdin" as const,
  environment: {},
});

const toolEnd = async (file: string) => {
  const harness = createTestHook({ adapters: [createAntigravityAdapter()] });
  const outcome = await harness.hook.ingest(detectionInput(loadAntigravityFixture(file)));
  const event = harness.sink.events()[0];
  return { harness, outcome, event };
};

describe("antigravity adapter: detection", () => {
  it("reports exact confidence for each stdin shape the reference makes unique", () => {
    const adapter = createAntigravityAdapter();
    const context = unitContext();
    for (const [file, eventName] of [
      ["session-start.json", "SessionStart"],
      ["post-tool-use-error.json", "PostToolUse"],
      ["post-tool-use-empty-error.json", "PostToolUse"],
      ["stop-fully-idle.json", "Stop"],
    ] as const) {
      const detection = adapter.detect(detectionInput(loadAntigravityFixture(file)), context);
      expect(detection.confidence, file).toBe("exact");
      expect(detection.providerId, file).toBe("antigravity");
      expect(detection.sourceEventName, file).toBe(eventName);
    }
  });

  it("recognizes an unlabeled tool or invocation payload without naming an edge", () => {
    const adapter = createAntigravityAdapter();
    const context = unitContext();
    for (const file of ["pre-tool-use.json", "pre-invocation.json"]) {
      const detection = adapter.detect(detectionInput(loadAntigravityFixture(file)), context);
      expect(detection.confidence, file).toBe("exact");
      expect(detection.providerId, file).toBe("antigravity");
      expect(detection.sourceEventName, file).toBeUndefined();
    }
  });

  it("reports weak confidence for a recognizable but malformed payload", () => {
    const adapter = createAntigravityAdapter();
    const detection = adapter.detect(detectionInput(loadAntigravityFixture("malformed.json")), unitContext());
    expect(detection.confidence).toBe("weak");
    expect(detection.providerId).toBe("antigravity");
    expect(detection.sourceEventName).toBeUndefined();
  });

  it("reports no confidence for an unrelated payload", () => {
    const adapter = createAntigravityAdapter();
    const detection = adapter.detect(detectionInput({ some: "other shape" }), unitContext());
    expect(detection.confidence).toBe("none");
    expect(detection.providerId).toBe("unknown");
  });

  it("does not treat a bare hookEventName as Antigravity", () => {
    const adapter = createAntigravityAdapter();
    const detection = adapter.detect(
      detectionInput({ hookEventName: "PreToolUse", conversationId: "" }),
      unitContext(),
    );
    expect(detection.confidence).toBe("none");
  });

  it("tolerates additive fields on an otherwise valid SessionStart", () => {
    const adapter = createAntigravityAdapter();
    const detection = adapter.detect(
      detectionInput(loadAntigravityFixture("unknown-fields.json")),
      unitContext(),
    );
    expect(detection.confidence).toBe("exact");
    expect(detection.sourceEventName).toBe("SessionStart");
  });
});

describe("antigravity adapter: capabilities and maturity", () => {
  it("declares only the events stdin can distinguish", () => {
    const adapter = createAntigravityAdapter();
    expect(describeAdapter(adapter)).toEqual({
      id: "antigravity",
      version: "0.1.0",
      lifecycleEvents: ["session.start", "tool.end"],
      usageTemporality: "delta",
      deliveryIdentifier: "partial",
    });
    expect(ANTIGRAVITY_CAPABILITIES.reportsCachedInput).toBe(false);
    expect(ANTIGRAVITY_CAPABILITIES.reportsCacheCreation).toBe(false);
    expect(ANTIGRAVITY_CAPABILITIES.cacheCreationAccounting).toBe("not-reported");
    expect(ANTIGRAVITY_CAPABILITIES.reportsReasoningOutput).toBe(false);
    expect(ANTIGRAVITY_CAPABILITIES.reportsProviderTotal).toBe(false);
    expect(ANTIGRAVITY_CAPABILITIES.reportsCost).toBe(false);
    expect(ANTIGRAVITY_CAPABILITIES.emitsSubagentEvents).toBe(false);
    expect(ANTIGRAVITY_CAPABILITIES.emitsCompactionEvents).toBe(false);
    expect(ANTIGRAVITY_CAPABILITIES.requiresHookResponse).toBe(true);
  });

  it("stays experimental, with every open gate and every exclusion named", () => {
    expect(ANTIGRAVITY_PROVIDER_MATURITY).toBe("experimental");
    expect(ANTIGRAVITY_PROMOTION_GATES).toEqual([
      "replay a captured, redacted Antigravity transcript; the published hooks reference is not a capture, and this repository has none",
      "confirm a stdin discriminator separating PreToolUse from a PostToolUse that omits error, and PreInvocation from PostInvocation",
    ]);
    expect(ANTIGRAVITY_CONTRACT_EXCLUSIONS.map((entry) => entry.id)).toEqual([
      "no-usage",
      "no-session-end",
      "no-generation",
      "no-native-tool-call-id",
      "no-subagent-lifecycle",
      "no-unlabeled-tool-edge",
      "post-tool-error-is-a-string",
      "no-tool-output",
    ]);
  });

  it("answers each documented event with stdout that lets the host proceed", () => {
    const adapter = createAntigravityAdapter();
    const context = unitContext();
    const respond = (file: string) => {
      const payload = loadAntigravityFixture(file);
      const detection = adapter.detect(detectionInput(payload), context);
      return adapter.hookResponse(
        { attribution: "attributed", emittedEvents: 0, errors: [], detection },
        context,
      );
    };

    expect(respond("session-start.json")).toMatchObject({ exitCode: 0, contract: "provider-protocol", stdout: "{}" });
    expect(respond("post-tool-use-error.json").stdout).toBe("{}");
    expect(respond("pre-tool-use.json").stdout).toBe('{"decision":"allow"}');
    expect(respond("stop-fully-idle.json").stdout).toBe('{"decision":"allow"}');
    expect(respond("pre-invocation.json").stdout).toBe("{}");
    expect(respond("malformed.json").stdout).toBe('{"decision":"allow"}');
  });
});

describe("antigravity adapter: parse() unit behaviour", () => {
  it("fails closed on a payload that cannot pass the documented contract", () => {
    const adapter = createAntigravityAdapter();
    const result = adapter.parse(
      {
        ...detectionInput(loadAntigravityFixture("malformed.json")),
        detection: providerDetectionSchema.parse({
          providerId: "antigravity",
          confidence: "weak",
          reasons: ["forced for the unit test"],
        }),
        identity: createTestIdentity(),
        sequenceBase: 0,
      },
      unitContext(),
    );
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe("invalid-input");
    }
  });
});

describe("antigravity adapter: lifecycle mapping", () => {
  it("maps SessionStart to session.start and copies modelName only when present", async () => {
    const withModel = await toolEnd("session-start.json");
    expect(withModel.outcome.attribution).toBe("attributed");
    expect(withModel.event?.type).toBe("session.start");
    if (withModel.event?.type !== "session.start") {
      throw new Error("expected session.start");
    }
    expect(withModel.event.sessionKind).toBe("unknown");
    expect(withModel.event.model).toEqual({ modelId: "example-model" });
    expect(withModel.event.agentVersion).toBeUndefined();

    const withoutModel = await toolEnd("session-start-no-model.json");
    const event = withoutModel.event;
    if (event?.type !== "session.start") {
      throw new Error("expected session.start");
    }
    expect(event.model).toBeUndefined();
  });

  it("does not treat invocationNum 0 as a session or generation boundary", async () => {
    const harness = createTestHook({ adapters: [createAntigravityAdapter()] });
    const outcome = await harness.hook.ingest(detectionInput(loadAntigravityFixture("pre-invocation.json")));

    expect(outcome.attribution).toBe("not-applicable");
    expect(outcome.attributionReason).toBe("adapter-ignored-input");
    expect(harness.sink.events()).toEqual([]);
    expect(batchContains(harness.sink.events(), "example-model")).toBe(false);
  });

  it("ignores an unlabeled tool payload, including one that carries hookEventName", async () => {
    const harness = createTestHook({ adapters: [createAntigravityAdapter()] });
    for (const file of ["pre-tool-use.json", "pre-tool-use-labeled.json", "post-tool-use-is-error.json"]) {
      const outcome = await harness.hook.ingest(detectionInput(loadAntigravityFixture(file)));
      expect(outcome.attribution, file).toBe("not-applicable");
      expect(outcome.attributionReason, file).toBe("adapter-ignored-input");
    }
    expect(harness.sink.events()).toEqual([]);
  });

  it("maps PostToolUse with an error string to tool.end and nothing else", async () => {
    const failed = await toolEnd("post-tool-use-error.json");
    expect(failed.event?.type).toBe("tool.end");
    if (failed.event?.type !== "tool.end") {
      throw new Error("expected tool.end");
    }
    expect(failed.event.toolName).toBe("run_command");
    expect(failed.event.outcome).toBe("error");
    expect(failed.harness.sink.events()).toHaveLength(1);
    expect(batchContains(failed.harness.sink.events(), "exit status 1")).toBe(false);
    expect(batchContains(failed.harness.sink.events(), "npm test")).toBe(false);

    const succeeded = await toolEnd("post-tool-use-empty-error.json");
    if (succeeded.event?.type !== "tool.end") {
      throw new Error("expected tool.end");
    }
    expect(succeeded.event.outcome).toBe("ok");
  });

  it("records invoke_subagent as tool.end, not a subagent lifecycle", async () => {
    const { event, harness } = await toolEnd("post-tool-use-subagent.json");
    expect(event?.type).toBe("tool.end");
    if (event?.type !== "tool.end") {
      throw new Error("expected tool.end");
    }
    expect(event.toolName).toBe("invoke_subagent");
    expect(harness.sink.events().map((entry) => entry.type)).toEqual(["tool.end"]);
  });

  it("ignores a null toolCall instead of inventing a tool name", async () => {
    const harness = createTestHook({ adapters: [createAntigravityAdapter()] });
    const outcome = await harness.hook.ingest(
      detectionInput(loadAntigravityFixture("post-tool-use-null-tool.json")),
    );
    expect(outcome.attribution).toBe("not-applicable");
    expect(harness.sink.events()).toEqual([]);
  });

  it("ignores Stop regardless of fullyIdle, without inventing a session or generation end", async () => {
    const harness = createTestHook({ adapters: [createAntigravityAdapter()] });
    const idle = await harness.hook.ingest(detectionInput(loadAntigravityFixture("stop-fully-idle.json")));
    const notIdle = await harness.hook.ingest(detectionInput(loadAntigravityFixture("stop-not-idle.json")));

    expect(idle.attribution).toBe("not-applicable");
    expect(idle.attributionReason).toBe("adapter-ignored-input");
    expect(notIdle.attribution).toBe("not-applicable");
    expect(notIdle.attributionReason).toBe("adapter-ignored-input");
    expect(harness.sink.events()).toEqual([]);
  });
});

describe("antigravity adapter: correlation without adapter-side state", () => {
  it("derives the same toolCallId for the same conversationId and stepIdx", async () => {
    const first = await toolEnd("post-tool-use-error.json");
    const second = await toolEnd("post-tool-use-error.json");
    if (first.event?.type !== "tool.end" || second.event?.type !== "tool.end") {
      throw new Error("expected tool.end events");
    }
    expect(second.event.toolCallId).toBe(first.event.toolCallId);
  });

  it("does not correlate an unlabeled tool payload, because that edge is not emitted", async () => {
    const harness = createTestHook({ adapters: [createAntigravityAdapter()] });
    const pre = loadAntigravityFixture("pre-tool-use.json") as Record<string, unknown>;
    const post = loadAntigravityFixture("post-tool-use-error.json") as Record<string, unknown>;
    await harness.hook.ingest(detectionInput(pre));
    await harness.hook.ingest(detectionInput({ ...post, stepIdx: pre.stepIdx }));

    expect(harness.sink.events().map((event) => event.type)).toEqual(["tool.end"]);
  });
});

describe("antigravity adapter: workspace identity", () => {
  it("derives the same opaque workspace id for the same workspacePaths", async () => {
    const harness = createTestHook({ adapters: [createAntigravityAdapter()] });
    const first = await harness.hook.ingest(detectionInput(loadAntigravityFixture("session-start.json")));
    const second = await harness.hook.ingest(detectionInput(loadAntigravityFixture("stop-fully-idle.json")));

    expect(first.identity?.workspace.workspaceId).toBe(second.identity?.workspace.workspaceId);
    expect(first.identity?.workspace.keySource).toBe("working-directory");
    expect(batchContains(harness.sink.events(), "/workspace/example-repo")).toBe(false);
    expect(batchContains(harness.sink.events(), "transcript.jsonl")).toBe(false);
  });
});

describe("antigravity adapter: privacy", () => {
  it("keeps secret-shaped tool arguments and the error string out of the batch", async () => {
    const harness = createTestHook({ adapters: [createAntigravityAdapter()] });
    await harness.hook.ingest(detectionInput(loadAntigravityFixture("secrets-tool-input.json")));

    expect(findDisclosureViolations(harness.sink.events())).toEqual([]);
    expect(batchContains(harness.sink.events(), "sk-live-1234567890abcdef")).toBe(false);
    expect(batchContains(harness.sink.events(), "abc123")).toBe(false);
    expect(batchContains(harness.sink.events(), "billing")).toBe(false);
    expect(batchContains(harness.sink.events(), "ignore all previous instructions")).toBe(false);
    expect(batchContains(harness.sink.events(), "transcript.jsonl")).toBe(false);
    expect(harness.sink.events().map((event) => event.type)).toEqual(["tool.end"]);
  });
});

describe("antigravity adapter: registry interoperation", () => {
  it("declines an unrelated payload without becoming ambiguous", () => {
    const antigravity = createAntigravityAdapter();
    const registry = createProviderRegistry([antigravity]);
    const result = registry.detect(detectionInput({ unrelated: "payload" }), unitContext(), {
      minimumConfidence: "strong",
      allowAmbiguousFallback: true,
      allowedProviderIds: [],
    });
    expect(result.status).toBe("unknown");
  });
});
