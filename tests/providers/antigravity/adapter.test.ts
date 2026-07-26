import { describe, expect, it } from "vitest";

import { describeAdapter, providerDetectionSchema, type ProviderContext } from "../../../src/providers/adapter.js";
import { createProviderRegistry } from "../../../src/providers/registry.js";
import {
  ANTIGRAVITY_CAPABILITIES,
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

describe("antigravity adapter: detection", () => {
  it("reports exact confidence for each documented hook shape", () => {
    const adapter = createAntigravityAdapter();
    const context = unitContext();
    for (const [file, eventName] of [
      ["pre-invocation-first.json", "PreInvocation"],
      ["post-invocation.json", "PostInvocation"],
      ["pre-tool-use.json", "PreToolUse"],
      ["post-tool-use.json", "PostToolUse"],
      ["stop-fully-idle.json", "Stop"],
    ] as const) {
      const detection = adapter.detect(detectionInput(loadAntigravityFixture(file)), context);
      expect(detection.confidence).toBe("exact");
      expect(detection.providerId).toBe("antigravity");
      expect(detection.sourceEventName).toBe(eventName);
    }
  });

  it("reports weak confidence for a recognizable but malformed payload", () => {
    const adapter = createAntigravityAdapter();
    const detection = adapter.detect(detectionInput(loadAntigravityFixture("malformed.json")), unitContext());
    expect(detection.confidence).toBe("weak");
    expect(detection.providerId).toBe("antigravity");
  });

  it("reports no confidence for an unrelated payload", () => {
    const adapter = createAntigravityAdapter();
    const detection = adapter.detect(detectionInput({ some: "other shape" }), unitContext());
    expect(detection.confidence).toBe("none");
    expect(detection.providerId).toBe("unknown");
  });

  it("reports no confidence for an undocumented hookEventName", () => {
    const adapter = createAntigravityAdapter();
    const detection = adapter.detect(
      detectionInput({ hookEventName: "PreCompact", conversationId: "conv_1" }),
      unitContext(),
    );
    expect(detection.confidence).toBe("none");
  });

  it("tolerates additive/unknown fields on an otherwise valid payload", () => {
    const adapter = createAntigravityAdapter();
    const detection = adapter.detect(
      detectionInput(loadAntigravityFixture("unknown-fields.json")),
      unitContext(),
    );
    expect(detection.confidence).toBe("exact");
  });
});

describe("antigravity adapter: capabilities and maturity", () => {
  it("declares only what the documented hooks can honestly support", () => {
    const adapter = createAntigravityAdapter();
    expect(describeAdapter(adapter)).toEqual({
      id: "antigravity",
      version: "0.1.0",
      lifecycleEvents: ["tool.start", "tool.end"],
      usageTemporality: "delta",
      deliveryIdentifier: "partial",
    });
    expect(ANTIGRAVITY_CAPABILITIES.reportsCachedInput).toBe(false);
    expect(ANTIGRAVITY_CAPABILITIES.reportsCacheCreation).toBe(false);
    expect(ANTIGRAVITY_CAPABILITIES.cacheCreationAccounting).toBe("not-reported");
    expect(ANTIGRAVITY_CAPABILITIES.reportsProviderTotal).toBe(false);
    expect(ANTIGRAVITY_CAPABILITIES.reportsCost).toBe(false);
    // invoke_subagent is an experimental tool relationship, not a subagent lifecycle.
    expect(ANTIGRAVITY_CAPABILITIES.emitsSubagentEvents).toBe(false);
    expect(ANTIGRAVITY_CAPABILITIES.requiresHookResponse).toBe(false);
  });

  it("declares itself experimental with documented promotion gates", () => {
    expect(ANTIGRAVITY_PROVIDER_MATURITY).toBe("experimental");
    expect(ANTIGRAVITY_PROMOTION_GATES.length).toBeGreaterThan(0);
  });

  it("always returns the silent hook response", () => {
    const adapter = createAntigravityAdapter();
    const response = adapter.hookResponse(
      { attribution: "attributed", emittedEvents: 1, errors: [] },
      unitContext(),
    );
    expect(response.contract).toBe("silent");
    expect(response.exitCode).toBe(0);
    expect(response.stdout).toBeUndefined();
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

describe("antigravity adapter: end-to-end lifecycle mapping", () => {
  it("ignores every PreInvocation without inventing a session-start fact", async () => {
    const harness = createTestHook({ adapters: [createAntigravityAdapter()] });
    const first = await harness.hook.ingest(detectionInput(loadAntigravityFixture("pre-invocation-first.json")));
    const subsequent = await harness.hook.ingest(
      detectionInput(loadAntigravityFixture("pre-invocation-subsequent.json")),
    );

    expect(first.attribution).toBe("not-applicable");
    expect(first.attributionReason).toBe("adapter-ignored-input");
    expect(subsequent.attribution).toBe("not-applicable");
    expect(subsequent.attributionReason).toBe("adapter-ignored-input");
    expect(harness.sink.events()).toEqual([]);
  });

  it("ignores post-invocation bookkeeping", async () => {
    const harness = createTestHook({ adapters: [createAntigravityAdapter()] });
    const post = await harness.hook.ingest(detectionInput(loadAntigravityFixture("post-invocation.json")));

    expect(post.attribution).toBe("not-applicable");
    expect(post.attributionReason).toBe("adapter-ignored-input");
    expect(harness.sink.events()).toEqual([]);
  });

  it("maps a correlated tool-call pair to tool.start/tool.end sharing one toolCallId", async () => {
    const harness = createTestHook({ adapters: [createAntigravityAdapter()] });
    await harness.hook.ingest(detectionInput(loadAntigravityFixture("pre-tool-use.json")));
    await harness.hook.ingest(detectionInput(loadAntigravityFixture("post-tool-use.json")));

    const events = harness.sink.events();
    expect(events.map((event) => event.type)).toEqual(["tool.start", "tool.end"]);
    const start = events[0];
    const end = events[1];
    if (start?.type !== "tool.start" || end?.type !== "tool.end") {
      throw new Error("expected a tool.start/tool.end pair");
    }
    expect(start.toolCallId).toBe(end.toolCallId);
    expect(start.toolName).toBe("read_file");
    expect(start.toolKind).toBe("unknown");
    expect(end.outcome).toBe("ok");
  });

  it("models invoke_subagent as a delegated tool call, not a subagent lifecycle", async () => {
    const harness = createTestHook({ adapters: [createAntigravityAdapter()] });
    await harness.hook.ingest(detectionInput(loadAntigravityFixture("pre-tool-use-subagent.json")));
    await harness.hook.ingest(detectionInput(loadAntigravityFixture("post-tool-use-subagent.json")));

    const events = harness.sink.events();
    expect(events.map((event) => event.type)).toEqual(["tool.start", "tool.end"]);
    const start = events[0];
    if (start?.type !== "tool.start") {
      throw new Error("expected tool.start");
    }
    expect(start.toolKind).toBe("delegate");
    expect(start.toolName).toBe("invoke_subagent");
  });

  it("reports a failed tool call outcome", async () => {
    const harness = createTestHook({ adapters: [createAntigravityAdapter()] });
    await harness.hook.ingest(detectionInput(loadAntigravityFixture("post-tool-use-error.json")));

    const event = harness.sink.events()[0];
    if (event?.type !== "tool.end") {
      throw new Error("expected tool.end");
    }
    expect(event.outcome).toBe("error");
  });

  it("ignores Stop regardless of fullyIdle, without inventing a session-end fact", async () => {
    const harness = createTestHook({ adapters: [createAntigravityAdapter()] });
    const idle = await harness.hook.ingest(detectionInput(loadAntigravityFixture("stop-fully-idle.json")));
    const notIdle = await harness.hook.ingest(detectionInput(loadAntigravityFixture("stop-not-idle.json")));

    expect(idle.attribution).toBe("not-applicable");
    expect(idle.attributionReason).toBe("adapter-ignored-input");
    expect(notIdle.attribution).toBe("not-applicable");
    expect(notIdle.attributionReason).toBe("adapter-ignored-input");
    expect(harness.sink.events()).toEqual([]);
  });

  it("ignores repeated fully-idle Stop events identically", async () => {
    const harness = createTestHook({ adapters: [createAntigravityAdapter()] });
    const first = await harness.hook.ingest(detectionInput(loadAntigravityFixture("stop-fully-idle.json")));
    const second = await harness.hook.ingest(detectionInput(loadAntigravityFixture("stop-fully-idle.json")));

    expect(first.attribution).toBe("not-applicable");
    expect(second.attribution).toBe("not-applicable");
    expect(harness.sink.events()).toEqual([]);
  });
});

describe("antigravity adapter: correlation without adapter-side state", () => {
  it("derives a stable toolCallId for an orphaned PostToolUse with no prior PreToolUse", async () => {
    const paired = createTestHook({ adapters: [createAntigravityAdapter()] });
    await paired.hook.ingest(detectionInput(loadAntigravityFixture("pre-tool-use.json")));
    await paired.hook.ingest(detectionInput(loadAntigravityFixture("post-tool-use.json")));
    const pairedEnd = paired.sink.events().find((event) => event.type === "tool.end");

    const orphan = createTestHook({ adapters: [createAntigravityAdapter()] });
    await orphan.hook.ingest(detectionInput(loadAntigravityFixture("post-tool-use.json")));
    const orphanOutcome = orphan.sink.events()[0];

    expect(orphanOutcome?.type).toBe("tool.end");
    if (orphanOutcome?.type !== "tool.end" || pairedEnd?.type !== "tool.end") {
      throw new Error("expected tool.end events");
    }
    // Correlation is a pure function of conversationId + stepIdx, so an orphan
    // process derives the identical id a paired process would have produced.
    expect(orphanOutcome.toolCallId).toBe(pairedEnd.toolCallId);
  });

  it("still correlates a pair whose toolName disagrees between Pre and Post (ambiguous input)", async () => {
    const harness = createTestHook({ adapters: [createAntigravityAdapter()] });
    const pre = loadAntigravityFixture("pre-tool-use.json") as Record<string, unknown>;
    const post = { ...(loadAntigravityFixture("post-tool-use.json") as Record<string, unknown>), toolName: "write_file" };

    await harness.hook.ingest(detectionInput(pre));
    await harness.hook.ingest(detectionInput(post));

    const [start, end] = harness.sink.events();
    if (start?.type !== "tool.start" || end?.type !== "tool.end") {
      throw new Error("expected a tool.start/tool.end pair");
    }
    // The adapter is stateless (ADR 0003): it cannot detect this disagreement
    // and correlates purely on conversationId + stepIdx, as documented.
    expect(start.toolCallId).toBe(end.toolCallId);
    expect(start.toolName).toBe("read_file");
    expect(end.toolName).toBe("write_file");
  });
});

describe("antigravity adapter: workspace identity", () => {
  it("derives the same opaque workspace id for the same workspacePaths", async () => {
    const harness = createTestHook({ adapters: [createAntigravityAdapter()] });
    const first = await harness.hook.ingest(
      detectionInput(loadAntigravityFixture("pre-tool-use.json")),
    );
    const second = await harness.hook.ingest(
      detectionInput({ ...(loadAntigravityFixture("stop-fully-idle.json") as Record<string, unknown>) }),
    );

    expect(first.identity?.workspace.workspaceId).toBe(second.identity?.workspace.workspaceId);
    expect(first.identity?.workspace.keySource).toBe("working-directory");
    expect(batchContains(harness.sink.events(), "/workspace/example-repo")).toBe(false);
  });
});

describe("antigravity adapter: privacy", () => {
  it("never discloses tool paths or filesystem hook metadata", async () => {
    const harness = createTestHook({ adapters: [createAntigravityAdapter()] });
    await harness.hook.ingest(detectionInput(loadAntigravityFixture("pre-tool-use.json")));

    expect(findDisclosureViolations(harness.sink.events())).toEqual([]);
    expect(batchContains(harness.sink.events(), "example.ts")).toBe(false);
    expect(batchContains(harness.sink.events(), "transcript.jsonl")).toBe(false);
    expect(batchContains(harness.sink.events(), "artifacts")).toBe(false);
  });

  it("keeps secret-shaped tool input and prompt-like text out of the batch", async () => {
    const harness = createTestHook({ adapters: [createAntigravityAdapter()] });
    await harness.hook.ingest(detectionInput(loadAntigravityFixture("secrets-tool-input.json")));

    expect(findDisclosureViolations(harness.sink.events())).toEqual([]);
    expect(batchContains(harness.sink.events(), "sk-live-1234567890abcdef")).toBe(false);
    expect(batchContains(harness.sink.events(), "abc123")).toBe(false);
    expect(batchContains(harness.sink.events(), "billing")).toBe(false);
    expect(batchContains(harness.sink.events(), "ignore all previous instructions")).toBe(false);
  });
});

describe("antigravity adapter: registry interoperation", () => {
  it("declines gracefully alongside another adapter without becoming ambiguous", () => {
    const antigravity = createAntigravityAdapter();
    const registry = createProviderRegistry([antigravity]);
    const context = unitContext();
    const result = registry.detect(detectionInput({ unrelated: "payload" }), context, {
      minimumConfidence: "strong",
      allowAmbiguousFallback: true,
      allowedProviderIds: [],
    });
    expect(result.status).toBe("unknown");
  });
});
