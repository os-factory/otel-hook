import type { DetectionPolicy } from "../config/schema.js";
import { createErrorInfo, errorInfoFromThrown, type OtelHookErrorInfo } from "../errors/index.js";
import {
  DETECTION_CONFIDENCE_RANK,
  type ProviderId,
} from "../model/primitives.js";
import {
  providerDetectionSchema,
  unknownDetection,
  type ProviderAdapter,
  type ProviderContext,
  type ProviderDetection,
  type ProviderDetectionInput,
} from "./adapter.js";

export type DetectionCandidate = {
  readonly adapter: ProviderAdapter;
  readonly detection: ProviderDetection;
};

export type RegistryDetectionResult =
  | {
      readonly status: "selected";
      readonly adapter: ProviderAdapter;
      readonly detection: ProviderDetection;
      readonly candidates: readonly DetectionCandidate[];
      readonly errors: readonly OtelHookErrorInfo[];
    }
  | {
      readonly status: "unknown";
      readonly reason:
        | "no-adapters-registered"
        | "no-candidates"
        | "below-minimum-confidence"
        | "provider-not-allowed";
      readonly detection: ProviderDetection;
      readonly candidates: readonly DetectionCandidate[];
      readonly errors: readonly OtelHookErrorInfo[];
    }
  | {
      readonly status: "ambiguous";
      readonly detection: ProviderDetection;
      readonly candidates: readonly DetectionCandidate[];
      readonly errors: readonly OtelHookErrorInfo[];
    };

/**
 * Immutable set of adapters.
 *
 * A registry is a value passed to the runtime, not a mutable module-level
 * singleton: two hooks in one process may legitimately be configured with
 * different adapter sets, and a global would let one silently reconfigure the
 * other.
 */
export interface ProviderRegistry {
  readonly adapters: readonly ProviderAdapter[];
  get(id: string): ProviderAdapter | undefined;
  detect(
    input: ProviderDetectionInput,
    context: ProviderContext,
    policy: DetectionPolicy,
  ): RegistryDetectionResult;
}

export const createProviderRegistry = (
  adapters: readonly ProviderAdapter[],
): ProviderRegistry => {
  const byId = new Map<string, ProviderAdapter>();
  for (const adapter of adapters) {
    if (byId.has(adapter.id)) {
      throw createDuplicateAdapterError(adapter.id);
    }
    byId.set(adapter.id, adapter);
  }
  const frozen = Object.freeze([...adapters]);

  return {
    adapters: frozen,
    get: (id: string): ProviderAdapter | undefined => byId.get(id),
    detect: (
      input: ProviderDetectionInput,
      context: ProviderContext,
      policy: DetectionPolicy,
    ): RegistryDetectionResult => {
      const errors: OtelHookErrorInfo[] = [];
      const candidates: DetectionCandidate[] = [];

      if (frozen.length === 0) {
        return {
          status: "unknown",
          reason: "no-adapters-registered",
          detection: unknownDetection(["no adapters registered"]),
          candidates,
          errors,
        };
      }

      for (const adapter of frozen) {
        let detection: ProviderDetection;
        try {
          detection = providerDetectionSchema.parse(adapter.detect(input, context));
        } catch (thrown) {
          // A misbehaving adapter must not suppress its peers.
          errors.push(errorInfoFromThrown(thrown, { code: "provider-adapter-failure", phase: "detection" }));
          continue;
        }
        if (detection.confidence === "none") {
          continue;
        }
        if (detection.providerId !== adapter.id) {
          errors.push(
            createErrorInfo({
              code: "provider-adapter-failure",
              phase: "detection",
              detail: `adapter ${adapter.id} claimed provider id ${detection.providerId}`,
              details: { "adapter.id": adapter.id, "detection.provider_id": detection.providerId },
            }),
          );
          continue;
        }
        candidates.push({ adapter, detection });
      }

      if (candidates.length === 0) {
        return {
          status: "unknown",
          reason: "no-candidates",
          detection: unknownDetection(),
          candidates,
          errors,
        };
      }

      const bestRank = Math.max(
        ...candidates.map((candidate) => DETECTION_CONFIDENCE_RANK[candidate.detection.confidence]),
      );
      const best = candidates.filter(
        (candidate) => DETECTION_CONFIDENCE_RANK[candidate.detection.confidence] === bestRank,
      );

      if (best.length > 1) {
        return {
          status: "ambiguous",
          detection: unknownDetection([
            `${best.length} adapters matched at equal confidence`,
            ...best.map((candidate) => `candidate ${candidate.adapter.id}`),
          ]),
          candidates,
          errors,
        };
      }

      const [winner] = best;
      if (winner === undefined) {
        return {
          status: "unknown",
          reason: "no-candidates",
          detection: unknownDetection(),
          candidates,
          errors,
        };
      }

      if (bestRank < DETECTION_CONFIDENCE_RANK[policy.minimumConfidence]) {
        return {
          status: "unknown",
          reason: "below-minimum-confidence",
          detection: unknownDetection([
            `best confidence ${winner.detection.confidence} is below required ${policy.minimumConfidence}`,
          ]),
          candidates,
          errors,
        };
      }

      if (
        policy.allowedProviderIds.length > 0 &&
        !policy.allowedProviderIds.includes(winner.adapter.id)
      ) {
        return {
          status: "unknown",
          reason: "provider-not-allowed",
          detection: unknownDetection([`provider ${winner.adapter.id} is not in the allow-list`]),
          candidates,
          errors,
        };
      }

      return {
        status: "selected",
        adapter: winner.adapter,
        detection: winner.detection,
        candidates,
        errors,
      };
    },
  };
};

const createDuplicateAdapterError = (id: ProviderId): Error =>
  new Error(`duplicate provider adapter id: ${id}`);

/**
 * Built-in adapters.
 *
 * Empty by design in the core package: provider support is added by dedicated
 * adapter modules, and the core must remain testable without any of them.
 */
export const BUILT_IN_PROVIDERS: readonly ProviderAdapter[] = Object.freeze([]);
