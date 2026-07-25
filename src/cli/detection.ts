import type { DetectionPolicy } from "../config/schema.js";
import type { DetectionConfidence } from "../model/primitives.js";
import type {
  ProviderAdapter,
  ProviderContext,
  ProviderDetectionInput,
} from "../providers/adapter.js";
import type { ProviderRegistry } from "../providers/registry.js";

export type AutoDetectionCandidate = {
  readonly providerId: string;
  readonly confidence: DetectionConfidence;
};

export type AutoDetectionResult =
  | {
      readonly status: "resolved";
      readonly adapter: ProviderAdapter;
      readonly confidence: DetectionConfidence;
      readonly reasons: readonly string[];
    }
  | {
      readonly status: "ambiguous";
      readonly candidates: readonly AutoDetectionCandidate[];
    }
  | { readonly status: "unrecognized"; readonly reasons: readonly string[] };

/**
 * Auto-detect the provider, refusing whenever more than one adapter recognizes
 * the payload at all.
 *
 * The registry's own rule — highest self-reported confidence wins, a tie is
 * ambiguous — is correct for arbitrating *one* provider's evidence, but
 * comparing confidence *across* providers is not evidence at all: each adapter
 * scores only its own schema, and several coding agents share a PascalCase hook
 * vocabulary (`SessionStart`, `PreToolUse`, `PostToolUse`, `Stop`,
 * `PreCompact`, `SubagentStop`, ...). Measured against this package's own
 * fixtures, a real Claude Code `SessionStart` payload is claimed by the Gemini
 * CLI adapter at `exact` and by the Codex adapter at `strong`, and a Claude Code
 * `Stop` payload is claimed by Codex at `strong` — so a confidence comparison
 * would silently file one agent's telemetry under another's provider id, which
 * is worse than filing it nowhere.
 *
 * So auto-detection here requires a *unique* recognizer. Overlapping payload
 * families must be disambiguated with an explicit `--provider`, which is also
 * the only way to reach `exact` confidence for a payload that carries no
 * self-identifying provider field. There is no tie-break by registration order
 * and no default provider.
 */
export const autoDetectProvider = (
  registry: ProviderRegistry,
  input: ProviderDetectionInput,
  context: ProviderContext,
  policy: DetectionPolicy,
): AutoDetectionResult => {
  const detected = registry.detect(input, context, policy);
  const candidates: readonly AutoDetectionCandidate[] = detected.candidates.map((candidate) => ({
    providerId: candidate.adapter.id,
    confidence: candidate.detection.confidence,
  }));

  if (candidates.length > 1) {
    return { status: "ambiguous", candidates };
  }
  if (detected.status !== "selected") {
    return { status: "unrecognized", reasons: detected.detection.reasons };
  }
  return {
    status: "resolved",
    adapter: detected.adapter,
    confidence: detected.detection.confidence,
    reasons: detected.detection.reasons,
  };
};
