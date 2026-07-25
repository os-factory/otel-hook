import { describe, expect, it } from "vitest";

import type { ProviderContext, ProviderDetectionInput } from "../../../src/providers/adapter.js";
import { createCodexAdapter } from "../../../src/providers/codex/index.js";
import {
  createDeterministicIdGenerator,
  createFixedClock,
  createRecordingLogger,
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

const detectionInput = (payload: unknown): ProviderDetectionInput => ({
  payload,
  transport: "hook-stdin",
  environment: {},
});

const adapter = createCodexAdapter();

const identifyFixture = (name: string) => {
  const payload = loadHookFixture(name);
  const input = detectionInput(payload);
  const detection = adapter.detect(input, context);
  return adapter.identify({ ...input, detection }, context);
};

describe("codex adapter: identify", () => {
  it("claims session id and a derived invocation id", () => {
    const [claim] = identifyFixture("session-start.json");
    expect(claim?.source).toBe("adapter:codex");
    expect(claim?.fields.sessionId).toBe("codex-sess-0001");
    expect(claim?.fields.invocationId).toMatch(/^inv_/);
    expect(claim?.fields.startedAt).toBe(1_700_000_000_000);
  });

  it("derives a privacy-safe workspace handle from cwd, never the raw path", () => {
    const [claim] = identifyFixture("session-start.json");
    const workspace = claim?.fields.workspace;
    expect(workspace?.keySource).toBe("working-directory");
    expect(workspace?.workspaceId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(claim)).not.toContain("/workspace/demo-repo");
  });

  it("gives two different hook calls in the same session different invocation ids", () => {
    const [preToolUse] = identifyFixture("pre-tool-use-shell.json");
    const [postToolUse] = identifyFixture("post-tool-use-success.json");
    expect(preToolUse?.fields.invocationId).not.toBe(postToolUse?.fields.invocationId);
    expect(preToolUse?.fields.sessionId).toBe(postToolUse?.fields.sessionId);
  });

  it("reproduces the same invocation id when the same payload is replayed", () => {
    const first = identifyFixture("pre-tool-use-shell.json");
    const second = identifyFixture("pre-tool-use-shell.json");
    expect(first[0]?.fields.invocationId).toBe(second[0]?.fields.invocationId);
  });

  it("returns no claims for a payload it cannot parse at all", () => {
    const input = detectionInput({ nonsense: true });
    const detection = adapter.detect(input, context);
    expect(adapter.identify({ ...input, detection }, context)).toEqual([]);
  });
});
