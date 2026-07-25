import { describe, expect, it } from "vitest";

import { createClaudeCodeAdapter } from "../../../src/providers/claude/index.js";
import { batchContains, createTestHook, findDisclosureViolations } from "../../../src/testing/index.js";
import * as fixtures from "../../fixtures/claude/index.js";

const ALL_FIXTURES: readonly unknown[] = [
  fixtures.sessionStart,
  fixtures.sessionStartResumed,
  fixtures.userPromptSubmit,
  fixtures.preToolUseBash,
  fixtures.postToolUseBash,
  fixtures.postToolUseFailure,
  fixtures.permissionRequest,
  fixtures.subagentStart,
  fixtures.subagentStop,
  fixtures.preToolUseFromSubagent,
  fixtures.preCompact,
  fixtures.postCompact,
  fixtures.stop,
  fixtures.stopNoUsage,
  fixtures.stopFailureRateLimit,
  fixtures.stopFailureAuth,
  fixtures.sessionEndClear,
  fixtures.sessionEndLogout,
  fixtures.preToolUseWithSecrets,
  fixtures.postToolUseWithSecrets,
];

describe("Claude Code adapter: privacy (default omit policy)", () => {
  it("never discloses content across the whole fixture set", async () => {
    for (const payload of ALL_FIXTURES) {
      const harness = createTestHook({ adapters: [createClaudeCodeAdapter()] });
      const outcome = await harness.hook.ingest({ payload, transport: "hook-stdin" });
      expect(findDisclosureViolations(outcome.events)).toEqual([]);
    }
  });

  it("never leaks the working directory: workspace ids are opaque hashes", async () => {
    const harness = createTestHook({ adapters: [createClaudeCodeAdapter()] });
    const outcome = await harness.hook.ingest({ payload: fixtures.preToolUseBash, transport: "hook-stdin" });
    expect(batchContains(outcome.events, "synthetic-user")).toBe(false);
    expect(batchContains(outcome.events, "demo-repo")).toBe(false);
  });

  it("never leaks the fabricated bearer token or api key, even under omit", async () => {
    const harness = createTestHook({ adapters: [createClaudeCodeAdapter()] });
    const outcome = await harness.hook.ingest({ payload: fixtures.preToolUseWithSecrets, transport: "hook-stdin" });
    expect(batchContains(outcome.events, "sk-synthetic1234567890abcdef")).toBe(false);
    expect(batchContains(outcome.events, "sk-synthetic-should-never-leak-0000000000")).toBe(false);
  });
});

describe("Claude Code adapter: privacy (redact policy)", () => {
  const harnessWithRedact = () =>
    createTestHook({ adapters: [createClaudeCodeAdapter()], config: { privacy: { contentMode: "redact" } } });

  it("discloses text but still redacts secret-shaped values", async () => {
    const harness = harnessWithRedact();
    const outcome = await harness.hook.ingest({ payload: fixtures.preToolUseWithSecrets, transport: "hook-stdin" });
    expect(findDisclosureViolations(outcome.events, "redacted")).toEqual([]);
    expect(batchContains(outcome.events, "sk-synthetic1234567890abcdef")).toBe(false);
    expect(batchContains(outcome.events, "sk-synthetic-should-never-leak-0000000000")).toBe(false);

    const toolStart = outcome.events.find((event) => event.type === "tool.start");
    if (toolStart?.type !== "tool.start") throw new Error("expected a tool.start event");
    expect(toolStart.input?.disclosure).toBe("redacted");
    expect(toolStart.input?.text).toBeDefined();
    expect(toolStart.input?.secretsRedacted).toBeGreaterThan(0);
  });

  it("redacts a secret-shaped tool_response the same way", async () => {
    const harness = harnessWithRedact();
    const outcome = await harness.hook.ingest({ payload: fixtures.postToolUseWithSecrets, transport: "hook-stdin" });
    expect(batchContains(outcome.events, "synthetic-secret-cookie-value")).toBe(false);
  });
});
