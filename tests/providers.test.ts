import { describe, expect, it } from "vitest";

import {
  BUILT_IN_PROVIDERS,
  createProviderRegistry,
  DEFAULT_CONFIG,
  describeAdapter,
  providerDetectionSchema,
  SILENT_HOOK_RESPONSE,
  type DetectionPolicy,
  type ProviderContext,
  type ProviderDetectionInput,
} from "../src/index.js";
import {
  createFixedClock,
  createFixtureAdapter,
  createRecordingLogger,
  createTestPrivacyService,
  createDeterministicIdGenerator,
} from "../src/testing/index.js";

const privacy = createTestPrivacyService();
const context: ProviderContext = {
  privacy,
  clock: createFixedClock(),
  ids: createDeterministicIdGenerator({ namespace: "test" }),
  logger: createRecordingLogger(),
  limits: privacy.policy.limits,
};

const policy = (overrides: Partial<DetectionPolicy> = {}): DetectionPolicy => ({
  ...DEFAULT_CONFIG.detection,
  ...overrides,
});

const input = (payload: unknown): ProviderDetectionInput => ({
  payload,
  transport: "test-fixture",
  environment: {},
});

const fixturePayload = { provider: "fixture", sessionId: "ses_1", event: "session.start" };

describe("provider registry", () => {
  it("ships no built-in adapters", () => {
    expect(BUILT_IN_PROVIDERS).toEqual([]);
  });

  it("selects the adapter that recognizes the payload", () => {
    const adapter = createFixtureAdapter();
    const registry = createProviderRegistry([adapter]);
    const result = registry.detect(input(fixturePayload), context, policy());

    expect(result.status).toBe("selected");
    if (result.status === "selected") {
      expect(result.adapter.id).toBe("fixture");
      expect(result.detection.confidence).toBe("exact");
      expect(result.detection.sourceEventName).toBe("session.start");
    }
  });

  it("stays unknown for an unrecognized payload", () => {
    const registry = createProviderRegistry([createFixtureAdapter()]);
    const result = registry.detect(input({ some: "other tool" }), context, policy());

    expect(result.status).toBe("unknown");
    if (result.status === "unknown") {
      expect(result.reason).toBe("no-candidates");
      expect(result.detection.providerId).toBe("unknown");
      expect(result.detection.confidence).toBe("none");
    }
  });

  it("stays unknown when no adapter is registered", () => {
    const result = createProviderRegistry([]).detect(input(fixturePayload), context, policy());
    expect(result.status).toBe("unknown");
    if (result.status === "unknown") {
      expect(result.reason).toBe("no-adapters-registered");
    }
  });

  it("reports ambiguity rather than picking a winner", () => {
    const first = createFixtureAdapter({ id: "twin-a" });
    const second = createFixtureAdapter({
      id: "twin-b",
      detect: () =>
        providerDetectionSchema.parse({
          providerId: "twin-b",
          confidence: "exact",
          reasons: ["claims everything"],
        }),
    });
    const registry = createProviderRegistry([first, second]);
    const result = registry.detect(
      input({ ...fixturePayload, provider: "twin-a" }),
      context,
      policy(),
    );

    expect(result.status).toBe("ambiguous");
    expect(result.detection.providerId).toBe("unknown");
    expect(result.candidates).toHaveLength(2);
  });

  it("prefers the higher-confidence adapter when confidences differ", () => {
    const weak = createFixtureAdapter({ id: "weak-one", confidence: "weak" });
    const exact = createFixtureAdapter({
      id: "exact-one",
      detect: () =>
        providerDetectionSchema.parse({
          providerId: "exact-one",
          confidence: "exact",
          reasons: ["exact match"],
        }),
    });
    const registry = createProviderRegistry([weak, exact]);
    const result = registry.detect(
      input({ ...fixturePayload, provider: "weak-one" }),
      context,
      policy(),
    );

    expect(result.status).toBe("selected");
    if (result.status === "selected") {
      expect(result.adapter.id).toBe("exact-one");
    }
  });

  it("falls back to unknown below the minimum confidence", () => {
    const adapter = createFixtureAdapter({ confidence: "weak" });
    const registry = createProviderRegistry([adapter]);
    const result = registry.detect(input(fixturePayload), context, policy());

    expect(result.status).toBe("unknown");
    if (result.status === "unknown") {
      expect(result.reason).toBe("below-minimum-confidence");
    }
  });

  it("honours a lowered minimum confidence", () => {
    const registry = createProviderRegistry([createFixtureAdapter({ confidence: "weak" })]);
    const result = registry.detect(
      input(fixturePayload),
      context,
      policy({ minimumConfidence: "weak" }),
    );
    expect(result.status).toBe("selected");
  });

  it("enforces the provider allow-list", () => {
    const registry = createProviderRegistry([createFixtureAdapter()]);
    const result = registry.detect(
      input(fixturePayload),
      context,
      policy({ allowedProviderIds: ["something-else"] }),
    );

    expect(result.status).toBe("unknown");
    if (result.status === "unknown") {
      expect(result.reason).toBe("provider-not-allowed");
    }
  });

  it("contains a throwing adapter and still considers its peers", () => {
    const broken = createFixtureAdapter({ id: "broken", throwOn: "detect" });
    const healthy = createFixtureAdapter({ id: "healthy" });
    const registry = createProviderRegistry([broken, healthy]);
    const result = registry.detect(
      input({ ...fixturePayload, provider: "healthy" }),
      context,
      policy(),
    );

    expect(result.status).toBe("selected");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.code).toBe("provider-adapter-failure");
    // The thrown message never reaches the diagnostic.
    expect(JSON.stringify(result.errors)).not.toContain("detect failure");
  });

  it("rejects an adapter that claims a provider id other than its own", () => {
    const impostor = createFixtureAdapter({
      id: "impostor",
      detect: () =>
        providerDetectionSchema.parse({
          providerId: "victim",
          confidence: "exact",
          reasons: ["claims another provider"],
        }),
    });
    const registry = createProviderRegistry([impostor]);
    const result = registry.detect(input(fixturePayload), context, policy());

    expect(result.status).toBe("unknown");
    expect(result.errors[0]?.code).toBe("provider-adapter-failure");
  });

  it("refuses duplicate adapter ids", () => {
    expect(() => createProviderRegistry([createFixtureAdapter(), createFixtureAdapter()])).toThrow(
      /duplicate provider adapter id/,
    );
  });

  it("exposes an immutable adapter list", () => {
    const registry = createProviderRegistry([createFixtureAdapter()]);
    expect(Object.isFrozen(registry.adapters)).toBe(true);
    expect(registry.get("fixture")?.id).toBe("fixture");
    expect(registry.get("nope")).toBeUndefined();
  });
});

