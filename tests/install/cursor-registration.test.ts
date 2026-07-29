import { describe, expect, it } from "vitest";

import {
  CURSOR_HOOK_EVENTS_MODELLED,
  CURSOR_REGISTRABLE_HOOK_EVENTS,
  CURSOR_UNREGISTERED_HOOK_EVENTS,
  findInstallLocation,
  findRegistrationPlanner,
  managedHookPredicate,
  mergeCursorHookRegistration,
  readCursorHookRegistrations,
  removeCursorHookRegistration,
  resolveInstallPath,
} from "../../src/install/index.js";
import { CURSOR_UNMODELLED_HOOK_EVENT_NAMES } from "../../src/providers/cursor/payload.js";

const OURS = managedHookPredicate("otel-hook");
const COMMAND = "otel-hook run --provider cursor";

const merge = (existing: unknown, overrides: Record<string, unknown> = {}) =>
  mergeCursorHookRegistration({
    ...(existing === undefined ? {} : { existing }),
    command: COMMAND,
    identifies: OURS,
    ...overrides,
  });

describe("cursor registration: the documented document shape", () => {
  it("writes `{ version, hooks: { <event>: [entry] } }` with a flat list per event", () => {
    const { config, changed } = merge(undefined);
    expect(changed).toBe(true);
    expect(config.version).toBe(1);
    const hooks = config.hooks as Record<string, unknown[]>;
    expect(Object.keys(hooks).sort()).toEqual([...CURSOR_REGISTRABLE_HOOK_EVENTS].sort());
    for (const event of CURSOR_REGISTRABLE_HOOK_EVENTS) {
      expect(hooks[event], event).toEqual([{ type: "command", command: COMMAND }]);
    }
  });

  it("writes `timeout` in seconds, and a matcher only when asked for one", () => {
    const withTimeout = merge(undefined, { timeoutSeconds: 30, events: ["preToolUse"] });
    expect((withTimeout.config.hooks as Record<string, unknown[]>).preToolUse?.[0]).toEqual({
      type: "command",
      command: COMMAND,
      timeout: 30,
    });

    // Cursor documents an omitted matcher as matching every occurrence, so the
    // key is absent by default rather than spelled "*".
    const bare = merge(undefined, { events: ["preToolUse"] });
    expect((bare.config.hooks as Record<string, unknown[]>).preToolUse?.[0]).not.toHaveProperty(
      "matcher",
    );

    const matched = merge(undefined, { events: ["preToolUse"], matcher: "Shell" });
    expect((matched.config.hooks as Record<string, unknown[]>).preToolUse?.[0]).toMatchObject({
      matcher: "Shell",
    });
  });

  it("leaves a version a developer already declared alone", () => {
    const { config } = merge({ version: 2, hooks: {} });
    expect(config.version).toBe(2);
  });
});

describe("cursor registration: idempotence, upgrade, repair", () => {
  it("is a no-op the second time, byte for byte", () => {
    const first = merge(undefined);
    const second = mergeCursorHookRegistration({
      existing: first.config,
      command: COMMAND,
      identifies: OURS,
    });
    expect(second.changed).toBe(false);
    expect(second.config).toEqual(first.config);
  });

  it("rewrites our own entry in place instead of appending a second one", () => {
    const first = merge(undefined, { events: ["preToolUse"] });
    const upgraded = mergeCursorHookRegistration({
      existing: first.config,
      command: "/opt/tools/otel-hook run --provider cursor --endpoint https://collector.invalid",
      events: ["preToolUse"],
      identifies: OURS,
    });

    expect(upgraded.changed).toBe(true);
    const entries = (upgraded.config.hooks as Record<string, unknown[]>).preToolUse ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ command: expect.stringContaining("--endpoint") as unknown });
  });

  it("collapses pre-existing duplicates of ours, which would double every span", () => {
    const existing = {
      version: 1,
      hooks: {
        preToolUse: [
          { type: "command", command: "otel-hook run --provider cursor --old" },
          { type: "command", command: "otel-hook run --provider cursor" },
        ],
      },
    };
    const { config, changed } = merge(existing, { events: ["preToolUse"] });
    expect(changed).toBe(true);
    expect((config.hooks as Record<string, unknown[]>).preToolUse).toEqual([
      { type: "command", command: COMMAND },
    ]);
  });

  it("carries unrelated events, unrelated entries, and unrelated top-level keys through", () => {
    const existing = {
      version: 1,
      somethingElse: { keep: true },
      hooks: {
        preToolUse: [{ command: "./scripts/audit.sh" }],
        beforeTabFileRead: [{ command: "./scripts/tab.sh" }],
      },
    };
    const { config } = merge(existing, { events: ["preToolUse"] });
    expect(config.somethingElse).toEqual({ keep: true });
    expect((config.hooks as Record<string, unknown[]>).beforeTabFileRead).toEqual([
      { command: "./scripts/tab.sh" },
    ]);
    expect((config.hooks as Record<string, unknown[]>).preToolUse).toEqual([
      { command: "./scripts/audit.sh" },
      { type: "command", command: COMMAND },
    ]);
  });
});

