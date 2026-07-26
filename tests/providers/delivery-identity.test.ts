import { describe, expect, it } from "vitest";

import { DEFAULT_PRIVACY_POLICY } from "../../src/privacy/policy.js";
import { createPrivacyService } from "../../src/privacy/service.js";
import {
  DELIVERY_COMPONENT_PATTERN,
  providerDeliveryClaimSchema,
  readDeliveryClaim,
  type ProviderAdapter,
  type ProviderContext,
  type ProviderDeliveryClaim,
} from "../../src/providers/adapter.js";
import { createDefaultProviderRegistry } from "../../src/providers/defaults.js";
import { createFixedClock } from "../../src/runtime/clock.js";
import { createDeterministicIdGenerator } from "../../src/runtime/ids.js";
import { createNullLogger } from "../../src/runtime/logger.js";
import { resolveDeliveryIdentity } from "../../src/runtime/delivery.js";
import { createFixtureAdapter } from "../../src/testing/index.js";

const context = (): ProviderContext => {
  const privacy = createPrivacyService(DEFAULT_PRIVACY_POLICY);
  return {
    privacy,
    clock: createFixedClock(),
    ids: createDeterministicIdGenerator(),
    logger: createNullLogger(),
    limits: privacy.policy.limits,
  };
};

const adapterFor = (providerId: string): ProviderAdapter => {
  const found = createDefaultProviderRegistry().get(providerId);
  if (found === undefined) {
    throw new Error(`no adapter registered for ${providerId}`);
  }
  return found;
};

/**
 * Ask an adapter for a delivery claim the way the core does: through the
 * containment helper, with a detection the adapter would have produced itself.
 */
const claimFor = (
  providerId: string,
  payload: unknown,
): ReturnType<typeof readDeliveryClaim> => {
  const adapter = adapterFor(providerId);
  const ctx = context();
  const detection = adapter.detect(
    { payload, transport: "hook-stdin", environment: {} },
    ctx,
  );
  return readDeliveryClaim(adapter, { payload, transport: "hook-stdin", environment: {}, detection }, ctx);
};

describe("delivery identity: the component guard", () => {
  it("accepts identifier-shaped values a real payload carries", () => {
    for (const value of [
      "tool-parity-claude-001",
      "turn_id.42",
      "mcp__github__search_issues",
      "2026-07-25T10:00:05.000Z",
      "0",
      "a+b=c@d",
    ]) {
      expect(DELIVERY_COMPONENT_PATTERN.test(value), value).toBe(true);
    }
  });

  it("rejects prose and filesystem paths, so content can never become an id", () => {
    for (const value of [
      "Explain what the parity harness fixture directory is for.",
      "/home/someone/private-repo",
      "/workspace/fixture-repo/README.md",
      '{"query":"synthetic fixture issue"}',
      "secret\nspanning lines",
      "a".repeat(257),
      "",
    ]) {
      expect(DELIVERY_COMPONENT_PATTERN.test(value), value).toBe(false);
    }
  });

  it("rejects a whole claim when any single component is not identifier-shaped", () => {
    const claim = {
      sessionId: "ses_1",
      sourceEventName: "PreToolUse",
      components: ["tool-1", "/home/someone/secret.txt"],
      evidence: ["fields named"],
    };
    expect(providerDeliveryClaimSchema.safeParse(claim).success).toBe(false);
  });

  it("caps how many components one identity may be built from", () => {
    expect(
      providerDeliveryClaimSchema.safeParse({
        sessionId: "ses_1",
        sourceEventName: "PreToolUse",
        components: Array.from({ length: 9 }, (_, index) => `c${String(index)}`),
        evidence: ["fields named"],
      }).success,
    ).toBe(false);
  });
});

