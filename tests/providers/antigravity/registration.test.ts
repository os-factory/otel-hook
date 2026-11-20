import { describe, expect, it } from "vitest";

import { ANTIGRAVITY_HOOK_EVENT_NAMES } from "../../../src/providers/antigravity/payload.js";
import {
  ANTIGRAVITY_MANAGED_HOOK_NAME,
  ANTIGRAVITY_REGISTRABLE_HOOK_EVENTS,
  ANTIGRAVITY_UNREGISTERED_HOOK_EVENTS,
  mergeAntigravityHookRegistration,
  readAntigravityHookRegistrations,
  removeAntigravityHookRegistration,
} from "../../../src/providers/antigravity/registration.js";

const COMMAND = "otel-hook run --provider antigravity";
const identifies = (entry: Readonly<Record<string, unknown>>): boolean => entry.command === COMMAND;

const hook = (config: Record<string, unknown>): Record<string, unknown> =>
  config[ANTIGRAVITY_MANAGED_HOOK_NAME] as Record<string, unknown>;

describe("mergeAntigravityHookRegistration", () => {
  it("writes the documented named-hook shape for the events that produce telemetry", () => {
    const result = mergeAntigravityHookRegistration({ command: COMMAND });
    expect(result.changed).toBe(true);
    expect(result.conflicts).toEqual([]);
    expect(hook(result.config)).toEqual({
      SessionStart: [{ type: "command", command: COMMAND }],
      PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: COMMAND }] }],
    });
    expect(result.changes.map((change) => change.event)).toEqual(["SessionStart", "PostToolUse"]);
  });

  it("registers every documented event that emits nothing only when asked, and explains the default skip", () => {
    expect([...ANTIGRAVITY_REGISTRABLE_HOOK_EVENTS]).toEqual(["SessionStart", "PostToolUse"]);
    const skipped = ANTIGRAVITY_HOOK_EVENT_NAMES.filter(
      (event) => !ANTIGRAVITY_REGISTRABLE_HOOK_EVENTS.includes(event),
    );
    expect([...skipped]).toEqual(["PreToolUse", "PreInvocation", "PostInvocation", "Stop"]);
    for (const event of skipped) {
      expect(ANTIGRAVITY_UNREGISTERED_HOOK_EVENTS[event], event).toBeDefined();
    }

    const result = mergeAntigravityHookRegistration({
      command: COMMAND,
      events: ["PreToolUse", "Stop"],
      matcher: "run_command",
      timeoutSeconds: 10,
    });
    expect(hook(result.config)).toEqual({
      PreToolUse: [
        { matcher: "run_command", hooks: [{ type: "command", command: COMMAND, timeout: 10 }] },
      ],
      Stop: [{ type: "command", command: COMMAND, timeout: 10 }],
    });
  });

  it("is idempotent: merging the result again changes nothing", () => {
    const first = mergeAntigravityHookRegistration({ command: COMMAND, timeoutSeconds: 30 });
    const second = mergeAntigravityHookRegistration({
      existing: first.config,
      command: COMMAND,
      timeoutSeconds: 30,
    });

    expect(second.changed).toBe(false);
    expect(second.config).toEqual(first.config);
    expect(second.changes.every((change) => change.action === "unchanged")).toBe(true);
  });

  it("preserves another named hook and rewrites our own command in place", () => {
    const existing = {
      "safety-gate": {
        enabled: false,
        PreToolUse: [{ matcher: "run_command", hooks: [{ command: "./scripts/safety-check.sh" }] }],
      },
      [ANTIGRAVITY_MANAGED_HOOK_NAME]: {
        PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "otel-hook run --old" }] }],
      },
    };
    const result = mergeAntigravityHookRegistration({
      existing,
      command: COMMAND,
      events: ["PostToolUse"],
      identifies: (entry) =>
        typeof entry.command === "string" && String(entry.command).includes("otel-hook"),
    });

    expect(result.config["safety-gate"]).toEqual(existing["safety-gate"]);
    expect(hook(result.config).PostToolUse).toEqual([
      { matcher: "*", hooks: [{ type: "command", command: COMMAND }] },
    ]);
    const read = readAntigravityHookRegistrations(result.config, (entry) =>
      typeof entry.command === "string" && String(entry.command).includes("otel-hook"),
    );
    expect(read.get("PostToolUse")).toEqual([COMMAND]);
  });

  it("refuses a hook definition that is not the documented shape", () => {
    const result = mergeAntigravityHookRegistration({
      existing: { "safety-gate": "not-an-object", keep: 1 },
      command: COMMAND,
    });
    expect(result.changed).toBe(false);
    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(result.config).toEqual({ "safety-gate": "not-an-object", keep: 1 });
  });

  it("treats a non-object existing value as absent without throwing", () => {
    const result = mergeAntigravityHookRegistration({ existing: "not-an-object", command: COMMAND });
    expect(result.changed).toBe(true);
    expect(result.conflicts).toEqual([]);
    expect(hook(result.config).SessionStart).toBeDefined();
  });

  it("removes our handlers and restores a document that only contained them", () => {
    const merged = mergeAntigravityHookRegistration({ command: COMMAND });
    const removed = removeAntigravityHookRegistration({ existing: merged.config, identifies });
    expect(removed.changed).toBe(true);
    expect(removed.config).toEqual({});
    expect(removed.changes.map((change) => change.action)).toEqual(["removed", "removed"]);
  });
});
