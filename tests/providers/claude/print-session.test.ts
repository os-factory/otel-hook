import { describe, expect, it } from "vitest";

import type { CanonicalEvent, ProviderDetectionInput } from "../../../src/index.js";
import { createClaudeCodeAdapter } from "../../../src/providers/claude/index.js";
import {
  createDeterministicIdGenerator,
  createFixedClock,
  createRecordingLogger,
  createTestHook,
  createTestPrivacyService,
} from "../../../src/testing/index.js";
import * as fixtures from "../../fixtures/claude/index.js";

const privacy = createTestPrivacyService();
const detectContext = {
  privacy,
  clock: createFixedClock(),
  ids: createDeterministicIdGenerator({ namespace: "test" }),
  logger: createRecordingLogger(),
  limits: privacy.policy.limits,
};

const detectInput = (payload: unknown): ProviderDetectionInput => ({
  payload,
  transport: "test-fixture",
  environment: {},
});

const ingest = (payload: unknown, contentMode: "omit" | "redact" = "omit") => {
  const harness = createTestHook({
    adapters: [createClaudeCodeAdapter()],
    config: { privacy: { contentMode } },
  });
  return harness.hook.ingest({ payload, transport: "hook-stdin" });
};

const generationEnd = (events: readonly CanonicalEvent[]) => {
  const event = events.find((candidate) => candidate.type === "generation.end");
  if (event?.type !== "generation.end") {
    throw new Error(`expected generation.end, got: ${events.map((item) => item.type).join(", ")}`);
  }
  return event;
};

describe("Claude Code adapter: print / -p Stop payloads", () => {
  it("maps Stop.result through the privacy service as a response body", async () => {
    const outcome = await ingest(fixtures.stopPrintResult, "redact");
    const end = generationEnd(outcome.events);
    expect(end.outputContent?.[0]).toMatchObject({
      kind: "response",
      role: "assistant",
      disclosure: "redacted",
      text: fixtures.stopPrintResult.result,
    });
    expect(end.usage?.inputTokens).toBe(800 + 2_400 + 150);
    expect(end.usage?.outputTokens).toBe(120);
    expect(end.usage?.cachedInputTokens).toBe(2_400);
    expect(end.usage?.cacheCreationInputTokens).toBe(150);
  });

  it("emits a zero-length response fact when print Stop has usage but no assistant text", async () => {
    const outcome = await ingest(fixtures.stopPrintNoAssistantText, "redact");
    const end = generationEnd(outcome.events);
    expect(end.outputContent?.[0]).toMatchObject({
      kind: "response",
      role: "assistant",
      characterLength: 0,
    });
    expect(end.outputContent?.[0]?.text).toBeUndefined();
    expect(end.usage?.outputTokens).toBe(16);
  });

  it("recognizes a type=result print message as Stop and maps result + usage", async () => {
    const detection = createClaudeCodeAdapter().detect(
      detectInput(fixtures.printResultMessage),
      detectContext,
    );
    expect(detection.providerId).toBe("claude-code");
    expect(detection.sourceEventName).toBe("Stop");

    const outcome = await ingest(fixtures.printResultMessage, "redact");
    const end = generationEnd(outcome.events);
    expect(end.outputContent?.[0]?.text).toBe(fixtures.printResultMessage.result);
    expect(end.usage?.outputTokens).toBe(96);
  });

  it("maps camelCase lastAssistantMessage and camelCase usage counters", async () => {
    const outcome = await ingest(fixtures.stopCamelCaseAssistant, "redact");
    const end = generationEnd(outcome.events);
    expect(end.outputContent?.[0]?.text).toBe(fixtures.stopCamelCaseAssistant.lastAssistantMessage);
    expect(end.usage?.outputTokens).toBe(40);
    expect(end.usage?.cachedInputTokens).toBe(80);
    expect(end.usage?.cacheCreationInputTokens).toBe(10);
  });

  it("does not invent assistant text when the provider sent none", async () => {
    const outcome = await ingest(fixtures.stopPrintNoAssistantText, "redact");
    const end = generationEnd(outcome.events);
    expect(end.outputContent?.[0]?.text).toBeUndefined();
    expect(JSON.stringify(outcome.events)).not.toContain("Print-mode");
    expect(JSON.stringify(outcome.events)).not.toContain("Agent-SDK");
  });
});
