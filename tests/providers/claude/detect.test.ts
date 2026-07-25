import { describe, expect, it } from "vitest";

import type { ProviderDetectionInput } from "../../../src/index.js";
import { createFixedClock, createRecordingLogger, createTestPrivacyService, createDeterministicIdGenerator } from "../../../src/testing/index.js";
import { createClaudeCodeAdapter } from "../../../src/providers/claude/index.js";
import * as fixtures from "../../fixtures/claude/index.js";

const privacy = createTestPrivacyService();
const context = {
  privacy,
  clock: createFixedClock(),
  ids: createDeterministicIdGenerator({ namespace: "test" }),
  logger: createRecordingLogger(),
  limits: privacy.policy.limits,
};

const adapter = createClaudeCodeAdapter();

const input = (payload: unknown, overrides: Partial<ProviderDetectionInput> = {}): ProviderDetectionInput => ({
  payload,
  transport: "test-fixture",
  environment: {},
  ...overrides,
});

describe("Claude Code adapter: detect", () => {
  it("recognizes a well-formed hook payload with transcript_path as strong confidence", () => {
    const detection = adapter.detect(input(fixtures.sessionStart), context);
    expect(detection.providerId).toBe("claude-code");
    expect(detection.confidence).toBe("strong");
    expect(detection.sourceEventName).toBe("SessionStart");
  });

  it("downgrades to weak confidence without transcript_path", () => {
    const detection = adapter.detect(input(fixtures.preToolUseWithoutTranscriptPath), context);
    expect(detection.confidence).toBe("weak");
  });

  it("upgrades to exact confidence when the caller asserts providerHint", () => {
    const detection = adapter.detect(
      input(fixtures.preToolUseWithoutTranscriptPath, { providerHint: "claude-code" }),
      context,
    );
    expect(detection.confidence).toBe("exact");
  });

  it("tolerates unknown/future fields on an otherwise valid payload", () => {
    const detection = adapter.detect(input(fixtures.preToolUseWithUnknownFields), context);
    expect(detection.confidence).not.toBe("none");
  });

  for (const [label, payload] of Object.entries({
    "unknown hook_event_name": fixtures.malformedUnknownEventName,
    "missing session_id": fixtures.malformedMissingSessionId,
    "not an object": fixtures.malformedNotAnObject,
    null: fixtures.malformedNull,
    array: fixtures.malformedArray,
    "empty object": fixtures.malformedEmptyObject,
    "generic input resembling a hook": fixtures.genericInputResemblingAHook,
  })) {
    it(`declines to classify: ${label}`, () => {
      const detection = adapter.detect(input(payload), context);
      expect(detection.providerId).toBe("unknown");
      expect(detection.confidence).toBe("none");
    });
  }
});
