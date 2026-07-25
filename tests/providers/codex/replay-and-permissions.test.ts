import { describe, expect, it } from "vitest";

import type { AttributionOutcome } from "../../../src/errors/index.js";
import type { ProviderContext } from "../../../src/providers/adapter.js";
import { createCodexAdapter } from "../../../src/providers/codex/index.js";
import {
  createDeterministicIdGenerator,
  createFixedClock,
  createRecordingLogger,
  createTestHook,
  createTestPrivacyService,
} from "../../../src/testing/index.js";
import { loadHookFixture } from "./helpers.js";

const privacy = createTestPrivacyService();
const context: ProviderContext = {
  privacy,
  clock: createFixedClock(),
  ids: createDeterministicIdGenerator({ namespace: "test" }),
  logger: createRecordingLogger(),
  limits: privacy.policy.limits,
};

describe("codex adapter: replay safety", () => {
  it("produces byte-identical events across two independent hooks given the same payload", async () => {
    const first = createTestHook({ adapters: [createCodexAdapter()] });
    const second = createTestHook({ adapters: [createCodexAdapter()] });
    const payload = loadHookFixture("pre-tool-use-shell.json");

    const a = await first.hook.ingest({ payload, transport: "hook-stdin" });
    const b = await second.hook.ingest({ payload, transport: "hook-stdin" });

    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
    expect(a.identity?.invocationId).toBe(b.identity?.invocationId);
  });

  it("numbers sequences consecutively across hook calls within one session", async () => {
    const { hook, sink } = createTestHook({ adapters: [createCodexAdapter()] });
    await hook.ingest({ payload: loadHookFixture("session-start.json"), transport: "hook-stdin" });
    await hook.ingest({ payload: loadHookFixture("pre-tool-use-shell.json"), transport: "hook-stdin" });
    await hook.ingest({ payload: loadHookFixture("post-tool-use-success.json"), transport: "hook-stdin" });

    expect(sink.events().map((event) => event.sequence)).toEqual([0, 1, 2]);
  });

  it("keeps a replayed invocation id stable while the event id still advances with sequence", async () => {
    const { hook } = createTestHook({ adapters: [createCodexAdapter()] });
    const payload = loadHookFixture("session-start.json");

    const first = await hook.ingest({ payload, transport: "hook-stdin" });
    const second = await hook.ingest({ payload, transport: "hook-stdin" });

    expect(first.identity?.invocationId).toBe(second.identity?.invocationId);
    expect(first.events[0]?.eventId).not.toBe(second.events[0]?.eventId);
  });
});

describe("codex adapter: permission neutrality", () => {
  const adapter = createCodexAdapter();
  const outcomes: readonly AttributionOutcome[] = ["attributed", "declined", "failed", "not-applicable"];

  it.each(outcomes)("stays silent for a PermissionRequest event regardless of attribution outcome (%s)", (attribution) => {
    const response = adapter.hookResponse(
      { attribution, emittedEvents: 0, errors: [] },
      context,
    );
    expect(response.contract).toBe("silent");
    expect(response.exitCode).toBe(0);
    expect(response.stdout).toBeUndefined();
  });

  it("never requires a provider-protocol response for any attribution outcome", () => {
    expect(adapter.capabilities.requiresHookResponse).toBe(false);
  });

  it("declines attribution cleanly for a PermissionRequest whose identity conflicts, and still answers silently", async () => {
    const { hook } = createTestHook({ adapters: [createCodexAdapter()] });
    const outcome = await hook.ingest({
      payload: loadHookFixture("permission-request.json"),
      transport: "hook-stdin",
      identityClaims: [
        {
          source: "test:conflicting",
          confidence: "exact",
          fields: { sessionId: "some-other-session" },
        } as never,
      ],
    });

    expect(outcome.attribution).toBe("declined");
    expect(outcome.attributionReason).toBe("identity-conflict");
    expect(outcome.hookResponse.contract).toBe("silent");
    expect(outcome.hookResponse.exitCode).toBe(0);
    expect(outcome.events).toEqual([]);
  });

  it("ignores a well-formed PermissionRequest and answers silently", async () => {
    const { hook } = createTestHook({ adapters: [createCodexAdapter()] });
    const outcome = await hook.ingest({
      payload: loadHookFixture("permission-request.json"),
      transport: "hook-stdin",
    });

    expect(outcome.attribution).toBe("not-applicable");
    expect(outcome.hookResponse.contract).toBe("silent");
  });
});
