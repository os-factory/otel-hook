import { describe, expect, it } from "vitest";

import { createCodexAdapter } from "../../../src/providers/codex/index.js";
import { batchContains, createTestHook, findDisclosureViolations } from "../../../src/testing/index.js";
import { loadHookFixture } from "./helpers.js";

const harness = () => createTestHook({ adapters: [createCodexAdapter()] });

describe("codex adapter: privacy", () => {
  it("omits prompt text by default and never leaks it, even a fixture with a secret-shaped string", async () => {
    const { hook, sink } = harness();
    await hook.ingest({ payload: loadHookFixture("user-prompt-submit.json"), transport: "hook-stdin" });

    expect(findDisclosureViolations(sink.events())).toEqual([]);
    expect(batchContains(sink.events(), "billing")).toBe(false);
    expect(batchContains(sink.events(), "sk-abcdefghijklmnopqrstuvwx")).toBe(false);
  });

  it("keeps tool input and output out of telemetry while recording only their shape", async () => {
    const { hook, sink } = harness();
    await hook.ingest({ payload: loadHookFixture("pre-tool-use-shell.json"), transport: "hook-stdin" });
    await hook.ingest({ payload: loadHookFixture("post-tool-use-success.json"), transport: "hook-stdin" });

    expect(batchContains(sink.events(), "abc123")).toBe(false);
    expect(batchContains(sink.events(), "sk-live-1234567890abcdef")).toBe(false);
    expect(batchContains(sink.events(), "deploy")).toBe(false);
    expect(findDisclosureViolations(sink.events())).toEqual([]);
  });

  it("never embeds the raw working directory anywhere in the emitted batch", async () => {
    const { hook, sink } = harness();
    await hook.ingest({ payload: loadHookFixture("session-start.json"), transport: "hook-stdin" });
    await hook.ingest({ payload: loadHookFixture("pre-tool-use-shell.json"), transport: "hook-stdin" });

    expect(batchContains(sink.events(), "/workspace/demo-repo")).toBe(false);
  });

  it("discloses under mask mode with the configured shape-preserving character, still no secrets", async () => {
    const { hook, sink } = createTestHook({
      adapters: [createCodexAdapter()],
      config: { privacy: { contentMode: "mask" } },
    });
    await hook.ingest({ payload: loadHookFixture("user-prompt-submit.json"), transport: "hook-stdin" });

    const event = sink.events().find((candidate) => candidate.type === "prompt.submitted");
    expect(event?.type === "prompt.submitted" && event.content?.disclosure).toBe("masked");
    expect(batchContains(sink.events(), "billing")).toBe(false);
  });

  it("carries a transcript_path field through only as an opaque string, never reading it", async () => {
    const { hook, sink } = harness();
    const outcome = await hook.ingest({
      payload: { ...(loadHookFixture("session-start.json") as Record<string, unknown>), transcript_path: "/nonexistent/path/rollout.jsonl" },
      transport: "hook-stdin",
    });

    // The adapter must not attempt to read transcript_path itself: an absent
    // file must not cause a failure or a diagnostic.
    expect(outcome.attribution).toBe("attributed");
    expect(outcome.diagnostics).toEqual([]);
    expect(batchContains(sink.events(), "/nonexistent/path/rollout.jsonl")).toBe(false);
  });
});
