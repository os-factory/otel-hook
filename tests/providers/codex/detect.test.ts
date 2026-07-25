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

describe("codex adapter: detect", () => {
  const adapter = createCodexAdapter();

  it("claims its own id when it reports a detection", () => {
    const detection = adapter.detect(detectionInput(loadHookFixture("session-start.json")), context);
    expect(detection.providerId).toBe("codex");
  });

  it("reports exact confidence for a payload carrying codex_version", () => {
    const detection = adapter.detect(detectionInput(loadHookFixture("session-start.json")), context);
    expect(detection.confidence).toBe("exact");
    expect(detection.providerVersion).toBe("0.42.0");
    expect(detection.sourceEventName).toBe("SessionStart");
  });

  it("reports exact confidence for the apply_patch tool marker", () => {
    const detection = adapter.detect(
      detectionInput(loadHookFixture("pre-tool-use-apply-patch.json")),
      context,
    );
    expect(detection.confidence).toBe("exact");
  });

  it("reports exact confidence for permission_mode=dontAsk", () => {
    const detection = adapter.detect(detectionInput(loadHookFixture("permission-request.json")), context);
    expect(detection.confidence).toBe("exact");
  });

  it("reports strong confidence for a well-formed payload without a codex-specific marker", () => {
    const detection = adapter.detect(detectionInput(loadHookFixture("pre-tool-use-shell.json")), context);
    expect(detection.confidence).toBe("strong");
  });

  it("reports weak confidence for a recognizable but invalid event payload", () => {
    const detection = adapter.detect(
      detectionInput(loadHookFixture("malformed-pre-tool-use.json")),
      context,
    );
    expect(detection.confidence).toBe("weak");
    expect(detection.sourceEventName).toBe("PreToolUse");
  });

  it("reports no confidence at all for an unrelated payload", () => {
    const detection = adapter.detect(detectionInput(loadHookFixture("unrelated-payload.json")), context);
    expect(detection.confidence).toBe("none");
    expect(detection.providerId).toBe("unknown");
  });

  it("never throws on detect, even for garbage input", () => {
    expect(() => adapter.detect(detectionInput(null), context)).not.toThrow();
    expect(() => adapter.detect(detectionInput("a string"), context)).not.toThrow();
    expect(() => adapter.detect(detectionInput(42), context)).not.toThrow();
    expect(() => adapter.detect(detectionInput([1, 2, 3]), context)).not.toThrow();
  });

  it("declares its adapter id and version", () => {
    expect(adapter.id).toBe("codex");
    expect(adapter.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