describe("adapter contract surface", () => {
  it("declares capabilities describing what it can observe", () => {
    const adapter = createFixtureAdapter();
    expect(describeAdapter(adapter)).toEqual({
      id: "fixture",
      version: "1.0.0",
      lifecycleEvents: [
        "session.start",
        "session.end",
        "prompt.submitted",
        "generation.start",
        "generation.end",
        "tool.start",
        "tool.end",
        "subagent.start",
        "subagent.end",
        "compaction.performed",
      ],
      usageTemporality: "delta",
      deliveryIdentifier: "partial",
    });
  });

  it("defaults to a silent hook response that cannot fail the host", () => {
    const adapter = createFixtureAdapter();
    const response = adapter.hookResponse(
      { attribution: "attributed", emittedEvents: 1, errors: [] },
      context,
    );
    expect(response).toEqual(SILENT_HOOK_RESPONSE);
    expect(response.exitCode).toBe(0);
    expect(response.stdout).toBeUndefined();
  });

  it("supports a provider-specific stdout response when the protocol needs one", () => {
    const adapter = createFixtureAdapter({
      hookResponse: () => ({
        exitCode: 0,
        contract: "provider-protocol",
        stdout: JSON.stringify({ continue: true }),
      }),
    });
    const response = adapter.hookResponse(
      { attribution: "attributed", emittedEvents: 0, errors: [] },
      context,
    );
    expect(response.contract).toBe("provider-protocol");
    expect(response.stdout).toBe('{"continue":true}');
    expect(response.exitCode).toBe(0);
  });
});
