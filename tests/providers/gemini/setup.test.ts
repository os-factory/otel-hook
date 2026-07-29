import { describe, expect, it } from "vitest";

import { GEMINI_HOOK_EVENT_NAMES } from "../../../src/providers/gemini/schema.js";
import {
  GEMINI_REGISTRABLE_HOOK_EVENTS,
  GEMINI_UNREGISTERED_HOOK_EVENTS,
  mergeGeminiHookRegistration,
  removeGeminiHookRegistration,
} from "../../../src/providers/gemini/setup.js";

const registration = {
  name: "otel-hook-gemini",
  command: "otel-hook gemini-cli",
};

const identifiesOurs = (handler: Readonly<Record<string, unknown>>): boolean =>
  handler.name === "otel-hook-gemini";

describe("mergeGeminiHookRegistration", () => {
  it("registers the hook under the events this adapter telemeters", () => {
    const result = mergeGeminiHookRegistration({}, registration);
    expect(result.changed).toBe(true);
    expect(result.registeredEvents).toEqual(GEMINI_REGISTRABLE_HOOK_EVENTS);
    for (const event of GEMINI_REGISTRABLE_HOOK_EVENTS) {
      expect(result.settings.hooks?.[event]).toEqual([
        { matcher: "*", hooks: [{ name: "otel-hook-gemini", type: "command", command: "otel-hook gemini-cli" }] },
      ]);
    }
  });

  it("skips the modelled events that produce no telemetry, each with a recorded reason", () => {
    const result = mergeGeminiHookRegistration({}, registration);
    const skipped = GEMINI_HOOK_EVENT_NAMES.filter(
      (event) => !GEMINI_REGISTRABLE_HOOK_EVENTS.includes(event),
    );
    expect(skipped).toEqual(["AfterAgent", "BeforeToolSelection", "Notification"]);
    for (const event of skipped) {
      // Registering these would spawn a process per occurrence and emit nothing.
      expect(result.settings.hooks?.[event]).toBeUndefined();
      expect(GEMINI_UNREGISTERED_HOOK_EVENTS[event]).toBeTruthy();
    }
  });

  it("writes the timeout in the milliseconds this vocabulary uses, not seconds", () => {
    // docs/hooks/reference.md: "Execution timeout in milliseconds (default:
    // 60000)", and hookRunner passes the value straight to setTimeout. Writing
    // 30 for `--timeout-seconds 30` would kill the hook after 30ms.
    const result = mergeGeminiHookRegistration(
      {},
      { ...registration, events: ["SessionStart"], timeoutSeconds: 30 },
    );
    expect(result.settings.hooks?.SessionStart?.[0]?.hooks?.[0]?.timeout).toBe(30_000);
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

  // `name` is this vocabulary's idempotency key, so a re-registration under a
  // different matcher *moves* the entry. Leaving the old one behind would fire
  // the hook twice for every tool the two matchers both select.
  it("moves its own registration when the matcher changes rather than adding a second", () => {
    const first = mergeGeminiHookRegistration({}, { ...registration, events: ["BeforeTool"], matcher: "read_file" });
    const second = mergeGeminiHookRegistration(first.settings, {
      ...registration,
      events: ["BeforeTool"],
      matcher: "write_file",
    });

    expect(second.changed).toBe(true);
    expect(second.settings.hooks?.BeforeTool).toEqual([
      {
        matcher: "write_file",
        hooks: [{ name: "otel-hook-gemini", type: "command", command: "otel-hook gemini-cli" }],
      },
    ]);
  });

  it("rewrites its own registration in place when the command or timeout changes", () => {
    const first = mergeGeminiHookRegistration({}, { ...registration, events: ["SessionStart"] });
    const second = mergeGeminiHookRegistration(first.settings, {
      ...registration,
      command: "/usr/local/bin/otel-hook run --provider gemini-cli",
      events: ["SessionStart"],
      timeoutSeconds: 5,
    });

    expect(second.changed).toBe(true);
    expect(second.settings.hooks?.SessionStart?.[0]?.hooks).toEqual([
      {
        name: "otel-hook-gemini",
        type: "command",
        command: "/usr/local/bin/otel-hook run --provider gemini-cli",
        timeout: 5_000,
      },
    ]);
  });

  it("collapses duplicate registrations of itself left behind by an older version", () => {
    const entry = { name: "otel-hook-gemini", type: "command", command: "otel-hook gemini-cli" };
    const existing = { hooks: { SessionStart: [{ matcher: "*", hooks: [entry, { ...entry, timeout: 30 }] }] } };

    const result = mergeGeminiHookRegistration(existing, { ...registration, events: ["SessionStart"] });

    expect(result.changed).toBe(true);
    expect(result.settings.hooks?.SessionStart?.[0]?.hooks).toEqual([entry]);
  });

  it("tolerates a non-object existing settings value by starting fresh", () => {
    const result = mergeGeminiHookRegistration(null, { ...registration, events: ["SessionEnd"] });
    expect(result.changed).toBe(true);
    expect(result.settings.hooks?.SessionEnd).toHaveLength(1);
  });

  // `HOOKS_CONFIG_FIELDS` is ['enabled', 'disabled', 'notifications'], so in this
  // vocabulary — unlike Claude Code's and the Codex CLI's — not every key under
  // `hooks` is an event name.
  it("preserves the non-event configuration keys that live inside hooks", () => {
    const existing = {
      hooks: {
        enabled: true,
        disabled: ["some-other-tool"],
        notifications: { enabled: false },
      },
    };

    const result = mergeGeminiHookRegistration(existing, { ...registration, events: ["BeforeTool"] });

    expect(result.conflicts).toEqual([]);
    expect(result.settings.hooks?.enabled).toBe(true);
    expect(result.settings.hooks?.disabled).toEqual(["some-other-tool"]);
    expect(result.settings.hooks?.notifications).toEqual({ enabled: false });
    expect(result.settings.hooks?.BeforeTool).toHaveLength(1);
  });

  it("preserves a developer's `sequential` flag on the group it writes into", () => {
    const existing = {
      hooks: {
        BeforeTool: [
          {
            matcher: "*",
            sequential: true,
            hooks: [{ name: "some-other-tool", type: "command", command: "some-other-tool run" }],
          },
        ],
      },
    };

    const result = mergeGeminiHookRegistration(existing, { ...registration, events: ["BeforeTool"] });

    expect(result.settings.hooks?.BeforeTool?.[0]?.sequential).toBe(true);
  });

  it("preserves the optional description and env fields on a handler it rewrites", () => {
    const existing = {
      hooks: {
        SessionStart: [
          {
            matcher: "*",
            hooks: [
              {
                name: "otel-hook-gemini",
                type: "command",
                command: "otel-hook gemini-cli",
                description: "hand-written note",
                env: { OTEL_HOOK_DEBUG: "1" },
              },
            ],
          },
        ],
      },
    };

    const result = mergeGeminiHookRegistration(existing, {
      ...registration,
      command: "otel-hook gemini-cli --endpoint https://collector.invalid",
      events: ["SessionStart"],
    });

    expect(result.settings.hooks?.SessionStart?.[0]?.hooks?.[0]).toEqual({
      name: "otel-hook-gemini",
      type: "command",
      command: "otel-hook gemini-cli --endpoint https://collector.invalid",
      description: "hand-written note",
      env: { OTEL_HOOK_DEBUG: "1" },
    });
  });
});

describe("removeGeminiHookRegistration", () => {
  it("restores the original document exactly after a setup", () => {
    const existing = { someUnrelatedSetting: true };
    const merged = mergeGeminiHookRegistration(existing, registration);
    const removed = removeGeminiHookRegistration(merged.settings, { identifies: identifiesOurs });

    expect(removed.changed).toBe(true);
    expect(removed.conflicts).toEqual([]);
    expect(removed.document).toEqual(existing);
  });

  // Regression: removal used to scan the document's own keys under `hooks`, so
  // `hooks.enabled: true` read as a malformed event list, raised a conflict, and
  // abandoned the whole uninstall — on exactly the settings files whose owners
  // had configured hooks most deliberately.
  it("uninstalls from a document whose hooks object carries the non-event config keys", () => {
    const existing = {
      hooks: {
        enabled: true,
        notifications: { enabled: false },
        BeforeTool: [
          {
            matcher: "*",
            hooks: [{ name: "some-other-tool", type: "command", command: "some-other-tool run" }],
          },
        ],
      },
    };
    const merged = mergeGeminiHookRegistration(existing, registration);

    const removed = removeGeminiHookRegistration(merged.settings, { identifies: identifiesOurs });

    expect(removed.conflicts).toEqual([]);
    expect(removed.changed).toBe(true);
    expect(removed.document).toEqual(existing);
  });
});
