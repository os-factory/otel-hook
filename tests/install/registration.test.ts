import { describe, expect, it } from "vitest";

import {
  findRegistrationSupport,
  planProviderRegistration,
  PROVIDER_REGISTRATION_SUPPORT,
} from "../../src/install/index.js";
import { PROVIDER_DESCRIPTORS } from "../../src/providers/defaults.js";

describe("provider registration planners", () => {
  it("states support (or the reason for its absence) for every registered provider", () => {
    expect(PROVIDER_REGISTRATION_SUPPORT.map((entry) => entry.providerId).sort()).toEqual(
      PROVIDER_DESCRIPTORS.map((descriptor) => descriptor.id).sort(),
    );
    for (const entry of PROVIDER_REGISTRATION_SUPPORT) {
      expect(entry.reason.length, entry.providerId).toBeGreaterThan(0);
      if (entry.supported) {
        expect(entry.helper, entry.providerId).toBeDefined();
      }
    }
  });

  it("refuses to plan a registration for a provider whose config contract is unverified", () => {
    for (const providerId of ["claude-code", "codex", "cursor"]) {
      const result = planProviderRegistration({ providerId, options: {} });
      expect(result.status, providerId).toBe("unsupported");
      if (result.status === "unsupported") {
        expect(result.reason, providerId).toBe(findRegistrationSupport(providerId)?.reason);
      }
    }
  });

  it("reports an unknown provider as unsupported rather than throwing", () => {
    const result = planProviderRegistration({ providerId: "made-up", options: {} });
    expect(result.status).toBe("unsupported");
  });

  it("plans a Gemini CLI registration and is a no-op the second time", () => {
    const options = { name: "otel-hook", command: "otel-hook run --provider gemini-cli" } as const;

    const first = planProviderRegistration({ providerId: "gemini-cli", options });
    expect(first.status).toBe("planned");
    if (first.status !== "planned") {
      return;
    }
    expect(first.changed).toBe(true);

    const second = planProviderRegistration({
      providerId: "gemini-cli",
      existing: first.document,
      options,
    });
    expect(second.status).toBe("planned");
    if (second.status !== "planned") {
      return;
    }
    expect(second.changed).toBe(false);
    expect(second.document).toEqual(first.document);
  });

  it("preserves unrelated Gemini settings and other tools' hooks", () => {
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
    const beforeTool = hooks.BeforeTool?.[0]?.hooks.map((hook) => hook.name);
    expect(beforeTool).toEqual(["someone-else", "otel-hook"]);
  });

  it("plans an Antigravity registration idempotently and only for the requested events", () => {
    const options = {
      command: "otel-hook run --provider antigravity",
      events: ["PreToolUse", "PostToolUse"],
    } as const;

    const first = planProviderRegistration({ providerId: "antigravity", options });
    expect(first.status).toBe("planned");
    if (first.status !== "planned") {
      return;
    }
    const hooks = first.document.hooks as Record<string, readonly unknown[]>;
    expect(Object.keys(hooks).sort()).toEqual(["PostToolUse", "PreToolUse"]);

    const second = planProviderRegistration({
      providerId: "antigravity",
      existing: first.document,
      options,
    });
    expect(second.status).toBe("planned");
    if (second.status === "planned") {
      expect(second.changed).toBe(false);
      expect(second.document).toEqual(first.document);
    }
  });

  it("never mutates the document it was given", () => {
    const existing = { hooks: { PreToolUse: [{ command: "other" }] }, unrelated: { keep: true } };
    const snapshot = JSON.parse(JSON.stringify(existing)) as unknown;

    planProviderRegistration({
      providerId: "antigravity",
      existing,
      options: { command: "otel-hook run --provider antigravity" },
    });

    expect(existing).toEqual(snapshot);
  });
});
