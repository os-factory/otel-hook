import { describe, expect, it } from "vitest";

import {
  CANONICAL_EVENT_TYPES,
  CANONICAL_SCHEMA_VERSION,
  canonicalEventSchema,
  compareEvents,
  contentFactSchema,
  eventUsage,
  extensionsSchema,
  isContentFactConsistent,
  isValidExtensionKey,
  normalizeUsageOrThrow,
  parseCanonicalEvent,
  validateCanonicalEvent,
  type CanonicalEvent,
} from "../src/index.js";
import { createTestIdentity, createTestPrivacyService } from "../src/testing/index.js";

const identity = createTestIdentity();

const baseFields = {
  schemaVersion: CANONICAL_SCHEMA_VERSION,
  eventId: "evt_0000000000000001",
  invocationId: identity.invocationId,
  sessionId: identity.sessionId,
  sequence: 0,
  occurredAt: 1_700_000_000_000,
  provenance: identity.provenance,
  workspace: identity.workspace,
};

describe("canonical event model", () => {
  it("covers every lifecycle stage the contract promises", () => {
    expect([...CANONICAL_EVENT_TYPES]).toEqual([
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
      "error.raised",
    ]);
  });

  it("parses one event per lifecycle type", () => {
    const drafts: Record<string, Record<string, unknown>> = {
      "session.start": { sessionKind: "interactive" },
      "session.end": { reason: "completed" },
      "prompt.submitted": { promptSource: "user" },
      "generation.start": { generationId: "gen-1", model: { modelId: "m-1" } },
      "generation.end": { generationId: "gen-1", model: { modelId: "m-1" }, outcome: "ok" },
      "tool.start": { toolCallId: "call-1", toolName: "read", toolKind: "read" },
      "tool.end": { toolCallId: "call-1", toolName: "read", outcome: "ok" },
      "subagent.start": { subagentInvocationId: identity.invocationId, delegationDepth: 1 },
      "subagent.end": { subagentInvocationId: identity.invocationId, outcome: "ok" },
      "compaction.performed": { trigger: "automatic" },
      "error.raised": {
        errorCode: "internal-error",
        severity: "error",
        phase: "parsing",
        retryable: false,
      },
    };

    for (const type of CANONICAL_EVENT_TYPES) {
      const event = parseCanonicalEvent({ ...baseFields, type, ...drafts[type] });
      expect(event.type).toBe(type);
      expect(event.schemaVersion).toBe(CANONICAL_SCHEMA_VERSION);
      expect(event.extensions).toEqual({});
    }
  });

  it("rejects unknown event types and unknown fields", () => {
    expect(canonicalEventSchema.safeParse({ ...baseFields, type: "session.paused" }).success).toBe(
      false,
    );
    expect(
      canonicalEventSchema.safeParse({
        ...baseFields,
        type: "session.start",
        sessionKind: "interactive",
        rawPayload: { prompt: "leak" },
      }).success,
    ).toBe(false);
  });

  it("rejects a workspace identifier that is a filesystem path", () => {
    const result = validateCanonicalEvent({
      ...baseFields,
      workspace: { workspaceId: "/home/someone/projects/app", keySource: "git-root" },
      type: "session.start",
      sessionKind: "interactive",
    });
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.issues.join(" ")).toContain("workspace id");
    }
  });

  it("rejects a future schema version", () => {
    expect(
      canonicalEventSchema.safeParse({
        ...baseFields,
        schemaVersion: 2,
        type: "session.start",
        sessionKind: "interactive",
      }).success,
    ).toBe(false);
  });

  it("orders events by sequence, then time, then id", () => {
    const first = parseCanonicalEvent({
      ...baseFields,
      sequence: 0,
      type: "session.start",
      sessionKind: "interactive",
    });
    const second = parseCanonicalEvent({
      ...baseFields,
      eventId: "evt_0000000000000002",
      sequence: 1,
      type: "session.end",
      reason: "completed",
    });
    expect(compareEvents(first, second)).toBeLessThan(0);
    expect([second, first].sort(compareEvents)[0]?.sequence).toBe(0);
  });

  it("exposes usage only for event types that carry it", () => {
    const usage = normalizeUsageOrThrow({ temporality: "delta", inputTokens: 3 });
    const generation = parseCanonicalEvent({
      ...baseFields,
      type: "generation.end",
      generationId: "gen-1",
      model: { modelId: "m-1" },
      outcome: "ok",
      usage,
    });
    const prompt = parseCanonicalEvent({
      ...baseFields,
      type: "prompt.submitted",
      promptSource: "user",
    });
    expect(eventUsage(generation)?.inputTokens).toBe(3);
    expect(eventUsage(prompt)).toBeUndefined();
  });

  it("rejects usage that violates the canonical invariants", () => {
    const usage = normalizeUsageOrThrow({ temporality: "delta", inputTokens: 10 });
    expect(
      canonicalEventSchema.safeParse({
        ...baseFields,
        type: "session.end",
        reason: "completed",
        usage: { ...usage, cachedInputTokens: 20 },
      }).success,
    ).toBe(false);
  });
});

