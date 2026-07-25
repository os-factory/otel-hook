/**
 * Runs parity fixtures through the **real** provider adapters.
 *
 * The comparison mapper in `./canonical-mapping.ts` was written before any
 * adapter existed, so a divergence it asserted was a claim about the canonical
 * *model*, not about what this package actually emits. These helpers close that
 * gap: the payload goes through `createTestHook` with the shipped adapter
 * registered, so a parity assertion covers detection, identity arbitration,
 * privacy screening, and the adapter's own mapping — the same path the CLI takes.
 *
 * The clock and id generator are deterministic (`createTestHook`), so a fixture
 * replays identically on any machine.
 */
import type { CanonicalEvent } from "../../../src/model/events.js";
import { createAntigravityAdapter } from "../../../src/providers/antigravity/adapter.js";
import { createClaudeCodeAdapter } from "../../../src/providers/claude/adapter.js";
import { createCodexAdapter } from "../../../src/providers/codex/adapter.js";
import { createCursorAdapter } from "../../../src/providers/cursor/adapter.js";
import { createGeminiCliAdapter } from "../../../src/providers/gemini/adapter.js";
import type { ProviderAdapter } from "../../../src/providers/adapter.js";
import type { HookIngestOutcome } from "../../../src/runtime/hook.js";
import { createTestHook } from "../../../src/testing/index.js";

const ADAPTER_FACTORIES: Readonly<Record<string, () => ProviderAdapter>> = Object.freeze({
  "claude-code": createClaudeCodeAdapter,
  cursor: createCursorAdapter,
  codex: createCodexAdapter,
  "gemini-cli": createGeminiCliAdapter,
  antigravity: createAntigravityAdapter,
});

export type RealAdapterRun = {
  readonly events: readonly CanonicalEvent[];
  readonly outcomes: readonly HookIngestOutcome[];
  /** Attribution outcome per payload, in session order. */
  readonly attributions: readonly string[];
  /** Every diagnostic code raised across the session, deduplicated. */
  readonly diagnosticCodes: readonly string[];
};

/**
 * Replay one ordered session of raw hook payloads through a real adapter.
 *
 * Each payload is ingested separately, exactly as a host would invoke the hook
 * once per event, so cross-invocation state (the sequence counter, the usage
 * baseline) is exercised rather than bypassed.
 */
export const runThroughRealAdapter = async (
  providerId: string,
  payloads: readonly unknown[],
): Promise<RealAdapterRun> => {
  const factory = ADAPTER_FACTORIES[providerId];
  if (factory === undefined) {
    throw new Error(`no real adapter registered for provider "${providerId}"`);
  }
  const harness = createTestHook({
    adapters: [factory()],
    // The CLI lowers the bar the same way once `--provider` names the adapter:
    // the caller's assertion, not the payload's shape, is what selects it.
    config: { detection: { minimumConfidence: "weak", allowedProviderIds: [providerId] } },
  });

  const outcomes: HookIngestOutcome[] = [];
  for (const payload of payloads) {
    outcomes.push(
      await harness.hook.ingest({ payload, transport: "hook-stdin", providerHint: providerId }),
    );
  }
  await harness.hook.flush();

  return {
    events: harness.sink.events(),
    outcomes,
    attributions: outcomes.map((outcome) => outcome.attribution),
    diagnosticCodes: [
      ...new Set(outcomes.flatMap((outcome) => outcome.diagnostics.map((info) => info.code))),
    ],
  };
};

/**
 * Translate a third-party-shaped Cursor parity fixture into the payload contract
 * the shipped Cursor adapter declares.
 *
 * This bridge exists because the two sides of the comparison consume genuinely
 * different envelopes. `opentelemetry-hooks` reads Cursor's real snake_case hook
 * JSON, while this package's Cursor adapter targets a payload contract that
 * `src/providers/cursor/payload.ts` documents as *synthetic* — invented for this
 * repository, with camelCase keys and a required `timestampMillis`. Rewriting the
 * fixture would break the Python side; changing the adapter's contract is not
 * this task's to make.
 *
 * So the bridge is explicit and narrow, and the parity claims that depend on it
 * say so: it only renames the envelope, and it never invents a semantic field.
 * `timestampMillis` is a fixed constant rather than a clock reading so replays
 * stay deterministic, and nothing else is added.
 */
