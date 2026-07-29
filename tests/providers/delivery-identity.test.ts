import { describe, expect, it } from "vitest";

import { DEFAULT_PRIVACY_POLICY } from "../../src/privacy/policy.js";
import { createPrivacyService } from "../../src/privacy/service.js";
import {
  DELIVERY_COMPONENT_PATTERN,
  MAX_DELIVERY_GAPS,
  providerDeliveryClaimSchema,
  providerDeliveryGapsSchema,
  readDeliveryClaim,
  readDeliveryGap,
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
  const base = { conversation_id: "conv-1", generation_id: "gen-1" };

  it("identifies a tool call, a generation edge, and the session edges", () => {
    expect(
      claimFor("cursor", {
        ...base,
        hook_event_name: "postToolUse",
        tool_use_id: "call-9",
        tool_name: "Read",
      }).claim?.components,
    ).toEqual(["call-9"]);
    expect(
      claimFor("cursor", {
        ...base,
        hook_event_name: "beforeSubmitPrompt",
        prompt: "cursor secret prompt",
      }).claim?.components,
    ).toEqual(["gen-1"]);
    expect(
      claimFor("cursor", { ...base, hook_event_name: "sessionStart" }).claim?.components,
    ).toEqual(["sessionStart"]);
  });

  it("separates the two edges of one tool call, so neither suppresses the other", () => {
    const before = claimFor("cursor", {
      ...base,
      hook_event_name: "preToolUse",
      tool_use_id: "call-9",
      tool_name: "Read",
    }).claim;
    const after = claimFor("cursor", {
      ...base,
      hook_event_name: "postToolUse",
      tool_use_id: "call-9",
      tool_name: "Read",
    }).claim;

    expect(before?.components).toEqual(after?.components);
    expect(before?.sourceEventName).not.toBe(after?.sourceEventName);
  });

  it("refuses a tool callback that carries no tool_use_id", () => {
    expect(
      claimFor("cursor", { ...base, hook_event_name: "postToolUse", tool_name: "Read" }).claim,
    ).toBeUndefined();
  });

  it("refuses the callbacks whose only distinguishing field is a command or a path", () => {
    expect(
      claimFor("cursor", {
        ...base,
        hook_event_name: "afterShellExecution",
        command: "npm run check",
      }).claim,
    ).toBeUndefined();
    expect(
      claimFor("cursor", {
        ...base,
        hook_event_name: "beforeReadFile",
        file_path: "/workspace/demo/private.txt",
      }).claim,
    ).toBeUndefined();
    expect(
      claimFor("cursor", { ...base, hook_event_name: "preCompact", trigger: "auto" }).claim,
    ).toBeUndefined();
  });

  it("refuses a generation edge with no generation_id to name it", () => {
    expect(
      claimFor("cursor", { conversation_id: "conv-1", hook_event_name: "stop" }).claim,
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

  it("identifies the invocation edges from invocationNum, which is on the verified list", () => {
    // `invocationNum` is present on every Antigravity payload and is one of the
    // fields the integration task named as verified. A counter named for the
    // invocation it numbers repeats on a redelivery and advances on a genuine
    // second invocation, which is the same argument the tool pair rests on.
    for (const hookEventName of ["PreInvocation", "PostInvocation"]) {
      const claim = claimFor("antigravity", { ...base, hookEventName, agentVersion: "1.2.3" }).claim;
      expect(claim?.components, hookEventName).toEqual(["2"]);
      expect(claim?.evidence.join(" "), hookEventName).toContain("invocationNum");
    }
  });

  it("keeps the two invocation edges distinct from each other and from the tool edges", () => {
    const ids = createDeterministicIdGenerator();
    const identityOf = (payload: Record<string, unknown>): string => {
      const claim = claimFor("antigravity", payload).claim;
      if (claim === undefined) {
        throw new Error("expected a claim");
      }
      return resolveDeliveryIdentity({
        ids,
        providerId: "antigravity",
        installationId: "install-1",
        claim,
      }).callbackId;
    };

    const callbackIds = new Set([
      identityOf({ ...base, hookEventName: "PreInvocation" }),
      identityOf({ ...base, hookEventName: "PostInvocation" }),
      identityOf({ ...base, hookEventName: "PreToolUse", stepIdx: 0, toolName: "run_command" }),
      identityOf({ ...base, hookEventName: "PostToolUse", stepIdx: 0, toolName: "run_command" }),
    ]);
    expect(callbackIds.size).toBe(4);
  });

  it("separates two invocations in one conversation", () => {
    const ids = createDeterministicIdGenerator();
    const claimAt = (invocationNum: number): ProviderDeliveryClaim => {
      const claim = claimFor("antigravity", {
        ...base,
        invocationNum,
        hookEventName: "PreInvocation",
      }).claim;
      if (claim === undefined) {
        throw new Error("expected a claim");
      }
      return claim;
    };
    const at = (invocationNum: number): string =>
      resolveDeliveryIdentity({
        ids,
        providerId: "antigravity",
        installationId: "install-1",
        claim: claimAt(invocationNum),
      }).callbackId;

    expect(at(2)).not.toBe(at(3));
    // A redelivery repeats the counter, so it must recompute the same identity.
    expect(at(2)).toBe(at(2));
  });

  it("refuses Stop, whose only separating field is an unconfirmed reconstruction", () => {
    // `invocationNum` would *look* like an identity here and would be worse than
    // none: Stop can fire twice per invocation (idle, then fully idle), so keying on
    // it would suppress the second, real firing.
    expect(
      claimFor("antigravity", { ...base, hookEventName: "Stop", fullyIdle: true }).claim,
    ).toBeUndefined();
  });
});

describe("delivery identity: per-callback gap diagnostics", () => {
  /**
   * The callbacks each adapter identifies whenever its payload is well formed, so
   * they need no gap entry. Everything else must have one — that is the assertion.
   *
   * Written out rather than derived: deriving it from the resolver would make the
   * exhaustiveness check tautological, and the point is to notice a hook event added
   * without anyone deciding its delivery status.
   */
  const ALWAYS_IDENTIFIED: Readonly<Record<string, readonly string[]>> = {
    "claude-code": [],
    codex: [],
    cursor: [
      "sessionStart",
      "sessionEnd",
      "beforeSubmitPrompt",
      "afterAgentResponse",
      "stop",
      "beforeToolUse",
      "afterToolUse",
      "toolUseFailed",
      "subagentStart",
      "subagentStop",
    ],
    "gemini-cli": [],
    antigravity: ["PreInvocation", "PostInvocation", "PreToolUse", "PostToolUse"],
  };

  const eventNamesFor = async (providerId: string): Promise<readonly string[]> => {
    switch (providerId) {
      case "claude-code":
        return (await import("../../src/providers/claude/schema.js")).CLAUDE_HOOK_EVENT_NAMES;
      case "codex":
        return (await import("../../src/providers/codex/payload.js")).CODEX_HOOK_EVENT_NAMES;
      case "cursor":
        return (await import("../../src/providers/cursor/payload.js")).CURSOR_HOOK_EVENT_NAMES;
      case "gemini-cli":
        return (await import("../../src/providers/gemini/schema.js")).GEMINI_HOOK_EVENT_NAMES;
      default:
        return (await import("../../src/providers/antigravity/payload.js"))
          .ANTIGRAVITY_HOOK_EVENT_NAMES;
    }
  };

  for (const providerId of ["claude-code", "codex", "cursor", "gemini-cli", "antigravity"]) {
    it(`explains every ${providerId} callback it cannot identify`, async () => {
      const adapter = adapterFor(providerId);
      const gaps = adapter.deliveryGaps ?? {};
      const alwaysIdentified = ALWAYS_IDENTIFIED[providerId] ?? [];

      for (const name of await eventNamesFor(providerId)) {
        if (alwaysIdentified.includes(name)) {
          continue;
        }
        // Every remaining callback either has no identity or has one only when an
        // optional field is present. Both cases end in the same diagnostic, so both
        // owe an operator a reason naming the field that would close the gap.
        expect(readDeliveryGap(adapter, name), `${providerId} ${name}`).toBeDefined();
      }

      // And nothing is documented that the adapter does not recognize, which would
      // be a gap table drifting away from the protocol it describes.
      const recognized = new Set(await eventNamesFor(providerId));
      for (const documented of Object.keys(gaps)) {
        expect(recognized.has(documented), `${providerId} ${documented}`).toBe(true);
      }
    });
  }

  it("declares a gap table even for the adapter that identifies nothing", () => {
    // Especially for that one: `provider-declares-none` is where a bare reason code
    // is least useful, because the answer is a property of the protocol and only the
    // adapter can state it.
    const gemini = adapterFor("gemini-cli");
    expect(gemini.capabilities.deliveryIdentifier).toBe("none");
    expect(readDeliveryGap(gemini, "SessionStart")).toContain("resume");
    expect(readDeliveryGap(gemini, "BeforeTool")).toContain("tool-call id");
  });

  it("refuses a gap reason that carries a filesystem path or a newline", () => {
    // The same containment as a component guard, for the opposite purpose: a
    // component must be identifier-shaped, a reason must be one line of prose that
    // cannot smuggle a home directory into stderr.
    const adapter: ProviderAdapter = {
      ...createFixtureAdapter(),
      deliveryGaps: {
        leaky: "no id; see /home/someone/private-repo/notes.md",
        multiline: "no id;\nand here is a payload dump",
        fine: "no request id in this protocol version",
      },
    };
    expect(readDeliveryGap(adapter, "leaky")).toBeUndefined();
    expect(readDeliveryGap(adapter, "multiline")).toBeUndefined();
    expect(readDeliveryGap(adapter, "fine")).toBe("no request id in this protocol version");
  });

  it("does not read an inherited property when the event name is a prototype key", () => {
    // The event name comes from a payload, and `__proto__` is a string like any
    // other. A bare property read would return Object.prototype here.
    const adapter: ProviderAdapter = { ...createFixtureAdapter(), deliveryGaps: { real: "no id" } };
    for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(readDeliveryGap(adapter, name), name).toBeUndefined();
    }
  });

  it("treats an adapter with no gap table as simply having nothing to add", () => {
    expect(readDeliveryGap(createFixtureAdapter(), "tool")).toBeUndefined();
    expect(readDeliveryGap(adapterFor("claude-code"), undefined)).toBeUndefined();
    // An event the adapter does not recognize is not an error either.
    expect(readDeliveryGap(adapterFor("claude-code"), "NotAnEvent")).toBeUndefined();
  });

  it("caps how many gaps one adapter may declare", () => {
    expect(
      providerDeliveryGapsSchema.safeParse(
        Object.fromEntries(
          Array.from({ length: MAX_DELIVERY_GAPS + 1 }, (_, index) => [
            `Event${String(index)}`,
            "no id",
          ]),
        ),
      ).success,
    ).toBe(false);
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
