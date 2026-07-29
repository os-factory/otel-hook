import { describe, expect, it } from "vitest";

import {
  CLAUDE_HOOK_EVENTS_MODELLED,
  CLAUDE_REGISTRABLE_HOOK_EVENTS,
  CLAUDE_UNREGISTERED_HOOK_EVENTS,
  CODEX_HOOK_EVENTS_MODELLED,
  CODEX_REGISTRABLE_HOOK_EVENTS,
  CODEX_UNREGISTERED_HOOK_EVENTS,
  findRegistrationPlanner,
  findRegistrationSupport,
  managedHookPredicate,
  planProviderRegistration,
  PROVIDER_REGISTRATION_SUPPORT,
  readCodexHooksFeatureFlag,
  SUPPORTED_REGISTRATION_PROVIDER_IDS,
} from "../../src/install/index.js";
import { PROVIDER_DESCRIPTORS } from "../../src/providers/defaults.js";
import { GEMINI_HOOK_EVENT_NAMES } from "../../src/providers/gemini/schema.js";
import {
  GEMINI_REGISTRABLE_HOOK_EVENTS,
  GEMINI_UNREGISTERED_HOOK_EVENTS,
} from "../../src/providers/gemini/setup.js";

const OURS = managedHookPredicate("otel-hook");

describe("provider registration support", () => {
  it("states support (or the reason for its absence) for every registered provider", () => {
    expect(PROVIDER_REGISTRATION_SUPPORT.map((entry) => entry.providerId).sort()).toEqual(
      PROVIDER_DESCRIPTORS.map((descriptor) => descriptor.id).sort(),
    );
    for (const entry of PROVIDER_REGISTRATION_SUPPORT) {
      expect(entry.reason.length, entry.providerId).toBeGreaterThan(0);
      if (entry.supported) {
        expect(entry.helper, entry.providerId).toBeDefined();
        expect(findRegistrationPlanner(entry.providerId), entry.providerId).toBeDefined();
      } else {
        // An unsupported provider must say precisely what would unblock it, or
        // the refusal is indistinguishable from an oversight.
        expect(entry.evidenceBlocker, entry.providerId).toBeDefined();
        expect(findRegistrationPlanner(entry.providerId), entry.providerId).toBeUndefined();
      }
    }
  });

  it("offers planners for every provider whose contract is verified", () => {
    expect([...SUPPORTED_REGISTRATION_PROVIDER_IDS].sort()).toEqual([
      "antigravity",
      "claude-code",
      "codex",
      "cursor",
      "gemini-cli",
    ]);
  });

  it("supports cursor and cites both halves of the contract, config and payload", () => {
    const support = findRegistrationSupport("cursor");
    expect(support?.supported).toBe(true);
    expect(support?.evidenceBlocker).toBeUndefined();
    // The reason has to establish *both* halves: the document shape was verified
    // first, and the payload contract is what took a capture to settle.
    expect(support?.reason).toContain("cursor.com/docs/agent/hooks");
    expect(support?.reason).toContain("capture");
    expect(support?.reason).not.toContain("synthetic");

    const result = planProviderRegistration({
      providerId: "cursor",
      options: { command: "otel-hook run --provider cursor" },
    });
    expect(result.status).toBe("planned");
    if (result.status === "planned") {
      expect(result.document).toMatchObject({ version: 1 });
      expect(result.changed).toBe(true);
    }
  });

  it("reports an unknown provider as unsupported rather than throwing", () => {
    expect(planProviderRegistration({ providerId: "made-up", options: {} }).status).toBe(
      "unsupported",
    );
  });

  it("rejects a supported provider with no command instead of writing an empty one", () => {
    const result = planProviderRegistration({ providerId: "claude-code", options: {} });
    expect(result.status).toBe("invalid");
  });
});