export const CURSOR_BRIDGE_TIMESTAMP_MILLIS = 1_700_000_000_000;

const CURSOR_EVENT_NAME_BRIDGE: Readonly<Record<string, string>> = Object.freeze({
  sessionStart: "sessionStart",
  preToolUse: "beforeToolUse",
  postToolUse: "afterToolUse",
  afterMCPExecution: "afterMCPExecution",
});

export type CursorBridgeResult =
  | { readonly status: "bridged"; readonly payload: Record<string, unknown> }
  | { readonly status: "unbridgeable"; readonly reason: string };

export const bridgeCursorParityPayload = (raw: unknown): CursorBridgeResult => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { status: "unbridgeable", reason: "payload is not a JSON object" };
  }
  const record = raw as Record<string, unknown>;
  const rawEventName = record.hook_event_name;
  if (typeof rawEventName !== "string") {
    return { status: "unbridgeable", reason: "payload has no hook_event_name" };
  }
  const eventName = CURSOR_EVENT_NAME_BRIDGE[rawEventName];
  if (eventName === undefined) {
    return { status: "unbridgeable", reason: `no bridge for cursor event "${rawEventName}"` };
  }
  const conversationId = record.conversation_id;
  if (typeof conversationId !== "string") {
    return { status: "unbridgeable", reason: "payload has no conversation_id" };
  }

  const base: Record<string, unknown> = {
    hookEventName: eventName,
    conversationId,
    timestampMillis: CURSOR_BRIDGE_TIMESTAMP_MILLIS,
    // `cwd` becomes the adapter's workspaceRoots input: the same directory fact,
    // expressed the way this adapter's contract expects it.
    ...(typeof record.cwd === "string" ? { workspaceRoots: [record.cwd] } : {}),
  };

  const toolName = typeof record.tool_name === "string" ? record.tool_name : undefined;
  const generationId = typeof record.generation_id === "string" ? record.generation_id : undefined;

  switch (eventName) {
    case "sessionStart":
      return {
        status: "bridged",
        payload: { ...base, sessionKind: "interactive", agentName: "cursor" },
      };
    case "beforeToolUse":
      if (toolName === undefined || generationId === undefined) {
        return { status: "unbridgeable", reason: "beforeToolUse needs tool_name and generation_id" };
      }
      return {
        status: "bridged",
        payload: {
          ...base,
          generationId,
          // Cursor's real protocol reuses the generation id as the call handle on
          // this fixture; the bridge carries it across rather than minting one.
          toolCallId: generationId,
          toolName,
          ...(record.tool_input === undefined ? {} : { toolInput: record.tool_input }),
        },
      };
    case "afterMCPExecution": {
      const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(toolName ?? "");
      if (mcp === null || generationId === undefined) {
        return {
          status: "unbridgeable",
          reason: "afterMCPExecution needs an mcp__<server>__<tool> name and generation_id",
        };
      }
      return {
        status: "bridged",
        payload: {
          ...base,
          toolCallId: generationId,
          server: mcp[1],
          tool: mcp[2],
          // Cursor reports fractional seconds; the canonical model is
          // milliseconds. This is the one unit conversion the bridge performs,
          // and the parity test asserts both sides agree on it.
          ...(typeof record.duration === "number"
            ? { durationMillis: record.duration * 1000 }
            : {}),
        },
      };
    }
    default:
      return { status: "unbridgeable", reason: `no bridge body for "${eventName}"` };
  }
};

export const bridgeCursorParitySession = (
  payloads: readonly unknown[],
): readonly Record<string, unknown>[] => {
  const bridged: Record<string, unknown>[] = [];
  for (const payload of payloads) {
    const result = bridgeCursorParityPayload(payload);
    if (result.status === "unbridgeable") {
      throw new Error(`cursor parity bridge failed: ${result.reason}`);
    }
    bridged.push(result.payload);
  }
  return bridged;
};
