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
 * There is deliberately no Cursor envelope bridge here any more.
 *
 * Until the Cursor payload contract was re-derived from the published reference
 * and real captures, this module carried `bridgeCursorParityPayload`: a
 * translation from Cursor's real snake_case hook JSON into the camelCase,
 * `timestampMillis`-bearing shape the adapter used to declare. Every Cursor
 * parity claim had to say that it ran through that bridge (ADAPTER-NOTE-005).
 *
 * Both sides of the comparison now read the same raw fixture bytes, so the
 * bridge is gone rather than kept "just in case": a bridge that is not needed is
 * a place for a future mismatch to hide.
 */
