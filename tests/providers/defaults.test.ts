import { describe, expect, it } from "vitest";

import {
  createDefaultProviderRegistry,
  describeProviderCatalog,
  EXPERIMENTAL_PROVIDER_IDS,
  findProviderDescriptor,
  isExperimentalProvider,
  PROVIDER_DESCRIPTORS,
} from "../../src/providers/defaults.js";
import { BUILT_IN_PROVIDERS } from "../../src/providers/registry.js";
import { createFixtureAdapter } from "../../src/testing/fixture-adapter.js";

describe("default provider registry", () => {
  it("registers all five adapters, alphabetically and without duplicates", () => {
    const ids = createDefaultProviderRegistry().adapters.map((adapter) => adapter.id);
    expect(ids).toEqual(["antigravity", "claude-code", "codex", "cursor", "gemini-cli"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps the core's own built-in list empty so the core stays provider-free", () => {
    // Provider support arrives through createDefaultProviderRegistry, never by
    // mutating a shared constant the core depends on.
    expect(BUILT_IN_PROVIDERS).toEqual([]);
  });

  it("returns a fresh registry and fresh adapters on every call", () => {
    const first = createDefaultProviderRegistry();
    const second = createDefaultProviderRegistry();
    expect(first).not.toBe(second);
    expect(first.adapters[0]).not.toBe(second.adapters[0]);
  });

  it("marks Antigravity — and only Antigravity — as experimental", () => {
    expect(EXPERIMENTAL_PROVIDER_IDS).toEqual(["antigravity"]);
    expect(isExperimentalProvider("antigravity")).toBe(true);
    expect(isExperimentalProvider("claude-code")).toBe(false);
    expect(findProviderDescriptor("antigravity")?.promotionGates.length).toBeGreaterThan(0);
    for (const descriptor of PROVIDER_DESCRIPTORS.filter((entry) => entry.maturity === "stable")) {
      expect(descriptor.promotionGates, descriptor.id).toEqual([]);
    }
  });

  it("omits experimental adapters on request", () => {
    const ids = createDefaultProviderRegistry({ includeExperimental: false }).adapters.map(
      (adapter) => adapter.id,
    );
    expect(ids).not.toContain("antigravity");
    expect(ids).toHaveLength(PROVIDER_DESCRIPTORS.length - 1);
  });

  it("restricts to named providers and accepts a host's own adapter", () => {
    const restricted = createDefaultProviderRegistry({ only: ["cursor", "codex"] });
    expect(restricted.adapters.map((adapter) => adapter.id)).toEqual(["codex", "cursor"]);

    const extended = createDefaultProviderRegistry({
      only: ["cursor"],
      additional: [createFixtureAdapter({ id: "acme-agent" })],
    });
    expect(extended.adapters.map((adapter) => adapter.id)).toEqual(["cursor", "acme-agent"]);
    expect(extended.get("acme-agent")).toBeDefined();
  });

  it("rejects a duplicate adapter id rather than silently shadowing one", () => {
    const [cursor] = createDefaultProviderRegistry({ only: ["cursor"] }).adapters;
    expect(cursor).toBeDefined();
    expect(() => createDefaultProviderRegistry({ additional: [cursor!] })).toThrow(
      /duplicate provider adapter id/,
    );
  });

  it("describes each adapter's declared capabilities without probing them", () => {
    const catalog = describeProviderCatalog();
    expect(catalog.map((entry) => entry.id)).toEqual(
      PROVIDER_DESCRIPTORS.map((descriptor) => descriptor.id),
    );

    const cursor = catalog.find((entry) => entry.id === "cursor");
    // Cursor reports a cache-read subset of its input tokens but documents no
    // accounting for cache writes, and the catalog must draw that line: "not
    // reported" and "zero" are indistinguishable in the data.
    expect(cursor?.reportsCachedInput).toBe(true);
    expect(cursor?.cacheCreationAccounting).toBe("not-reported");
    expect(cursor?.requiresHookResponse).toBe(true);
    // subagentStop carries no subagent id to pair with subagentStart.
    expect(cursor?.lifecycleEvents).not.toContain("subagent.start");

    const codex = catalog.find((entry) => entry.id === "codex");
    expect(codex?.usageTemporality).toBe("cumulative");
    expect(codex?.reportsReasoningOutput).toBe(true);
    // Codex has no dependable session end, so session.end must be absent.
    expect(codex?.lifecycleEvents).not.toContain("session.end");

    const antigravity = catalog.find((entry) => entry.id === "antigravity");
    // The experimental adapter claims only what it can honestly observe.
    expect(antigravity?.lifecycleEvents).toEqual(["tool.start", "tool.end"]);
  });

  it("declares only lifecycle events the canonical model defines", () => {
    const known = new Set([
      "session.start",
      "session.end",
      "prompt.submitted",
      "generation.start",
      "generation.end",
      "tool.start",
      "tool.end",
      "subagent.start",
      "subagent.end",
      "compaction.performed",
      "error.raised",
    ]);
    for (const entry of describeProviderCatalog()) {
      for (const event of entry.lifecycleEvents) {
        expect(known.has(event), `${entry.id}:${event}`).toBe(true);
      }
    }
  });
});
