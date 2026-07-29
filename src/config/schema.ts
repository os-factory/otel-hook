import { z } from "zod";

import { detectionConfidenceSchema, nonEmptyStringSchema } from "../model/primitives.js";
import {
  contentModeSchema,
  DEFAULT_PRIVACY_POLICY,
  privacyPolicySchema,
} from "../privacy/policy.js";
import { EMPTY_RESOURCE_ATTRIBUTES, resourceAttributesSchema } from "./resource-attributes.js";

/**
 * Policy for the OTLP logs signal.
 *
 * Two switches rather than one, because they answer different questions and an
 * operator needs to be able to answer them differently:
 *
 * - `enabled` — whether a second signal leaves this host at all. Off by default:
 *   an installation that upgrades must not silently start sending a new stream to a
 *   collector whose receivers, quotas, and retention were sized for traces.
 * - `includeContent` — whether *disclosed* text may appear in a log body. Also off
 *   by default, and deliberately not the same knob as `privacy.contentMode`: spans
 *   carry no content in any content mode, so an installation that set
 *   `contentMode` to get a hash and a length has never had content on the wire.
 *   Reusing that setting to also mean "publish prompts" would change what an
 *   existing configuration discloses without anybody editing it.
 *
 * `raw` content additionally requires the pre-existing `privacy.allowRawContent`
 * opt-in, which the privacy service enforces before a fact is ever built and the
 * log mapping re-checks at the wire.
 */
export const logsPolicySchema = z.strictObject({
  enabled: z.boolean(),
  /**
   * Full URL for the logs signal.
   *
   * Absent, it is derived from `endpoint`: a trailing `/v1/traces` becomes
   * `/v1/logs`, and an endpoint with no signal path has `/v1/logs` appended.
   */
  endpoint: z.string().url().max(2048).optional(),
  includeContent: z.boolean(),
  maxBatchSize: z.number().int().min(1).max(4096),
});
export type LogsPolicy = z.infer<typeof logsPolicySchema>;

export const DEFAULT_LOGS_POLICY: LogsPolicy = Object.freeze({
  enabled: false,
  includeContent: false,
  maxBatchSize: 128,
});

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
  /**
   * Custom attributes merged into the exported OTLP Resource.
   *
   * Bounded and validated, and refusing `service.name`/`service.namespace`,
   * which are the two fields above. Distinct from an invocation's
   * `consumerAttributes`: this describes the emitting deployment, carries no
   * identity, and is the same for every span this process exports.
   */
  resourceAttributes: resourceAttributesSchema,
  /**
   * The logs signal. Nested under the exporter because it shares the endpoint,
   * headers, timeout, protocol, service identity, and resource attributes above —
   * a second top-level section would invite two of each to drift apart.
   */
  logs: logsPolicySchema,
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
  // `logs` is unwrapped and re-partialled for the same reason `privacy.limits` is:
  // merging happens per leaf, so a layer must be able to set `logs.enabled` alone
  // without also restating the endpoint and the batch size.
  exporter: exporterPolicySchema
    .omit({ logs: true })
    .partial()
    .extend({ logs: logsPolicySchema.partial().optional() })
    .optional(),
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
  resourceAttributes: EMPTY_RESOURCE_ATTRIBUTES,
  logs: DEFAULT_LOGS_POLICY,
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