describe("delivery identity: containment at the adapter boundary", () => {
  it("degrades a throwing deliveryIdentity to no-identity rather than failing", () => {
    const adapter = createFixtureAdapter({ throwOn: "deliveryIdentity" });
    const ctx = context();
    const payload = { provider: "fixture", sessionId: "ses_1", event: "tool", requestId: "req-1" };
    const detection = adapter.detect({ payload, transport: "hook-stdin", environment: {} }, ctx);

    const read = readDeliveryClaim(
      adapter,
      { payload, transport: "hook-stdin", environment: {}, detection },
      ctx,
    );
    expect(read.claim).toBeUndefined();
    expect(read.rejection).toContain("threw");
  });

  it("rejects an adapter that tries to seed an identity with prompt text", () => {
    const adapter = createFixtureAdapter({
      deliveryIdentity: (): ProviderDeliveryClaim => ({
        sessionId: "ses_1",
        sourceEventName: "prompt",
        components: ["the user's actual private prompt text"],
        evidence: ["not really evidence"],
      }),
    });
    const ctx = context();
    const payload = { provider: "fixture", sessionId: "ses_1", event: "prompt" };
    const detection = adapter.detect({ payload, transport: "hook-stdin", environment: {} }, ctx);

    const read = readDeliveryClaim(
      adapter,
      { payload, transport: "hook-stdin", environment: {}, detection },
      ctx,
    );
    expect(read.claim).toBeUndefined();
    expect(read.rejection).toContain("malformed delivery identity");
    // The rejection is a diagnostic: it must name the failure, never quote it.
    expect(read.rejection).not.toContain("private prompt text");
  });

  it("treats an adapter with no deliveryIdentity method as simply unidentifiable", () => {
    // `deliveryIdentity` is optional, so an adapter written before the contract
    // gained it must keep working rather than fail to compile or throw.
    const complete = createFixtureAdapter();
    const bare: ProviderAdapter = {
      id: complete.id,
      version: complete.version,
      capabilities: complete.capabilities,
      detect: (detectInput, detectContext) => complete.detect(detectInput, detectContext),
      identify: (identifyInput, identifyContext) => complete.identify(identifyInput, identifyContext),
      parse: (parseInput, parseContext) => complete.parse(parseInput, parseContext),
      hookResponse: (responseInput, responseContext) =>
        complete.hookResponse(responseInput, responseContext),
    };
    const ctx = context();
    const payload = { provider: "fixture", sessionId: "ses_1", event: "tool", requestId: "r1" };
    const detection = bare.detect({ payload, transport: "hook-stdin", environment: {} }, ctx);

    expect(
      readDeliveryClaim(bare, { payload, transport: "hook-stdin", environment: {}, detection }, ctx),
    ).toEqual({});
  });
});

describe("delivery identity: normalization is opaque and scoped", () => {
  const claim: ProviderDeliveryClaim = {
    sessionId: "sess-secret-looking-id",
    sourceEventName: "PostToolUse",
    components: ["tool-abc"],
    evidence: ["payload.tool_use_id names one tool call"],
  };

  it("never leaks a raw provider identifier into the scope or the callback id", () => {
    const identity = resolveDeliveryIdentity({
      ids: createDeterministicIdGenerator(),
      providerId: "claude-code",
      installationId: "install-1",
      claim,
    });

    const serialized = `${identity.scope} ${identity.callbackId}`;
    expect(serialized).not.toContain("sess-secret-looking-id");
    expect(serialized).not.toContain("tool-abc");
    expect(identity.callbackId).toMatch(/^[0-9a-f]{32}$/);
    expect(identity.origin).toBe("provider");
  });

  it("recomputes the identical identity in a later process, which is what survives a restart", () => {
    const first = resolveDeliveryIdentity({
      ids: createDeterministicIdGenerator(),
      providerId: "claude-code",
      installationId: "install-1",
      claim,
    });
    const second = resolveDeliveryIdentity({
      ids: createDeterministicIdGenerator(),
      providerId: "claude-code",
      installationId: "install-1",
      claim,
    });
    expect(second).toEqual(first);
  });

  it("separates sessions, installations, providers, and the two edges of one call", () => {
    const ids = createDeterministicIdGenerator();
    const base = { ids, providerId: "claude-code", installationId: "install-1", claim };
    const identity = resolveDeliveryIdentity(base);

    const otherSession = resolveDeliveryIdentity({
      ...base,
      claim: { ...claim, sessionId: "sess-other" },
    });
    const otherInstallation = resolveDeliveryIdentity({ ...base, installationId: "install-2" });
    const otherProvider = resolveDeliveryIdentity({ ...base, providerId: "codex" });
    const otherEdge = resolveDeliveryIdentity({
      ...base,
      claim: { ...claim, sourceEventName: "PreToolUse" },
    });

    expect(otherSession.scope).not.toBe(identity.scope);
    expect(otherSession.callbackId).not.toBe(identity.callbackId);
    expect(otherInstallation.scope).not.toBe(identity.scope);
    expect(otherProvider.callbackId).not.toBe(identity.callbackId);
    // Same tool_use_id, opposite edge: `PreToolUse` must not dedupe `PostToolUse`.
    expect(otherEdge.callbackId).not.toBe(identity.callbackId);
    expect(otherEdge.scope).toBe(identity.scope);
  });
});

