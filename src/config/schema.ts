import { z } from "zod";

import { detectionConfidenceSchema, nonEmptyStringSchema } from "../model/primitives.js";
import {
  contentModeSchema,
  DEFAULT_PRIVACY_POLICY,
  privacyPolicySchema,
} from "../privacy/policy.js";
import { exportDestinationsSchema, spoolPolicySchema } from "./destinations.js";
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
 * Policy for hook-derived metrics (issue #69).
 *
 * Off by default, like logs: an upgrade must not start a new stream to a
 * collector nobody sized for it. `enabled` governs the `default` destination
 * (the single-endpoint settings); an `exporter.destinations[]` entry receives
 * metrics when its `signals` list names `metrics`. Metrics carry no content, so
 * listing the signal is the whole opt-in.
 *
 * - `temporality`: `cumulative` (default) exports running totals per series,
 *   kept in the state store across hook processes, so a receiver that merges
 *   counters by keeping the largest value stays correct. `delta` exports what one
 *   callback observed and keeps no state.
 * - `includeSessionId`: put `session.id` on every data point (default true). Turn
 *   it off where per-session series are too many for the backend.
 */
export const metricsPolicySchema = z.strictObject({
  enabled: z.boolean(),
  /** Full URL. Absent, derived from `endpoint` (`/v1/traces` becomes `/v1/metrics`). */
  endpoint: z.string().url().max(2048).optional(),
  temporality: z.enum(["cumulative", "delta"]),
  includeSessionId: z.boolean(),
});
export type MetricsPolicy = z.infer<typeof metricsPolicySchema>;

export const DEFAULT_METRICS_POLICY: MetricsPolicy = Object.freeze({
  enabled: false,
  temporality: "cumulative",
  includeSessionId: true,
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
  /**
   * Hook-derived metrics. Optional so an `ExporterPolicy` built by hand before
   * metrics existed stays valid; absent reads as {@link DEFAULT_METRICS_POLICY}.
   */
  metrics: metricsPolicySchema.optional(),
  /**
   * Additional OTLP destinations, each sent every batch in parallel.
   *
   * Absent (the default), the exporter has exactly one destination — the
   * single-endpoint settings above, named `default` — and behaves exactly as it
   * did before this list existed. See `destinations.ts`.
   *
   * Merged as one leaf: a higher layer that sets the list replaces it whole,
   * because "the union of two partial lists" has no answer an operator could
   * predict.
   */
  destinations: exportDestinationsSchema.optional(),
  /**
   * Per-destination retry spool bounds, each optional and merged per leaf; any
   * bound left unset takes its value from `DEFAULT_SPOOL_POLICY`.
   */
  spool: spoolPolicySchema.partial().optional(),
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

/**
 * Per-provider behaviour that is not part of an adapter's parse.
 *
 * `claudeCode.readTranscriptUsage` is the one sanctioned exception to "no
 * transcript reads in the hook" (docs/claude-code-usage-contract.md, finding 8).
 * When true, the hook runtime — never the adapter — reads the session transcript
 * named by a Claude Code `Stop` / `StopFailure` payload, bounded, and attaches the
 * turn's model and summed token usage before the adapter parses it. Off by
 * default: without it, otel-hook reads no file a hook payload names.
 */
export const providersPolicySchema = z.strictObject({
  claudeCode: z
    .strictObject({
      readTranscriptUsage: z.boolean(),
    })
    .optional(),
});
export type ProvidersPolicy = z.infer<typeof providersPolicySchema>;

export const otelHookConfigSchema = z.strictObject({
  exporter: exporterPolicySchema,
  privacy: privacyPolicySchema,
  detection: detectionPolicySchema,
  diagnostics: diagnosticsPolicySchema,
  /** Optional so a hand-built configuration from before it existed stays valid. */
  providers: providersPolicySchema.optional(),
});
export type OtelHookConfig = z.infer<typeof otelHookConfigSchema>;

/** Partial overlay accepted from a configuration layer. */
export const otelHookConfigPatchSchema = z.strictObject({
  // `logs` is unwrapped and re-partialled for the same reason `privacy.limits` is:
  // merging happens per leaf, so a layer must be able to set `logs.enabled` alone
  // without also restating the endpoint and the batch size.
  exporter: exporterPolicySchema
    .omit({ logs: true, metrics: true, spool: true })
    .partial()
    .extend({
      logs: logsPolicySchema.partial().optional(),
      metrics: metricsPolicySchema.partial().optional(),
      spool: spoolPolicySchema.partial().optional(),
    })
    .optional(),
  privacy: privacyPolicySchema
    .omit({ limits: true })
    .partial()
    .extend({ limits: privacyPolicySchema.shape.limits.partial().optional() })
    .optional(),
  detection: detectionPolicySchema.partial().optional(),
  diagnostics: diagnosticsPolicySchema.partial().optional(),
  providers: z
    .strictObject({
      claudeCode: z.strictObject({ readTranscriptUsage: z.boolean() }).partial().optional(),
    })
    .partial()
    .optional(),
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
  metrics: DEFAULT_METRICS_POLICY,
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

export const DEFAULT_PROVIDERS_POLICY: ProvidersPolicy = Object.freeze({
  claudeCode: Object.freeze({ readTranscriptUsage: false }),
});

export const DEFAULT_CONFIG: OtelHookConfig = Object.freeze({
  exporter: DEFAULT_EXPORTER_POLICY,
  privacy: DEFAULT_PRIVACY_POLICY,
  detection: DEFAULT_DETECTION_POLICY,
  diagnostics: DEFAULT_DIAGNOSTICS_POLICY,
  providers: DEFAULT_PROVIDERS_POLICY,
});

/** Whether the runtime may read Claude Code transcripts at `Stop` (default false). */
export const readsClaudeTranscriptUsage = (config: OtelHookConfig): boolean =>
  config.providers?.claudeCode?.readTranscriptUsage === true;

/** Content mode is re-exported for callers building patches. */
export { contentModeSchema };

/** The metrics policy in force, defaults filled in. */
export const effectiveMetricsPolicy = (exporter: ExporterPolicy): MetricsPolicy => ({
  ...DEFAULT_METRICS_POLICY,
  ...(exporter.metrics ?? {}),
});
