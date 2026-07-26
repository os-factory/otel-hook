import { describe, expect, it } from "vitest";

import {
  mergeNestedHookRegistration,
  readNestedHookRegistrations,
  removeNestedHookRegistrations,
  type HookHandlerPredicate,
} from "../../src/providers/hook-document.js";

/**
 * The merge engine shared by Claude Code, the Codex CLI, and the Gemini CLI.
 *
 * These are the properties every provider's planner inherits, asserted once
 * here rather than five times over: repeated setup, upgrade, uninstall,
 * preservation of a document we do not own, and a refusal to guess when the
 * document is not the shape the provider documents.
 */

const OURS: HookHandlerPredicate = (handler) =>
  typeof handler.command === "string" && handler.command.includes("otel-hook");

const ENTRY = { type: "command", command: "otel-hook run --provider claude-code" } as const;
const EVENTS = ["PreToolUse", "PostToolUse"] as const;

const merge = (existing: unknown, overrides: Record<string, unknown> = {}) =>
  mergeNestedHookRegistration({
    existing,
    events: EVENTS,
    entry: ENTRY,
    identifies: OURS,
    ...overrides,
  });

describe("nested hook document merge", () => {
  it("creates the whole structure when nothing exists", () => {
    const result = merge(undefined);

    expect(result.changed).toBe(true);
    expect(result.changes).toEqual([
      { event: "PreToolUse", action: "added" },
      { event: "PostToolUse", action: "added" },
    ]);
    expect(result.document).toEqual({
      hooks: {
        PreToolUse: [{ hooks: [ENTRY] }],
        PostToolUse: [{ hooks: [ENTRY] }],
      },
    });
  });

  it("writes no matcher key by default, which both vocabularies define as matching everything", () => {
    const groups = merge(undefined).document.hooks as Record<string, readonly Record<string, unknown>[]>;
    expect(groups.PreToolUse?.[0]).not.toHaveProperty("matcher");
  });

  it("is a byte-for-byte no-op the second, third, and fourth time (repeated setup)", () => {
    let document: unknown = { editorTheme: "dark" };
    const first = merge(document);
    document = first.document;

    for (let run = 0; run < 3; run += 1) {
      const again = merge(document);
      expect(again.changed).toBe(false);
      expect(again.changes.every((change) => change.action === "unchanged")).toBe(true);
      expect(again.document).toEqual(first.document);
      document = again.document;
    }
  });

  it("rewrites its own entry in place when the command changes (upgrade)", () => {
    const installed = merge(undefined).document;
    const upgraded = merge(installed, {
      entry: { type: "command", command: "/opt/otel-hook/bin/otel-hook run --provider claude-code", timeout: 30 },
    });

    expect(upgraded.changed).toBe(true);
    expect(upgraded.changes).toEqual([
      { event: "PreToolUse", action: "updated" },
      { event: "PostToolUse", action: "updated" },
    ]);
    const hooks = upgraded.document.hooks as Record<string, readonly { hooks: readonly unknown[] }[]>;
    expect(hooks.PreToolUse?.[0]?.hooks).toEqual([
      { type: "command", command: "/opt/otel-hook/bin/otel-hook run --provider claude-code", timeout: 30 },
    ]);
  });

  it("moves its own entry when the requested matcher changes rather than firing twice", () => {
    const installed = merge(undefined, { matcher: "Bash" }).document;
    const remerged = merge(installed, { matcher: "Edit|Write" });

    const hooks = remerged.document.hooks as Record<string, readonly Record<string, unknown>[]>;
    expect(hooks.PreToolUse).toEqual([{ matcher: "Edit|Write", hooks: [ENTRY] }]);
  });

  it("collapses duplicate registrations of itself into one", () => {
    const existing = {
      hooks: {
        PreToolUse: [
          { hooks: [ENTRY, { ...ENTRY, timeout: 5 }] },
          { matcher: "Bash", hooks: [{ ...ENTRY, timeout: 9 }] },
        ],
        PostToolUse: [{ hooks: [ENTRY] }],
      },
    };

    const result = merge(existing);
    const registrations = readNestedHookRegistrations(result.document, OURS);
    expect(registrations.get("PreToolUse")).toHaveLength(1);
    expect(registrations.get("PostToolUse")).toHaveLength(1);
  });

  it("leaves other tools' handlers, their matchers, and unrelated keys untouched", () => {
    const existing = {
      editorTheme: "dark",
      permissions: { allow: ["Bash(git *)"] },
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./lint.sh" }] }],
        SessionEnd: [{ hooks: [{ type: "command", command: "./teardown.sh" }] }],
      },
    };
    const snapshot = structuredClone(existing);

    const result = merge(existing);

    expect(existing).toEqual(snapshot);
    expect(result.document.editorTheme).toBe("dark");
    expect(result.document.permissions).toEqual({ allow: ["Bash(git *)"] });
    const hooks = result.document.hooks as Record<string, readonly Record<string, unknown>[]>;
    expect(hooks.SessionEnd).toEqual(snapshot.hooks.SessionEnd);
    expect(hooks.PreToolUse).toEqual([
      { matcher: "Bash", hooks: [{ type: "command", command: "./lint.sh" }] },
      { hooks: [ENTRY] },
    ]);
  });

  it("treats an absent matcher, \"\", and \"*\" as the same group", () => {
    for (const matcher of ["", "*"]) {
      const existing = { hooks: { PreToolUse: [{ matcher, hooks: [{ type: "command", command: "./other.sh" }] }] } };
      const result = mergeNestedHookRegistration({
        existing,
        events: ["PreToolUse"],
        entry: ENTRY,
        identifies: OURS,
      });
      const hooks = result.document.hooks as Record<string, readonly { hooks: readonly unknown[] }[]>;
      expect(hooks.PreToolUse, matcher).toHaveLength(1);
      expect(hooks.PreToolUse?.[0]?.hooks).toHaveLength(2);
    }
  });

  it("refuses to touch a document whose hooks value is not an object", () => {
    for (const hooks of [["PreToolUse"], "enabled", null, 3]) {
      const existing = { keep: true, hooks };
      const result = merge(existing);

      expect(result.changed, JSON.stringify(hooks)).toBe(false);
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]?.location).toBe("hooks");
      expect(result.document).toEqual(existing);
    }
  });

  it("refuses to touch a document whose event value is not an array", () => {
    const existing = { hooks: { PreToolUse: { matcher: "*" } } };
    const result = merge(existing);

    expect(result.changed).toBe(false);
    expect(result.conflicts.map((conflict) => conflict.location)).toEqual(["hooks.PreToolUse"]);
    expect(result.document).toEqual(existing);
  });
});

