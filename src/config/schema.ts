import { z } from "zod";

import { detectionConfidenceSchema, nonEmptyStringSchema } from "../model/primitives.js";
import {
  contentModeSchema,
  DEFAULT_PRIVACY_POLICY,
  privacyPolicySchema,
} from "../privacy/policy.js";

/**
 * Runtime exporter policy.
 *
 * This describes *where and how* telemetry goes. It deliberately contains no
 * session, invocation, or workspace field: see ADR 0001. Mixing the two would
 * make identity globally reachable through configuration.
 */
export const exporterPolicySchema = z.strictObject({
  enabled: z.boolean(),
  protocol: z.enum(["http/protobuf", "http/json", "none"]),
  endpoint: z.string().url().max(2048).optional(),
  /**
   * Header names only. Values are supplied separately at construction time and
   * are never part of a resolved-config snapshot, which is logged and exported.
   */
  headerNames: z.array(nonEmptyStringSchema).max(32).readonly(),
  timeoutMillis: z.number().int().min(1).max(600_000),
  maxBatchSize: z.number().int().min(1).max(4096),
  maxQueueSize: z.number().int().min(1).max(65_536),
  maxRetryAttempts: z.number().int().min(0).max(10),
  serviceName: nonEmptyStringSchema,
  serviceNamespace: nonEmptyStringSchema.optional(),
});
export type ExporterPolicy = z.infer<typeof exporterPolicySchema>;

export const detectionPolicySchema = z.strictObject({
  /** Detections below this confidence resolve to the unknown provider. */
  minimumConfidence: detectionConfidenceSchema,
  /** When false, an ambiguous detection is an error rather than unknown. */
  allowAmbiguousFallback: z.boolean(),
  /** Optional allow-list of provider ids; empty means "any registered". */
  allowedProviderIds: z.array(nonEmptyStringSchema).max(32).readonly(),
});
export type DetectionPolicy = z.infer<typeof detectionPolicySchema>;

export const diagnosticsPolicySchema = z.strictObject({
  logLevel: z.enum(["silent", "error", "warn", "info", "debug"]),
  /** Emit `error.raised` events for contained failures. */
  emitErrorEvents: z.boolean(),
});
export type DiagnosticsPolicy = z.infer<typeof diagnosticsPolicySchema>;

export const otelHookConfigSchema = z.strictObject({
  exporter: exporterPolicySchema,
  privacy: privacyPolicySchema,
  detection: detectionPolicySchema,
  diagnostics: diagnosticsPolicySchema,
});
export type OtelHookConfig = z.infer<typeof otelHookConfigSchema>;

/** Partial overlay accepted from a configuration layer. */
export const otelHookConfigPatchSchema = z.strictObject({
  exporter: exporterPolicySchema.partial().optional(),
  privacy: privacyPolicySchema
    .omit({ limits: true })
    .partial()
    .extend({ limits: privacyPolicySchema.shape.limits.partial().optional() })
    .optional(),
  detection: detectionPolicySchema.partial().optional(),
  diagnostics: diagnosticsPolicySchema.partial().optional(),
});
export type OtelHookConfigPatch = z.infer<typeof otelHookConfigPatchSchema>;

export const DEFAULT_EXPORTER_POLICY: ExporterPolicy = Object.freeze({
  enabled: true,
  protocol: "http/protobuf",
  headerNames: Object.freeze([]),
  timeoutMillis: 10_000,
  maxBatchSize: 128,
  maxQueueSize: 2048,
  maxRetryAttempts: 2,
  serviceName: "coding-agent",
});

export const DEFAULT_DETECTION_POLICY: DetectionPolicy = Object.freeze({
  minimumConfidence: "strong",
  allowAmbiguousFallback: true,
  allowedProviderIds: Object.freeze([]),
});

export const DEFAULT_DIAGNOSTICS_POLICY: DiagnosticsPolicy = Object.freeze({
  logLevel: "warn",
  emitErrorEvents: true,
});

export const DEFAULT_CONFIG: OtelHookConfig = Object.freeze({
  exporter: DEFAULT_EXPORTER_POLICY,
  privacy: DEFAULT_PRIVACY_POLICY,
  detection: DEFAULT_DETECTION_POLICY,
  diagnostics: DEFAULT_DIAGNOSTICS_POLICY,
});

/** Content mode is re-exported for callers building patches. */
export { contentModeSchema };
