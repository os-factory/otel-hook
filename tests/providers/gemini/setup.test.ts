import { describe, expect, it } from "vitest";

import { GEMINI_HOOK_EVENT_NAMES } from "../../../src/providers/gemini/schema.js";
import { mergeGeminiHookRegistration } from "../../../src/providers/gemini/setup.js";

const registration = {
  name: "otel-hook-gemini",
  command: "otel-hook gemini-cli",
};

describe("mergeGeminiHookRegistration", () => {
  it("registers the hook under every documented event by default", () => {
    const result = mergeGeminiHookRegistration({}, registration);
    expect(result.changed).toBe(true);
    expect(result.registeredEvents).toEqual(GEMINI_HOOK_EVENT_NAMES);
    for (const event of GEMINI_HOOK_EVENT_NAMES) {
      expect(result.settings.hooks?.[event]).toEqual([
        { matcher: "*", hooks: [{ name: "otel-hook-gemini", type: "command", command: "otel-hook gemini-cli" }] },
      ]);
    }
  });

  it("is idempotent: applying the same registration twice changes nothing further", () => {
    const first = mergeGeminiHookRegistration({}, registration);
    const second = mergeGeminiHookRegistration(first.settings, registration);

    expect(second.changed).toBe(false);
    expect(second.settings).toEqual(first.settings);
  });

  it("preserves an existing unrelated hook registered under the same event and matcher", () => {
    const existing = {
      hooks: {
        BeforeTool: [
          {
            matcher: "*",
            hooks: [{ name: "some-other-tool", type: "command", command: "some-other-tool run" }],
          },
        ],
      },
    };

    const result = mergeGeminiHookRegistration(existing, { ...registration, events: ["BeforeTool"] });

    expect(result.changed).toBe(true);
    expect(result.settings.hooks?.BeforeTool?.[0]?.hooks).toEqual([
      { name: "some-other-tool", type: "command", command: "some-other-tool run" },
      { name: "otel-hook-gemini", type: "command", command: "otel-hook gemini-cli" },
    ]);
  });

  it("preserves settings fields outside of hooks", () => {
    const existing = { someUnrelatedSetting: true };
    const result = mergeGeminiHookRegistration(existing, { ...registration, events: ["SessionStart"] });
    expect(result.settings.someUnrelatedSetting).toBe(true);
  });

  it("adds a second matcher entry rather than merging into an unrelated matcher", () => {
    const first = mergeGeminiHookRegistration({}, { ...registration, events: ["BeforeTool"], matcher: "read_file" });
    const second = mergeGeminiHookRegistration(first.settings, {
      ...registration,
      events: ["BeforeTool"],
      matcher: "write_file",
    });

    expect(second.changed).toBe(true);
    expect(second.settings.hooks?.BeforeTool).toHaveLength(2);
  });

  it("distinguishes registrations by name, command, and timeout", () => {
    const first = mergeGeminiHookRegistration({}, { ...registration, events: ["SessionStart"] });
    const second = mergeGeminiHookRegistration(first.settings, {
      ...registration,
      events: ["SessionStart"],
      timeout: 5000,
    });

    expect(second.changed).toBe(true);
    expect(second.settings.hooks?.SessionStart?.[0]?.hooks).toHaveLength(2);
  });

  it("tolerates a non-object existing settings value by starting fresh", () => {
    const result = mergeGeminiHookRegistration(null, { ...registration, events: ["SessionEnd"] });
    expect(result.changed).toBe(true);
    expect(result.settings.hooks?.SessionEnd).toHaveLength(1);
  });
});