describe("delivery identity: Claude Code", () => {
  const base = { session_id: "sess-1", cwd: "/workspace/demo" };

  it("identifies a tool call from tool_use_id, keeping the two edges distinct", () => {
    const pre = claimFor("claude-code", {
      ...base,
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/workspace/demo/README.md" },
      tool_use_id: "tool-1",
    });
    const post = claimFor("claude-code", {
      ...base,
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_response: { content: "synthetic" },
      tool_use_id: "tool-1",
    });

    expect(pre.claim?.components).toEqual(["tool-1"]);
    expect(post.claim?.components).toEqual(["tool-1"]);
    expect(post.claim?.sourceEventName).not.toBe(pre.claim?.sourceEventName);
  });

  it("identifies a subagent lifecycle edge from agent_id", () => {
    const claim = claimFor("claude-code", {
      ...base,
      hook_event_name: "SubagentStop",
      agent_type: "Explore",
      agent_id: "agent-7",
    }).claim;
    expect(claim?.components).toEqual(["agent-7"]);
  });

  it("identifies a prompt submission from prompt_id", () => {
    const claim = claimFor("claude-code", {
      ...base,
      hook_event_name: "UserPromptSubmit",
      prompt_id: "prompt-9",
      prompt: "a secret prompt nobody should see in an id",
    }).claim;
    expect(claim?.components).toEqual(["prompt-9"]);
    expect(JSON.stringify(claim)).not.toContain("secret prompt");
  });

  it("refuses to identify Stop, which can legitimately fire twice for one prompt", () => {
    expect(
      claimFor("claude-code", { ...base, hook_event_name: "Stop", prompt_id: "prompt-9" }).claim,
    ).toBeUndefined();
    expect(
      claimFor("claude-code", { ...base, hook_event_name: "SessionEnd", reason: "completed" }).claim,
    ).toBeUndefined();
    expect(
      claimFor("claude-code", { ...base, hook_event_name: "PostCompact", trigger: "automatic" })
        .claim,
    ).toBeUndefined();
  });

  it("refuses to identify a tool callback whose tool_use_id is missing", () => {
    expect(
      claimFor("claude-code", { ...base, hook_event_name: "PreToolUse", tool_name: "Read" }).claim,
    ).toBeUndefined();
  });
});

describe("delivery identity: Codex", () => {
  const base = { session_id: "sess-codex", cwd: "/workspace/demo" };

  it("identifies a tool call from tool_call_id and a turn edge from turn_id", () => {
    expect(
      claimFor("codex", {
        ...base,
        hook_event_name: "PostToolUse",
        tool_name: "shell",
        tool_call_id: "call-3",
        turn_id: "turn-1",
      }).claim?.components,
    ).toEqual(["call-3"]);
    expect(
      claimFor("codex", { ...base, hook_event_name: "Stop", turn_id: "turn-1" }).claim?.components,
    ).toEqual(["turn-1"]);
  });

  it("refuses tool_name as a substitute for tool_call_id", () => {
    // Two calls to the same tool in one turn would otherwise collapse into one
    // delivery, and the second one's telemetry would be silently dropped.
    expect(
      claimFor("codex", {
        ...base,
        hook_event_name: "PreToolUse",
        tool_name: "shell",
        turn_id: "turn-1",
      }).claim,
    ).toBeUndefined();
  });

  it("refuses to identify session and compaction callbacks", () => {
    expect(claimFor("codex", { ...base, hook_event_name: "SessionStart" }).claim).toBeUndefined();
    expect(
      claimFor("codex", { ...base, hook_event_name: "PreCompact", trigger: "auto" }).claim,
    ).toBeUndefined();
  });
});