describe("registrable event sets", () => {
  it("registers only Claude Code events the adapter turns into telemetry", () => {
    for (const event of CLAUDE_REGISTRABLE_HOOK_EVENTS) {
      expect(CLAUDE_HOOK_EVENTS_MODELLED, event).toContain(event);
    }
    const skipped = CLAUDE_HOOK_EVENTS_MODELLED.filter(
      (event) => !CLAUDE_REGISTRABLE_HOOK_EVENTS.includes(event),
    );
    expect(skipped.sort()).toEqual(["PermissionRequest", "PreCompact"]);
    for (const event of skipped) {
      expect(CLAUDE_UNREGISTERED_HOOK_EVENTS[event], event).toBeDefined();
    }
  });

  it("never registers a Codex event the adapter would reject", () => {
    for (const event of CODEX_REGISTRABLE_HOOK_EVENTS) {
      expect(CODEX_HOOK_EVENTS_MODELLED, event).toContain(event);
    }
    // Codex documents SessionEnd; this adapter deliberately does not model it,
    // so it must be excluded and the exclusion must be explained.
    expect(CODEX_REGISTRABLE_HOOK_EVENTS).not.toContain("SessionEnd");
    expect(CODEX_UNREGISTERED_HOOK_EVENTS.SessionEnd).toContain("not modelled");
    expect(CODEX_UNREGISTERED_HOOK_EVENTS.PermissionRequest).toBeDefined();
  });

  it("registers only Gemini CLI events the adapter turns into telemetry", () => {
    for (const event of GEMINI_REGISTRABLE_HOOK_EVENTS) {
      expect(GEMINI_HOOK_EVENT_NAMES, event).toContain(event);
    }
    const skipped = GEMINI_HOOK_EVENT_NAMES.filter(
      (event) => !GEMINI_REGISTRABLE_HOOK_EVENTS.includes(event),
    );
    // AfterModel fires once per streaming chunk, so this set is the difference
    // between a process per chunk that emits telemetry and one that emits none.
    expect([...skipped].sort()).toEqual(["AfterAgent", "BeforeToolSelection", "Notification"]);
    for (const event of skipped) {
      expect(GEMINI_UNREGISTERED_HOOK_EVENTS[event], event).toBeDefined();
    }
  });
});

describe("timeout units per vocabulary", () => {
  const firstHandler = (document: Record<string, unknown>, event: string): Record<string, unknown> => {
    const hooks = document.hooks as Record<string, readonly { hooks: Record<string, unknown>[] }[]>;
    return hooks[event]?.[0]?.hooks?.[0] ?? {};
  };

  it("writes seconds for Claude Code and the Codex CLI, milliseconds for the Gemini CLI", () => {
    // Claude Code and the Codex CLI document `timeout` in seconds; the Gemini
    // CLI documents milliseconds (default 60000) and passes the value straight
    // to setTimeout. One `--timeout-seconds 30` therefore has to be written two
    // different ways, or the Gemini hook is killed after 30ms.
    const claude = planProviderRegistration({
      providerId: "claude-code",
      options: { command: "otel-hook run", timeoutSeconds: 30 },
    });
    const codex = planProviderRegistration({
      providerId: "codex",
      options: { command: "otel-hook run", timeoutSeconds: 30 },
    });
    const gemini = planProviderRegistration({
      providerId: "gemini-cli",
      options: { command: "otel-hook run", timeoutSeconds: 30 },
    });

    expect(claude.status).toBe("planned");
    expect(codex.status).toBe("planned");
    expect(gemini.status).toBe("planned");
    if (claude.status !== "planned" || codex.status !== "planned" || gemini.status !== "planned") {
      return;
    }
    expect(firstHandler(claude.document, "SessionStart").timeout).toBe(30);
    expect(firstHandler(codex.document, "SessionStart").timeout).toBe(30);
    expect(firstHandler(gemini.document, "SessionStart").timeout).toBe(30_000);
  });
});