describe("nested hook document removal", () => {
  it("restores the original document exactly (setup then uninstall is reversible)", () => {
    for (const original of [
      {},
      { editorTheme: "dark" },
      { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./lint.sh" }] }] } },
      { hooks: { SessionEnd: [{ hooks: [{ type: "command", command: "./teardown.sh" }] }] }, other: 1 },
    ]) {
      const installed = merge(structuredClone(original)).document;
      const removed = removeNestedHookRegistrations({ existing: installed, identifies: OURS });

      expect(removed.changed, JSON.stringify(original)).toBe(true);
      expect(removed.document, JSON.stringify(original)).toEqual(original);
    }
  });

  it("is a no-op when nothing of ours is registered", () => {
    const existing = { hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "./lint.sh" }] }] } };
    const removed = removeNestedHookRegistrations({ existing, identifies: OURS });

    expect(removed.changed).toBe(false);
    expect(removed.changes).toEqual([]);
    expect(removed.document).toEqual(existing);
  });

  it("removes from events the caller never named, so a narrowed setup still cleans up fully", () => {
    const installed = mergeNestedHookRegistration({
      events: ["PreToolUse", "PostToolUse", "Stop"],
      entry: ENTRY,
      identifies: OURS,
    }).document;

    const removed = removeNestedHookRegistrations({ existing: installed, identifies: OURS });

    expect(removed.document).toEqual({});
    expect(removed.changes.map((change) => change.event).sort()).toEqual([
      "PostToolUse",
      "PreToolUse",
      "Stop",
    ]);
  });

  it("keeps other tools' handlers and only prunes the structure it emptied", () => {
    const existing = {
      hooks: {
        PreToolUse: [{ hooks: [{ type: "command", command: "./lint.sh" }, ENTRY] }],
        Stop: [{ hooks: [ENTRY] }],
      },
    };

    const removed = removeNestedHookRegistrations({ existing, identifies: OURS });

    expect(removed.document).toEqual({
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "./lint.sh" }] }] },
    });
  });

  it("refuses to touch a malformed document rather than dropping what it cannot read", () => {
    const existing = { hooks: { PreToolUse: "otel-hook run" } };
    const removed = removeNestedHookRegistrations({ existing, identifies: OURS });

    expect(removed.changed).toBe(false);
    expect(removed.conflicts).toHaveLength(1);
    expect(removed.document).toEqual(existing);
  });
});