describe("delivery identity: Cursor", () => {
  const base = { conversationId: "conv-1", timestampMillis: 1_700_000_000_000 };

  it("identifies a tool call, a generation edge, and the session edges", () => {
    expect(
      claimFor("cursor", {
        ...base,
        hookEventName: "afterToolUse",
        toolCallId: "call-9",
        toolName: "read_file",
      }).claim?.components,
    ).toEqual(["call-9"]);
    expect(
      claimFor("cursor", {
        ...base,
        hookEventName: "beforeSubmitPrompt",
        generationId: "gen-1",
        promptText: "cursor secret prompt",
      }).claim?.components,
    ).toEqual(["gen-1"]);
    expect(
      claimFor("cursor", { ...base, hookEventName: "sessionStart" }).claim?.components,
    ).toEqual(["sessionStart"]);
  });

  it("gives a legacy snake_case payload the same identity as its current-shape twin", () => {
    const current = claimFor("cursor", {
      ...base,
      hookEventName: "afterToolUse",
      toolCallId: "call-9",
      toolName: "read_file",
    }).claim;
    const legacy = claimFor("cursor", {
      conversation_id: "conv-1",
      timestamp_millis: 1_700_000_000_000,
      hook_event_name: "after_tool_use",
      tool_call_id: "call-9",
      tool_name: "read_file",
    }).claim;

    expect(legacy).toEqual(current);
  });

  it("refuses the callbacks whose only distinguishing field is a command or a path", () => {
    expect(
      claimFor("cursor", {
        ...base,
        hookEventName: "afterShellExecution",
        command: "npm run check",
      }).claim,
    ).toBeUndefined();
    expect(
      claimFor("cursor", {
        ...base,
        hookEventName: "beforeReadFile",
        filePath: "/home/someone/private.txt",
      }).claim,
    ).toBeUndefined();
    expect(
      claimFor("cursor", { ...base, hookEventName: "preCompact", trigger: "automatic" }).claim,
    ).toBeUndefined();
  });
});

describe("delivery identity: Gemini CLI", () => {
  const base = { session_id: "sess-gemini", cwd: "/workspace/demo" };

  it("refuses a tool callback: a timestamp plus a tool name is not unique", () => {
    const result = claimFor("gemini-cli", {
      ...base,
      hook_event_name: "BeforeTool",
      timestamp: "2026-07-25T10:00:06.000Z",
      tool_name: "read_file",
      tool_input: { path: "/home/someone/private.txt" },
    });

    // The Gemini protocol carries no tool-call id, so the only candidate identity
    // is (timestamp, tool_name) — and two calls to the same tool can share a
    // millisecond. Keying on that would suppress a genuine second call as if it
    // were a redelivery, losing its span and its usage. Under-reporting coverage
    // is recoverable; dropping a real observation is not.
    expect(result.claim).toBeUndefined();
    expect(result.rejection).toBeUndefined();
  });

  it("refuses both tool edges, not just the pre-edge", () => {
    expect(
      claimFor("gemini-cli", {
        ...base,
        hook_event_name: "AfterTool",
        timestamp: "2026-07-25T10:00:07.000Z",
        tool_name: "read_file",
        tool_response: { llmContent: "..." },
      }).claim,
    ).toBeUndefined();
  });

  it("refuses the per-turn callbacks, which only a millisecond separates", () => {
    for (const hookEventName of ["BeforeAgent", "AfterAgent", "PreCompress"]) {
      expect(
        claimFor("gemini-cli", {
          ...base,
          hook_event_name: hookEventName,
          timestamp: "2026-07-25T10:00:08.000Z",
        }).claim,
      ).toBeUndefined();
    }
  });

  it("refuses the session callbacks too: session_id repeats on resume and clear", () => {
    // The subtle one. `SessionStart` carries `source: "startup" | "resume" |
    // "clear"`, so the CLI fires it *again within the same session_id* when a
    // session is resumed or cleared. `(session_id, "SessionStart")` therefore names
    // a class of firings, not one firing — keying on it would suppress every resume
    // and every clear after the first, so the user's session would appear to start
    // once and never restart.
    for (const source of ["startup", "resume", "clear"]) {
      expect(
        claimFor("gemini-cli", { ...base, hook_event_name: "SessionStart", source }).claim,
      ).toBeUndefined();
    }
    expect(claimFor("gemini-cli", { ...base, hook_event_name: "SessionEnd" }).claim).toBeUndefined();
  });

  it("offers no resolver at all, so nothing can be claimed by accident", () => {
    const gemini = adapterFor("gemini-cli");
    expect(gemini.capabilities.deliveryIdentifier).toBe("none");
    expect(typeof gemini.deliveryIdentity).toBe("undefined");
    // Every callback resolves to no claim, without the runtime having to ask.
    expect(claimFor("gemini-cli", { ...base, hook_event_name: "SessionStart" })).toEqual({});
  });

  it("records why each callback is unidentifiable, exhaustively", async () => {
    const { GEMINI_UNIDENTIFIABLE_CALLBACKS } = await import(
      "../../src/providers/gemini/delivery.js"
    );
    const { GEMINI_HOOK_EVENT_NAMES } = await import("../../src/providers/gemini/schema.js");

    // Exhaustive on purpose: adding a hook event without revisiting delivery
    // identity should read as an omission rather than pass silently.
    for (const name of GEMINI_HOOK_EVENT_NAMES) {
      expect(GEMINI_UNIDENTIFIABLE_CALLBACKS[name], name).toBeDefined();
    }
    expect(GEMINI_UNIDENTIFIABLE_CALLBACKS["SessionStart"]).toContain("resume");
  });

  it("refuses the streaming model callbacks, which can share a millisecond", () => {
    expect(
      claimFor("gemini-cli", {
        ...base,
        hook_event_name: "AfterModel",
        timestamp: "2026-07-25T10:00:05.000Z",
        llm_request: { model: "gemini-2.5-pro" },
        llm_response: { usageMetadata: { promptTokenCount: 10 } },
      }).claim,
    ).toBeUndefined();
  });
});

