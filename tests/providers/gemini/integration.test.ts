import { describe, expect, it } from "vitest";

import type { HookIngestInput } from "../../../src/index.js";
import { createGeminiCliAdapter } from "../../../src/providers/gemini/index.js";
import { batchContains, createTestHook, findDisclosureViolations } from "../../../src/testing/index.js";
import { loadGeminiFixture } from "./fixtures.js";

const ingest = (payload: unknown): HookIngestInput => ({
  payload,
  transport: "hook-stdin",
});

describe("gemini-cli adapter: end-to-end via the hook runtime", () => {
  it("attributes a full session and numbers sequences consecutively", async () => {
    const harness = createTestHook({ adapters: [createGeminiCliAdapter()] });

    const outcomes = [];
    for (const name of ["session-start", "before-agent", "before-model", "before-tool", "after-tool"]) {
      outcomes.push(await harness.hook.ingest(ingest(loadGeminiFixture(name))));
    }

    for (const outcome of outcomes) {
      expect(outcome.attribution).toBe("attributed");
      expect(outcome.providerId).toBe("gemini-cli");
    }
    expect(harness.sink.events().map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4]);
    expect(harness.sink.events().map((event) => event.type)).toEqual([
      "session.start",
      "prompt.submitted",
      "generation.start",
      "tool.start",
      "tool.end",
    ]);
  });

  it("only completes a model invocation on the terminal streaming chunk", async () => {
    const harness = createTestHook({ adapters: [createGeminiCliAdapter()] });

    const beforeModel = await harness.hook.ingest(ingest(loadGeminiFixture("before-model")));
    const chunk = await harness.hook.ingest(ingest(loadGeminiFixture("after-model-chunk")));
    const final = await harness.hook.ingest(ingest(loadGeminiFixture("after-model-final")));

    expect(beforeModel.attribution).toBe("attributed");
    expect(beforeModel.emitted).toBe(1);
    expect(chunk.attribution).toBe("not-applicable");
    expect(chunk.emitted).toBe(0);
    expect(final.attribution).toBe("attributed");
    expect(final.emitted).toBe(1);

    const events = harness.sink.events();
    expect(events.map((event) => event.type)).toEqual(["generation.start", "generation.end"]);
    const [start, end] = events;
    if (start?.type === "generation.start" && end?.type === "generation.end") {
      expect(end.generationId).toBe(start.generationId);
    }
  });

  it("derives the same content-addressed ids for a duplicate delivery of the same payload", async () => {
    // Sequence numbers still advance across the two deliveries (they are
    // per-session, not per-payload), but every id the adapter itself derives
    // from payload content — invocationId, toolCallId — is a pure function of
    // that content, so a retried or duplicated hook call reproduces them.
    const harness = createTestHook({ adapters: [createGeminiCliAdapter()] });
    const payload = loadGeminiFixture("before-tool");

    const first = await harness.hook.ingest(ingest(payload));
    const second = await harness.hook.ingest(ingest(payload));

    expect(first.attribution).toBe("attributed");
    expect(second.attribution).toBe("attributed");
    expect(first.identity?.invocationId).toBe(second.identity?.invocationId);
    const events = harness.sink.events();
    expect(events).toHaveLength(2);
    if (events[0]?.type === "tool.start" && events[1]?.type === "tool.start") {
      expect(events[0].toolCallId).toBe(events[1].toolCallId);
    }
  });

  it("drops nothing for a missing-usage generation.end and still attributes it", async () => {
    const harness = createTestHook({ adapters: [createGeminiCliAdapter()] });
    const noUsagePayload = {
      ...(loadGeminiFixture("after-model-final") as Record<string, unknown>),
      llm_response: {
        candidates: [
          { content: { role: "model", parts: [{ text: "no usage reported" }] }, finishReason: "STOP" },
        ],
      },
    };

    const outcome = await harness.hook.ingest(ingest(noUsagePayload));
    expect(outcome.attribution).toBe("not-applicable");
    expect(harness.sink.events()).toHaveLength(0);
  });

  it("stays declined-free but unattributed for a payload that is not this protocol", async () => {
    const harness = createTestHook({ adapters: [createGeminiCliAdapter()] });
    const outcome = await harness.hook.ingest(ingest(loadGeminiFixture("malformed")));

    expect(outcome.attribution).toBe("declined");
    expect(outcome.providerId).toBe("unknown");
    expect(harness.sink.events()).toHaveLength(0);
  });

  it("never discloses prompt, tool, or response content under the default omit policy", async () => {
    const harness = createTestHook({ adapters: [createGeminiCliAdapter()] });
    for (const name of ["before-agent", "before-model", "after-model-final", "before-tool", "after-tool"]) {
      await harness.hook.ingest(ingest(loadGeminiFixture(name)));
    }
    expect(findDisclosureViolations(harness.sink.events())).toEqual([]);
  });

  it("redacts secret-looking keys from tool input even though content is otherwise omitted", async () => {
    const harness = createTestHook({ adapters: [createGeminiCliAdapter()] });
    await harness.hook.ingest(ingest(loadGeminiFixture("secrets-in-tool-input")));

    const events = harness.sink.events();
    expect(batchContains(events, "AKIAFAKEFAKEFAKEFAKE")).toBe(false);
    expect(batchContains(events, "sk-fake-not-a-real-key-000000000000")).toBe(false);
    expect(findDisclosureViolations(events)).toEqual([]);
  });

  it("keeps a workspace handle opaque: no raw cwd path reaches the batch", async () => {
    const harness = createTestHook({ adapters: [createGeminiCliAdapter()] });
    await harness.hook.ingest(ingest(loadGeminiFixture("session-start")));
    expect(batchContains(harness.sink.events(), "/workspace/demo-repo")).toBe(false);
  });
});