describe("cursor registration: reversibility", () => {
  it("restores a document that had other hooks exactly", () => {
    const existing = {
      version: 1,
      hooks: { preToolUse: [{ command: "./scripts/audit.sh" }] },
    };
    const merged = merge(existing, { events: ["preToolUse", "stop"] });
    const removed = removeCursorHookRegistration({ existing: merged.config, identifies: OURS });

    expect(removed.changed).toBe(true);
    expect(removed.config).toEqual(existing);
  });

  it("leaves nothing behind when setup created the file, version key included", () => {
    const merged = merge(undefined);
    const removed = removeCursorHookRegistration({ existing: merged.config, identifies: OURS });

    // A hooks.json declaring a schema version for no hooks is a document Cursor
    // reads nothing from; leaving it would mean setup+uninstall created a file.
    expect(removed.config).toEqual({});
  });

  it("reports nothing to remove when none of ours is registered", () => {
    const existing = { version: 1, hooks: { preToolUse: [{ command: "./scripts/audit.sh" }] } };
    const removed = removeCursorHookRegistration({ existing, identifies: OURS });
    expect(removed.changed).toBe(false);
    expect(removed.config).toEqual(existing);
  });

  it("removes only the named events when the caller restricts them", () => {
    const merged = merge(undefined, { events: ["preToolUse", "stop"] });
    const removed = removeCursorHookRegistration({
      existing: merged.config,
      events: ["stop"],
      identifies: OURS,
    });
    expect(Object.keys(removed.config.hooks as Record<string, unknown>)).toEqual(["preToolUse"]);
  });
});

describe("cursor registration: reading and refusing", () => {
  it("reports the managed command per event", () => {
    const merged = merge(undefined, { events: ["preToolUse", "stop"] });
    const found = readCursorHookRegistrations(merged.config, OURS);
    expect([...found.keys()].sort()).toEqual(["preToolUse", "stop"]);
    expect(found.get("stop")).toEqual([COMMAND]);
  });

  it("refuses a document whose hooks value is not the documented shape", () => {
    const planner = findRegistrationPlanner("cursor");
    expect(planner).toBeDefined();
    for (const existing of [{ hooks: [] }, { hooks: "nope" }, { hooks: { preToolUse: 3 } }]) {
      const result = planner?.merge({ existing, command: COMMAND, identifies: OURS });
      expect(result?.conflicts.length, JSON.stringify(existing)).toBeGreaterThan(0);
      // Refusing means the document is handed back untouched.
      expect(result?.changed).toBe(false);
      expect(result?.document).toEqual(existing);
    }
  });
});

describe("cursor registration: which events, and why not the others", () => {
  it("registers only events the adapter turns into telemetry", () => {
    for (const event of CURSOR_REGISTRABLE_HOOK_EVENTS) {
      expect(CURSOR_HOOK_EVENTS_MODELLED, event).toContain(event);
    }
  });

  it("gives a reason for every documented event it does not register", () => {
    const documented = [
      ...CURSOR_HOOK_EVENTS_MODELLED,
      ...Object.keys(CURSOR_UNMODELLED_HOOK_EVENT_NAMES),
    ];
    for (const event of documented) {
      if (CURSOR_REGISTRABLE_HOOK_EVENTS.includes(event as never)) {
        continue;
      }
      expect(CURSOR_UNREGISTERED_HOOK_EVENTS[event], event).toBeDefined();
      expect(CURSOR_UNREGISTERED_HOOK_EVENTS[event]?.length ?? 0, event).toBeGreaterThan(20);
    }
  });

  it("excludes the shell and MCP pairs, because one call fires both hook pairs", () => {
    for (const event of [
      "beforeShellExecution",
      "afterShellExecution",
      "beforeMCPExecution",
      "afterMCPExecution",
    ]) {
      expect(CURSOR_REGISTRABLE_HOOK_EVENTS as readonly string[], event).not.toContain(event);
      expect(CURSOR_UNREGISTERED_HOOK_EVENTS[event], event).toMatch(/duplicat|ToolUse/);
    }
  });

  it("excludes afterAgentResponse, because stop reports the same generation", () => {
    expect(CURSOR_REGISTRABLE_HOOK_EVENTS as readonly string[]).not.toContain("afterAgentResponse");
    expect(CURSOR_REGISTRABLE_HOOK_EVENTS).toContain("stop");
    expect(CURSOR_UNREGISTERED_HOOK_EVENTS.afterAgentResponse).toContain("double-count");
  });
});

describe("cursor registration: where the document lives", () => {
  it("resolves the two documented user and project locations", () => {
    const roots = { homeDir: "/home-root", projectDir: "/project-root" };
    expect(resolveInstallPath(findInstallLocation("cursor", "global")!, roots)).toBe(
      "/home-root/.cursor/hooks.json",
    );
    expect(resolveInstallPath(findInstallLocation("cursor", "project")!, roots)).toBe(
      "/project-root/.cursor/hooks.json",
    );
  });

  it("cites the source for each scope, and does not offer the MDM-owned ones", () => {
    for (const scope of ["global", "project"] as const) {
      const location = findInstallLocation("cursor", scope);
      expect(location?.evidence, scope).toContain("cursor.com/docs/agent/hooks");
      expect(location?.segments.join("/"), scope).toBe(".cursor/hooks.json");
    }
  });
});
