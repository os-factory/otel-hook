import { describe, expect, it } from "vitest";

import { mergeAntigravityHookRegistration } from "../../../src/providers/antigravity/registration.js";

const COMMAND = "otel-hook antigravity-hook";

describe("mergeAntigravityHookRegistration", () => {
  it("registers all five documented hooks when no file exists yet", () => {
    const result = mergeAntigravityHookRegistration({ command: COMMAND });
    expect(result.changed).toBe(true);
    const hooks = result.config.hooks as Record<string, unknown[]>;
    for (const event of ["PreInvocation", "PostInvocation", "PreToolUse", "PostToolUse", "Stop"]) {
      expect(hooks[event]).toEqual([{ command: COMMAND }]);
    }
  });

  it("is idempotent: merging the result again changes nothing", () => {
    const first = mergeAntigravityHookRegistration({ command: COMMAND });
    const second = mergeAntigravityHookRegistration({ existing: first.config, command: COMMAND });

    expect(second.changed).toBe(false);
    expect(second.config).toEqual(first.config);
  });

  it("does not duplicate the command across repeated merges", () => {
    let config: unknown = undefined;
    for (let i = 0; i < 5; i += 1) {
      const result = mergeAntigravityHookRegistration({ existing: config, command: COMMAND });
      config = result.config;
    }
    const hooks = (config as { hooks: Record<string, unknown[]> }).hooks;
    expect(hooks.PreToolUse).toHaveLength(1);
  });

  it("preserves unrelated top-level keys", () => {
    const existing = { someOtherTool: { enabled: true }, hooks: {} };
    const result = mergeAntigravityHookRegistration({ existing, command: COMMAND });
    expect(result.config.someOtherTool).toEqual({ enabled: true });
  });

  it("preserves unrelated hook events and other entries for targeted events", () => {
    const existing = {
      hooks: {
        Stop: [{ command: "some-other-tool stop-hook" }],
        SomeFutureHook: [{ command: "unrelated" }],
      },
    };
    const result = mergeAntigravityHookRegistration({ existing, command: COMMAND, events: ["Stop"] });
    const hooks = result.config.hooks as Record<string, unknown[]>;

    expect(hooks.Stop).toEqual([{ command: "some-other-tool stop-hook" }, { command: COMMAND }]);
    expect(hooks.SomeFutureHook).toEqual([{ command: "unrelated" }]);
    expect(hooks.PreInvocation).toBeUndefined();
  });

  it("supports registering only a subset of events", () => {
    const result = mergeAntigravityHookRegistration({ command: COMMAND, events: ["Stop"] });
    const hooks = result.config.hooks as Record<string, unknown[]>;
    expect(Object.keys(hooks)).toEqual(["Stop"]);
  });

  it("carries an optional matcher on the registered entry", () => {
    const result = mergeAntigravityHookRegistration({
      command: COMMAND,
      events: ["PreToolUse"],
      matcher: "*",
    });
    const hooks = result.config.hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse).toEqual([{ command: COMMAND, matcher: "*" }]);
  });

  it("rebuilds gracefully when an existing hook event is malformed", () => {
    const existing = { hooks: { Stop: "not-an-array" } };
    const result = mergeAntigravityHookRegistration({ existing, command: COMMAND, events: ["Stop"] });
    const hooks = result.config.hooks as Record<string, unknown[]>;
    expect(hooks.Stop).toEqual([{ command: COMMAND }]);
    expect(result.changed).toBe(true);
  });

  it("treats a non-object existing value as absent without throwing", () => {
    const result = mergeAntigravityHookRegistration({ existing: "not-an-object", command: COMMAND });
    expect(result.changed).toBe(true);
    expect(Object.keys(result.config.hooks as Record<string, unknown>)).toHaveLength(5);
  });
});