describe("delivery identity: Antigravity", () => {
  const base = { conversationId: "conv-ag", workspacePaths: ["/workspace/demo"], invocationNum: 2 };

  it("identifies a tool step from the two verified counters", () => {
    expect(
      claimFor("antigravity", {
        ...base,
        hookEventName: "PreToolUse",
        stepIdx: 3,
        toolName: "run_command",
        toolInput: { command: "antigravity secret" },
      }).claim?.components,
    ).toEqual(["2", "3"]);
  });

  it("refuses Stop, whose only separating field is an unconfirmed reconstruction", () => {
    expect(
      claimFor("antigravity", { ...base, hookEventName: "Stop", fullyIdle: true }).claim,
    ).toBeUndefined();
  });
});

describe("delivery identity: malformed input", () => {
  const malformed: readonly [string, unknown][] = [
    ["null", null],
    ["a bare string", "not a payload"],
    ["an array", [1, 2, 3]],
    ["an empty object", {}],
    ["a nested-only object", { deeply: { nested: true } }],
    ["a known event with a missing session", { hook_event_name: "PostToolUse" }],
    ["a known event with a non-string id", { hook_event_name: "PostToolUse", session_id: 7 }],
    ["an unrecognized event name", { hook_event_name: "NotAnEvent", session_id: "s" }],
  ];

  for (const providerId of ["claude-code", "codex", "cursor", "gemini-cli", "antigravity"]) {
    for (const [label, payload] of malformed) {
      it(`${providerId} claims nothing for ${label}`, () => {
        const read = claimFor(providerId, payload);
        expect(read.claim).toBeUndefined();
        expect(read.rejection).toBeUndefined();
      });
    }
  }
});

describe("delivery identity: declared capability matches behaviour", () => {
  it("declares coverage that matches whether the adapter can identify anything", () => {
    for (const adapter of createDefaultProviderRegistry().adapters) {
      // No adapter identifies *every* callback, so none may declare `all`.
      expect(adapter.capabilities.deliveryIdentifier, adapter.id).not.toBe("all");

      if (adapter.capabilities.deliveryIdentifier === "none") {
        // Declaring `none` and still offering a resolver would be a contradiction
        // the runtime would never consult: `resolveDelivery` short-circuits on the
        // capability.
        expect(typeof adapter.deliveryIdentity, adapter.id).toBe("undefined");
      } else {
        expect(adapter.capabilities.deliveryIdentifier, adapter.id).toBe("partial");
        expect(typeof adapter.deliveryIdentity, adapter.id).toBe("function");
      }
    }
  });

  it("declares none for the Gemini CLI, whose protocol identifies nothing", () => {
    const gemini = createDefaultProviderRegistry().adapters.find((a) => a.id === "gemini-cli");
    expect(gemini?.capabilities.deliveryIdentifier).toBe("none");
  });
});
