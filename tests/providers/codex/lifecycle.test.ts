import { describe, expect, it } from "vitest";

import { createCodexAdapter } from "../../../src/providers/codex/index.js";
import { createTestHook } from "../../../src/testing/index.js";
import { loadHookFixture } from "./helpers.js";

const harness = () => createTestHook({ adapters: [createCodexAdapter()] });

describe("codex adapter: lifecycle mapping", () => {
  it("maps SessionStart to session.start", async () => {
    const { hook, sink } = harness();
    const outcome = await hook.ingest({
      payload: loadHookFixture("session-start.json"),
      transport: "hook-stdin",
    });

    expect(outcome.attribution).toBe("attributed");
    expect(sink.events()).toHaveLength(1);
    const event = sink.events()[0];
    expect(event?.type).toBe("session.start");
    if (event?.type === "session.start") {
      expect(event.agentName).toBe("codex");
      expect(event.agentVersion).toBe("0.42.0");
      expect(event.model?.modelId).toBe("gpt-5-codex");
      expect(event.sessionKind).toBe("unknown");
    }
  });

  it("maps UserPromptSubmit to prompt.submitted with content omitted by default", async () => {
    const { hook, sink } = harness();
    await hook.ingest({ payload: loadHookFixture("session-start.json"), transport: "hook-stdin" });
    const outcome = await hook.ingest({
      payload: loadHookFixture("user-prompt-submit.json"),
      transport: "hook-stdin",
    });

    expect(outcome.attribution).toBe("attributed");
    const event = sink.events().find((candidate) => candidate.type === "prompt.submitted");
    expect(event?.type === "prompt.submitted" && event.content?.disclosure).toBe("omitted");
    expect(event?.type === "prompt.submitted" && event.content?.text).toBeUndefined();
    expect(event?.type === "prompt.submitted" && event.promptSource).toBe("user");
  });

  it("maps PreToolUse/PostToolUse to tool.start/tool.end with tool kind classification", async () => {
    const { hook, sink } = harness();
    await hook.ingest({ payload: loadHookFixture("session-start.json"), transport: "hook-stdin" });
    await hook.ingest({ payload: loadHookFixture("pre-tool-use-shell.json"), transport: "hook-stdin" });
    await hook.ingest({
      payload: loadHookFixture("post-tool-use-success.json"),
      transport: "hook-stdin",
    });

    const start = sink.events().find((event) => event.type === "tool.start");
    const end = sink.events().find((event) => event.type === "tool.end");
    expect(start?.type === "tool.start" && start.toolKind).toBe("execute");
    expect(start?.type === "tool.start" && start.toolCallId).toBe("call-shell-0001");
    expect(end?.type === "tool.end" && end.toolCallId).toBe(
      start?.type === "tool.start" ? start.toolCallId : undefined,
    );
    expect(end?.type === "tool.end" && end.outcome).toBe("ok");
    expect(end?.type === "tool.end" && end.permissionDecision).toBe("allowed");
    expect(end?.type === "tool.end" && end.durationMillis).toBe(842);
  });

  it("classifies apply_patch as a write and an MCP tool as other", async () => {
    const { hook, sink } = harness();
    await hook.ingest({ payload: loadHookFixture("session-start.json"), transport: "hook-stdin" });
    await hook.ingest({
      payload: loadHookFixture("pre-tool-use-apply-patch.json"),
      transport: "hook-stdin",
    });
    await hook.ingest({ payload: loadHookFixture("pre-tool-use-mcp.json"), transport: "hook-stdin" });

    const starts = sink.events().filter((event) => event.type === "tool.start");
    expect(starts.find((event) => event.type === "tool.start" && event.toolName === "apply_patch")).toMatchObject({
      toolKind: "write",
    });
    expect(
      starts.find(
        (event) => event.type === "tool.start" && event.toolName === "mcp__acme-server__lookup_customer",
      ),
    ).toMatchObject({ toolKind: "other" });
  });

  it("reports an error outcome from a failed tool_response", async () => {
    const { hook, sink } = harness();
    await hook.ingest({ payload: loadHookFixture("session-start.json"), transport: "hook-stdin" });
    await hook.ingest({
      payload: loadHookFixture("post-tool-use-error.json"),
      transport: "hook-stdin",
    });

    const end = sink.events().find((event) => event.type === "tool.end");
    expect(end?.type === "tool.end" && end.outcome).toBe("error");
  });

  it("reports a denied outcome and permission decision without needing tool_response", async () => {
    const { hook, sink } = harness();
    await hook.ingest({ payload: loadHookFixture("session-start.json"), transport: "hook-stdin" });
    await hook.ingest({
      payload: loadHookFixture("post-tool-use-denied.json"),
      transport: "hook-stdin",
    });

    const end = sink.events().find((event) => event.type === "tool.end");
    expect(end?.type === "tool.end" && end.outcome).toBe("denied");
    expect(end?.type === "tool.end" && end.permissionDecision).toBe("denied");
  });

  it("splits compaction context sizes across PreCompact and PostCompact", async () => {
    const { hook, sink } = harness();
    await hook.ingest({ payload: loadHookFixture("session-start.json"), transport: "hook-stdin" });
    await hook.ingest({ payload: loadHookFixture("pre-compact.json"), transport: "hook-stdin" });
    await hook.ingest({ payload: loadHookFixture("post-compact.json"), transport: "hook-stdin" });

    const events = sink.events().filter((event) => event.type === "compaction.performed");
    expect(events).toHaveLength(2);
    expect(events[0]?.type === "compaction.performed" && events[0].contextTokensBefore).toBe(128000);
    expect(events[0]?.type === "compaction.performed" && events[0].contextTokensAfter).toBeUndefined();
    expect(events[1]?.type === "compaction.performed" && events[1].contextTokensAfter).toBe(32000);
    expect(events[1]?.type === "compaction.performed" && events[1].droppedMessageCount).toBe(42);
    expect(events[1]?.type === "compaction.performed" && events[1].usage?.inputTokens).toBe(500000);
  });

  it("correlates SubagentStart and SubagentStop to the same subagent invocation id", async () => {
    const { hook, sink } = harness();
    await hook.ingest({ payload: loadHookFixture("session-start.json"), transport: "hook-stdin" });
    await hook.ingest({ payload: loadHookFixture("subagent-start.json"), transport: "hook-stdin" });
    await hook.ingest({ payload: loadHookFixture("subagent-stop.json"), transport: "hook-stdin" });

    const start = sink.events().find((event) => event.type === "subagent.start");
    const end = sink.events().find((event) => event.type === "subagent.end");
    expect(start?.type === "subagent.start" && start.subagentInvocationId).toBe(
      end?.type === "subagent.end" ? end.subagentInvocationId : undefined,
    );
    expect(start?.type === "subagent.start" && start.subagentType).toBe("reviewer");
    expect(start?.type === "subagent.start" && start.delegationDepth).toBe(1);
    expect(end?.type === "subagent.end" && end.outcome).toBe("ok");
    expect(end?.type === "subagent.end" && end.usage?.inputTokens).toBe(4000);
  });

  it("maps Stop to generation.end, since Codex has no dependable SessionEnd", async () => {
    const { hook, sink } = harness();
    await hook.ingest({ payload: loadHookFixture("session-start.json"), transport: "hook-stdin" });
    const outcome = await hook.ingest({ payload: loadHookFixture("stop.json"), transport: "hook-stdin" });

    expect(outcome.attribution).toBe("attributed");
    const event = sink.events().find((candidate) => candidate.type === "generation.end");
    expect(event?.type === "generation.end" && event.generationId).toBe("turn-0001");
    expect(event?.type === "generation.end" && event.model.modelId).toBe("gpt-5-codex");
    expect(event?.type === "generation.end" && event.outcome).toBe("ok");
    expect(event?.type === "generation.end" && event.usage?.totalTokens).toBe(13500);
    expect(sink.events().some((candidate) => candidate.type === "session.end")).toBe(false);
  });

  it("ignores PermissionRequest as carrying no telemetry of its own", async () => {
    const { hook, sink } = harness();
    await hook.ingest({ payload: loadHookFixture("session-start.json"), transport: "hook-stdin" });
    const outcome = await hook.ingest({
      payload: loadHookFixture("permission-request.json"),
      transport: "hook-stdin",
    });

    expect(outcome.attribution).toBe("not-applicable");
    expect(outcome.attributionReason).toBe("adapter-ignored-input");
    expect(sink.events()).toHaveLength(1); // only the earlier session.start
  });

  it("declares no session.end capability", () => {
    const adapter = createCodexAdapter();
    expect(adapter.capabilities.lifecycleEvents).not.toContain("session.end");
    expect(adapter.capabilities.lifecycleEvents).toContain("generation.end");
  });
});
