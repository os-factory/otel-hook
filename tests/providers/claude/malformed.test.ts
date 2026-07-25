import { describe, expect, it } from "vitest";

import { createClaudeCodeAdapter } from "../../../src/providers/claude/index.js";
import { createTestHook } from "../../../src/testing/index.js";
import * as fixtures from "../../fixtures/claude/index.js";

const run = async (payload: unknown) => {
  const harness = createTestHook({ adapters: [createClaudeCodeAdapter()] });
  return harness.hook.ingest({ payload, transport: "hook-stdin" });
};

describe("Claude Code adapter: malformed input", () => {
  for (const [label, payload] of Object.entries({
    "not an object": fixtures.malformedNotAnObject,
    null: fixtures.malformedNull,
    array: fixtures.malformedArray,
    "empty object": fixtures.malformedEmptyObject,
    "unknown hook_event_name": fixtures.malformedUnknownEventName,
    "missing session_id": fixtures.malformedMissingSessionId,
    "generic input resembling a hook": fixtures.genericInputResemblingAHook,
  })) {
    it(`never attributes or throws: ${label}`, async () => {
      const outcome = await run(payload);
      expect(outcome.ok).toBe(true);
      expect(outcome.attribution).toBe("declined");
      expect(outcome.providerId).toBe("unknown");
      expect(outcome.events).toHaveLength(0);
    });
  }

  it("fails at parse (not at identity) when a required event-specific field is missing", async () => {
    const outcome = await run(fixtures.malformedPreToolUseMissingToolUseId);
    expect(outcome.ok).toBe(true);
    expect(outcome.attribution).toBe("failed");
    expect(outcome.attributionReason).toBe("adapter-failure");
    // Identity still resolved: session_id and hook_event_name were present.
    expect(outcome.identity?.sessionId).toBeDefined();
    expect(outcome.events).toHaveLength(0);
    expect(outcome.diagnostics.some((diagnostic) => diagnostic.code === "invalid-input")).toBe(true);
  });

  it("SessionEnd tolerates an end_reason it has never seen before", async () => {
    const outcome = await run(fixtures.sessionEndUnknownReason);
    expect(outcome.attribution).toBe("attributed");
    const event = outcome.events[0];
    expect(event?.type).toBe("session.end");
    if (event?.type === "session.end") {
      expect(event.reason).toBe("unknown");
    }
  });

  it("tolerates unrecognized/future fields without dropping the payload", async () => {
    const outcome = await run(fixtures.preToolUseWithUnknownFields);
    expect(outcome.attribution).toBe("attributed");
    expect(outcome.events).toHaveLength(1);
  });
});
