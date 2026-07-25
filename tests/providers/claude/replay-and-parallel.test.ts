import { describe, expect, it } from "vitest";

import type { HookIngestOutcome } from "../../../src/index.js";
import { createClaudeCodeAdapter } from "../../../src/providers/claude/index.js";
import { createTestHook } from "../../../src/testing/index.js";
import * as fixtures from "../../fixtures/claude/index.js";

describe("Claude Code adapter: replay safety", () => {
  it("two independent processes given the identical payload derive identical ids", async () => {
    const first = createTestHook({ adapters: [createClaudeCodeAdapter()] });
    const second = createTestHook({ adapters: [createClaudeCodeAdapter()] });

    const outcomeA = await first.hook.ingest({ payload: fixtures.stop, transport: "hook-stdin" });
    const outcomeB = await second.hook.ingest({ payload: fixtures.stop, transport: "hook-stdin" });

    expect(outcomeA.identity?.invocationId).toBe(outcomeB.identity?.invocationId);
    expect(outcomeA.events.map((event) => event.eventId)).toEqual(outcomeB.events.map((event) => event.eventId));
  });

  it("a duplicated delivery within one session advances sequence rather than colliding", async () => {
    const harness = createTestHook({ adapters: [createClaudeCodeAdapter()] });
    const first = await harness.hook.ingest({ payload: fixtures.userPromptSubmit, transport: "hook-stdin" });
    const second = await harness.hook.ingest({ payload: fixtures.userPromptSubmit, transport: "hook-stdin" });

    expect(first.events[0]?.sequence).toBe(0);
    expect(second.events[0]?.sequence).toBe(1);
    expect(first.events[0]?.eventId).not.toBe(second.events[0]?.eventId);
  });
});

describe("Claude Code adapter: parallel tool calls", () => {
  it("correlates PreToolUse/PostToolUse pairs by tool_use_id regardless of completion order", async () => {
    const harness = createTestHook({ adapters: [createClaudeCodeAdapter()] });
    const outcomes: HookIngestOutcome[] = [];
    for (const payload of fixtures.parallelToolCalls) {
      outcomes.push(await harness.hook.ingest({ payload, transport: "hook-stdin" }));
    }

    const [startA, startB, endB, endA] = outcomes;
    expect(startA?.events[0]?.type).toBe("tool.start");
    expect(startB?.events[0]?.type).toBe("tool.start");
    expect(endB?.events[0]?.type).toBe("tool.end");
    expect(endA?.events[0]?.type).toBe("tool.end");

    const toolCallId = (outcome: HookIngestOutcome | undefined): string | undefined => {
      const event = outcome?.events[0];
      return event?.type === "tool.start" || event?.type === "tool.end" ? event.toolCallId : undefined;
    };

    expect(toolCallId(startA)).toBe("toolu_synthetic_parallel_1");
    expect(toolCallId(startB)).toBe("toolu_synthetic_parallel_2");
    // B finishes before A started it second, but still correlates by id, not by order.
    expect(toolCallId(endB)).toBe("toolu_synthetic_parallel_2");
    expect(toolCallId(endA)).toBe("toolu_synthetic_parallel_1");

    // Every hook firing in the session shares sessionId but gets its own invocationId.
    const invocationIds = new Set(outcomes.map((outcome) => outcome.identity?.invocationId));
    expect(invocationIds.size).toBe(4);
    const sessionIds = new Set(outcomes.map((outcome) => outcome.identity?.sessionId));
    expect(sessionIds.size).toBe(1);

    // Sequence numbers are consecutive across the whole session, not per tool call.
    expect(outcomes.map((outcome) => outcome.events[0]?.sequence)).toEqual([0, 1, 2, 3]);
  });
});