describe("namespaced extensions", () => {
  it("requires a namespace segment", () => {
    expect(isValidExtensionKey("acme.tier")).toBe(true);
    expect(isValidExtensionKey("acme.team.tier")).toBe(true);
    expect(isValidExtensionKey("tier")).toBe(false);
    expect(isValidExtensionKey("Acme.Tier")).toBe(false);
  });

  it("reserves core namespaces", () => {
    expect(isValidExtensionKey("otelhook.internal")).toBe(false);
    expect(extensionsSchema.safeParse({ "otel.foo": 1 }).success).toBe(false);
  });

  it("accepts attribute primitives and arrays but not nested payloads", () => {
    expect(
      extensionsSchema.safeParse({ "acme.a": "x", "acme.b": 2, "acme.c": true, "acme.d": [1, 2] })
        .success,
    ).toBe(true);
    expect(extensionsSchema.safeParse({ "acme.a": { nested: "payload" } }).success).toBe(false);
  });

  it("rejects unnamespaced keys inside an event", () => {
    expect(
      canonicalEventSchema.safeParse({
        ...baseFields,
        type: "session.start",
        sessionKind: "interactive",
        extensions: { tier: "gold" },
      }).success,
    ).toBe(false);
  });
});

describe("content facts", () => {
  const privacy = createTestPrivacyService();

  it("always reports lengths and a hash", () => {
    const fact = privacy.describeContent({ kind: "prompt", text: "hello world" });
    expect(fact.characterLength).toBe(11);
    expect(fact.byteLength).toBe(11);
    expect(fact.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(fact.disclosure).toBe("omitted");
    expect(fact.text).toBeUndefined();
    expect(contentFactSchema.safeParse(fact).success).toBe(true);
    expect(isContentFactConsistent(fact)).toBe(true);
  });

  it("rejects a hash that is not a sha256 digest", () => {
    expect(
      contentFactSchema.safeParse({
        kind: "prompt",
        characterLength: 1,
        byteLength: 1,
        contentHash: "hello world",
        disclosure: "omitted",
        truncated: false,
        secretsRedacted: 0,
      }).success,
    ).toBe(false);
  });

  it("detects an omitted fact that still carries text", () => {
    const inconsistent = {
      kind: "prompt" as const,
      characterLength: 5,
      byteLength: 5,
      contentHash: `sha256:${"0".repeat(64)}`,
      disclosure: "omitted" as const,
      text: "hello",
      truncated: false,
      secretsRedacted: 0,
    };
    expect(isContentFactConsistent(inconsistent)).toBe(false);
  });
});

describe("event immutability", () => {
  it("freezes identity-bearing sub-objects on parse", () => {
    const event: CanonicalEvent = parseCanonicalEvent({
      ...baseFields,
      type: "session.start",
      sessionKind: "interactive",
    });
    expect(Object.isFrozen(event.provenance)).toBe(true);
    expect(Object.isFrozen(event.workspace)).toBe(true);
  });
});