describe("planProviderRegistration", () => {
  const cases = [
    { providerId: "claude-code", command: "otel-hook run --provider claude-code" },
    { providerId: "codex", command: "otel-hook run --provider codex" },
    { providerId: "gemini-cli", command: "otel-hook run --provider gemini-cli" },
    { providerId: "antigravity", command: "otel-hook run --provider antigravity" },
  ] as const;

  for (const { providerId, command } of cases) {
    it(`plans a ${providerId} registration and is a no-op the second time`, () => {
      const first = planProviderRegistration({ providerId, options: { command } });
      expect(first.status, providerId).toBe("planned");
      if (first.status !== "planned") {
        return;
      }
      expect(first.changed).toBe(true);
      expect(first.changes.every((change) => change.action === "added")).toBe(true);

      const second = planProviderRegistration({
        providerId,
        existing: first.document,
        options: { command },
      });
      expect(second.status).toBe("planned");
      if (second.status !== "planned") {
        return;
      }
      expect(second.changed).toBe(false);
      expect(second.document).toEqual(first.document);
    });

    it(`preserves unrelated ${providerId} configuration`, () => {
      const existing = { unrelated: { keep: true } };
      const snapshot = structuredClone(existing);

      const result = planProviderRegistration({ providerId, existing, options: { command } });

      expect(existing, providerId).toEqual(snapshot);
      if (result.status === "planned") {
        expect(result.document.unrelated).toEqual({ keep: true });
      }
    });

    it(`refuses a malformed ${providerId} document rather than replacing it`, () => {
      const existing = { hooks: "everything", keep: 1 };
      const result = planProviderRegistration({ providerId, existing, options: { command } });

      expect(result.status, providerId).toBe("conflict");
    });
  }

  it("writes the Claude Code document shape the reference documents", () => {
    const result = planProviderRegistration({
      providerId: "claude-code",
      options: { command: "otel-hook run --provider claude-code", events: ["PreToolUse"], timeoutSeconds: 30 },
    });

    expect(result.status).toBe("planned");
    if (result.status !== "planned") {
      return;
    }
    expect(result.document).toEqual({
      hooks: {
        PreToolUse: [
          { hooks: [{ type: "command", command: "otel-hook run --provider claude-code", timeout: 30 }] },
        ],
      },
    });
  });

  it("writes the Codex hooks.json shape the reference documents", () => {
    const result = planProviderRegistration({
      providerId: "codex",
      options: { command: "otel-hook run --provider codex", events: ["SessionStart"], matcher: "startup|resume" },
    });

    expect(result.status).toBe("planned");
    if (result.status !== "planned") {
      return;
    }
    expect(result.document).toEqual({
      hooks: {
        SessionStart: [
          { matcher: "startup|resume", hooks: [{ type: "command", command: "otel-hook run --provider codex" }] },
        ],
      },
    });
  });

  it("preserves another tool's Gemini hooks and appends after them", () => {
    const existing = {
      theme: "dark",
      hooks: {
        BeforeTool: [{ matcher: "*", hooks: [{ name: "someone-else", type: "command", command: "other" }] }],
      },
    };
    const result = planProviderRegistration({
      providerId: "gemini-cli",
      existing,
      options: { name: "otel-hook", command: "otel-hook run --provider gemini-cli" },
    });

    expect(result.status).toBe("planned");
    if (result.status !== "planned") {
      return;
    }
    expect(result.document.theme).toBe("dark");
    const hooks = result.document.hooks as Record<string, readonly { hooks: readonly { name: string }[] }[]>;
    expect(hooks.BeforeTool?.[0]?.hooks.map((hook) => hook.name)).toEqual(["someone-else", "otel-hook"]);
  });

  it("plans an Antigravity registration only for the requested events", () => {
    const result = planProviderRegistration({
      providerId: "antigravity",
      options: { command: "otel-hook run --provider antigravity", events: ["PreToolUse", "PostToolUse"] },
    });

    expect(result.status).toBe("planned");
    if (result.status !== "planned") {
      return;
    }
    expect(Object.keys(result.document.hooks as Record<string, unknown>).sort()).toEqual([
      "PostToolUse",
      "PreToolUse",
    ]);
  });
});

describe("upgrade across a changed command", () => {
  const cases = ["claude-code", "codex", "gemini-cli", "antigravity"] as const;

  for (const providerId of cases) {
    it(`rewrites the ${providerId} registration instead of adding a second one`, () => {
      const first = planProviderRegistration({
        providerId,
        options: { command: "otel-hook run --provider x", identifies: OURS },
      });
      expect(first.status).toBe("planned");
      if (first.status !== "planned") {
        return;
      }

      const upgraded = planProviderRegistration({
        providerId,
        existing: first.document,
        options: { command: "/opt/bin/otel-hook run --provider x", identifies: OURS },
      });
      expect(upgraded.status).toBe("planned");
      if (upgraded.status !== "planned") {
        return;
      }

      expect(upgraded.changed).toBe(true);
      const planner = findRegistrationPlanner(providerId);
      const registrations = planner?.read(upgraded.document, OURS);
      for (const [event, commands] of registrations ?? []) {
        expect(commands, event).toEqual(["/opt/bin/otel-hook run --provider x"]);
      }
    });
  }
});

describe("readCodexHooksFeatureFlag", () => {
  it("detects the documented opt-out and nothing else", () => {
    expect(readCodexHooksFeatureFlag("[features]\nhooks = false\n")).toBe("disabled");
    expect(readCodexHooksFeatureFlag("[features]\nhooks = true\n")).toBe("enabled");
    expect(readCodexHooksFeatureFlag("[features]\nhooks = false # off for now\n")).toBe("disabled");
  });

  it("defaults to unset — Codex's own default — for anything it cannot interpret", () => {
    expect(readCodexHooksFeatureFlag("")).toBe("unset");
    expect(readCodexHooksFeatureFlag("[other]\nhooks = false\n")).toBe("unset");
    expect(readCodexHooksFeatureFlag("[features]\n# hooks = false\n")).toBe("unset");
    expect(readCodexHooksFeatureFlag("[features]\nhooks = maybe\n")).toBe("unset");
    // A `hooks` key in a later table must not be read as the features one.
    expect(readCodexHooksFeatureFlag("[features]\nweb = true\n\n[tui]\nhooks = false\n")).toBe("unset");
  });
});
