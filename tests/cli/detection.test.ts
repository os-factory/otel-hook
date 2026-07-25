import { readFile } from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { autoDetectProvider } from "../../src/cli/detection.js";
import { providerVisibleEnvironment } from "../../src/cli/environment-view.js";
import { DEFAULT_CONFIG } from "../../src/config/schema.js";
import { createPrivacyService } from "../../src/privacy/service.js";
import type { ProviderContext, ProviderDetectionInput } from "../../src/providers/adapter.js";
import { createDefaultProviderRegistry } from "../../src/providers/defaults.js";
import { createFixedClock } from "../../src/runtime/clock.js";
import { createDeterministicIdGenerator } from "../../src/runtime/ids.js";
import { createRecordingLogger } from "../../src/runtime/memory.js";

const PARITY_DIR = path.resolve(import.meta.dirname, "..", "..", "fixtures", "parity");

const privacy = createPrivacyService(DEFAULT_CONFIG.privacy);
const context: ProviderContext = {
  privacy,
  clock: createFixedClock(),
  ids: createDeterministicIdGenerator({ namespace: "detection-test" }),
  logger: createRecordingLogger("silent"),
  limits: privacy.policy.limits,
};

const detect = (payload: unknown) => {
  const input: ProviderDetectionInput = { payload, transport: "hook-stdin", environment: {} };
  return autoDetectProvider(
    createDefaultProviderRegistry(),
    input,
    context,
    DEFAULT_CONFIG.detection,
  );
};

const loadParityFixture = async (provider: string, file: string): Promise<unknown> =>
  JSON.parse(await readFile(path.join(PARITY_DIR, provider, file), "utf8")) as unknown;

describe("auto-detection refuses cross-provider overlap", () => {
  it("refuses a real Claude Code SessionStart payload that three adapters recognize", async () => {
    const payload = await loadParityFixture("claude-code", "session-start.json");
    const result = detect(payload);

    expect(result.status).toBe("ambiguous");
    if (result.status !== "ambiguous") {
      return;
    }
    // The concrete reason this guard exists: the Gemini CLI adapter scores this
    // Claude Code payload `exact` and Codex scores it `strong`, so picking the
    // highest confidence would file Claude Code telemetry under gemini-cli.
    const byProvider = new Map(result.candidates.map((entry) => [entry.providerId, entry.confidence]));
    expect(byProvider.get("gemini-cli")).toBe("exact");
    expect(byProvider.get("codex")).toBe("strong");
    expect(byProvider.get("claude-code")).toBe("strong");
  });

  it("refuses Claude Code Stop and PostToolUse payloads that Codex also recognizes", async () => {
    for (const file of ["stop.json", "post-tool-use.json"]) {
      const payload = await loadParityFixture("claude-code", file);
      const result = detect(payload);
      expect(result.status, file).toBe("ambiguous");
      if (result.status === "ambiguous") {
        expect(result.candidates.map((entry) => entry.providerId).sort(), file).toEqual([
          "claude-code",
          "codex",
        ]);
      }
    }
  });

  it("resolves payload families only one adapter recognizes", () => {
    const cursor = detect({
      hookEventName: "sessionStart",
      conversationId: "ses-cursor",
      timestampMillis: 1_700_000_000_000,
    });
    expect(cursor.status).toBe("resolved");
    if (cursor.status === "resolved") {
      expect(cursor.adapter.id).toBe("cursor");
      // Auto-detection keeps the adapter's own confidence; it never promotes a
      // detection to `exact` on the strength of our own selection.
      expect(cursor.confidence).toBe("exact");
    }

    const antigravity = detect({
      hookEventName: "PreToolUse",
      conversationId: "ses-antigravity",
      workspacePaths: ["/workspace/demo"],
      stepIdx: 1,
      invocationNum: 0,
      toolName: "run_command",
    });
    expect(antigravity.status).toBe("resolved");
    if (antigravity.status === "resolved") {
      expect(antigravity.adapter.id).toBe("antigravity");
    }
  });

  it("reports an unrecognized payload distinctly from an ambiguous one", () => {
    const result = detect({ unrelated: true });
    expect(result.status).toBe("unrecognized");
  });

  it("never resolves to a default provider when nothing matches confidently", () => {
    // A payload with a Claude-ish event name but no session id: the Claude
    // adapter declines outright rather than claiming it, and no other adapter
    // steps in.
    const result = detect({ hook_event_name: "Stop" });
    expect(result.status).not.toBe("resolved");
  });
});

describe("provider-visible environment", () => {
  it("hides variables outside the allow-list and anything secret-looking", () => {
    const visible = providerVisibleEnvironment(
      {
        OTEL_HOOK_LOG_LEVEL: "debug",
        OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer leak-me",
        CLAUDE_CODE_VERSION: "1.2.3",
        AWS_SECRET_ACCESS_KEY: "leak-me-too",
        HOME: "/home/someone",
        NPM_TOKEN: "leak-me-three",
      },
      privacy,
    );

    expect(visible).toEqual({ OTEL_HOOK_LOG_LEVEL: "debug", CLAUDE_CODE_VERSION: "1.2.3" });
    expect(Object.isFrozen(visible)).toBe(true);
  });
});
