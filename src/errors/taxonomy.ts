import { z } from "zod";

/**
 * Closed set of error codes. Adding a code is a minor change; changing what a
 * code means is a breaking change.
 */
export const otelHookErrorCodeSchema = z.enum([
  /** Input was not usable at all (empty stdin, unparsable JSON). */
  "invalid-input",
  /** Input parsed but failed canonical schema validation. */
  "schema-validation-failed",
  /** No adapter claimed the input with sufficient confidence. */
  "provider-unknown",
  /** Several adapters claimed the input at the same confidence. */
  "provider-detection-ambiguous",
  /** An adapter threw or returned a malformed result. */
  "provider-adapter-failure",
  /** Two identity claims disagreed at equal confidence. */
  "identity-conflict",
  /** Required identity fields were absent. */
  "identity-incomplete",
  /** A usage report violated the canonical usage invariants. */
  "usage-invalid",
  /** The state store could not be read or written. */
  "state-store-failure",
  /** The telemetry sink rejected or could not deliver a batch. */
  "telemetry-export-failure",
  /** Content reached the sink boundary in a state the policy forbids. */
  "privacy-policy-violation",
  /** Configuration could not be resolved. */
  "configuration-invalid",
  /** A configured bound (events, batch size) dropped data. */
  "limit-exceeded",
  /** Anything unanticipated. Always reported, never fatal to the host. */
  "internal-error",
]);
export type OtelHookErrorCode = z.infer<typeof otelHookErrorCodeSchema>;

export const errorSeveritySchema = z.enum(["warning", "error"]);
export type ErrorSeverity = z.infer<typeof errorSeveritySchema>;

/** Pipeline stage where a failure occurred. */
export const errorPhaseSchema = z.enum([
  "configuration",
  "detection",
  "identity",
  "parsing",
  "normalization",
  "privacy",
  "state",
  "export",
  "shutdown",
]);
export type ErrorPhase = z.infer<typeof errorPhaseSchema>;

/**
 * Which of the two safety postures a code participates in.
 *
 * - `fail-open`: the hook still reports success to the host agent. Telemetry may
 *   be incomplete; the coding agent is never blocked.
 * - `fail-closed-attribution`: the observation is not attributed to a session or
 *   provider. Data is dropped rather than labelled with a guess.
 */
export const failurePostureSchema = z.enum(["fail-open", "fail-closed-attribution"]);
export type FailurePosture = z.infer<typeof failurePostureSchema>;

export type ErrorCodeDescriptor = {
  readonly code: OtelHookErrorCode;
  readonly severity: ErrorSeverity;
  readonly posture: FailurePosture;
  /** Whether retrying the same input could succeed. */
  readonly retryable: boolean;
  readonly summary: string;
};

export const ERROR_TAXONOMY: Readonly<Record<OtelHookErrorCode, ErrorCodeDescriptor>> =
  Object.freeze({
    "invalid-input": {
      code: "invalid-input",
      severity: "warning",
      posture: "fail-open",
      retryable: false,
      summary: "Input could not be read or decoded.",
    },
    "schema-validation-failed": {
      code: "schema-validation-failed",
      severity: "error",
      posture: "fail-closed-attribution",
      retryable: false,
      summary: "A canonical event failed schema validation and was dropped.",
    },
    "provider-unknown": {
      code: "provider-unknown",
      severity: "warning",
      posture: "fail-closed-attribution",
      retryable: false,
      summary: "No adapter recognized the source provider; the input stays unattributed.",
    },
    "provider-detection-ambiguous": {
      code: "provider-detection-ambiguous",
      severity: "warning",
      posture: "fail-closed-attribution",
      retryable: false,
      summary: "Multiple adapters claimed the input at equal confidence.",
    },
    "provider-adapter-failure": {
      code: "provider-adapter-failure",
      severity: "error",
      posture: "fail-open",
      retryable: false,
      summary: "A provider adapter failed while parsing.",
    },
    "identity-conflict": {
      code: "identity-conflict",
      severity: "error",
      posture: "fail-closed-attribution",
      retryable: false,
      summary: "Identity claims disagreed; attribution was declined.",
    },
    "identity-incomplete": {
      code: "identity-incomplete",
      severity: "warning",
      posture: "fail-closed-attribution",
      retryable: false,
      summary: "Required identity fields were missing; attribution was declined.",
    },
    "usage-invalid": {
      code: "usage-invalid",
      severity: "error",
      posture: "fail-open",
      retryable: false,
      summary: "A usage report violated the canonical usage invariants.",
    },
    "state-store-failure": {
      code: "state-store-failure",
      severity: "warning",
      posture: "fail-open",
      retryable: true,
      summary: "State could not be read or written; derived values may be incomplete.",
    },
    "telemetry-export-failure": {
      code: "telemetry-export-failure",
      severity: "warning",
      posture: "fail-open",
      retryable: true,
      summary: "The telemetry sink could not accept a batch.",
    },
    "privacy-policy-violation": {
      code: "privacy-policy-violation",
      severity: "error",
      posture: "fail-closed-attribution",
      retryable: false,
      summary: "Content violated the resolved privacy policy and was dropped.",
    },
    "configuration-invalid": {
      code: "configuration-invalid",
      severity: "error",
      posture: "fail-open",
      retryable: false,
      summary: "Configuration could not be resolved; defaults apply.",
    },
    "limit-exceeded": {
      code: "limit-exceeded",
      severity: "warning",
      posture: "fail-open",
      retryable: false,
      summary: "A configured bound was reached and data was dropped.",
    },
    "internal-error": {
      code: "internal-error",
      severity: "error",
      posture: "fail-open",
      retryable: false,
      summary: "An unexpected failure was contained.",
    },
  });

export const describeErrorCode = (code: OtelHookErrorCode): ErrorCodeDescriptor =>
  ERROR_TAXONOMY[code];

/** Outcome of attributing an observation to a provider and session. */
export const attributionOutcomeSchema = z.enum([
  /** Identity resolved; events carry provider and session identity. */
  "attributed",
  /** Identity could not be established safely; nothing was attributed. */
  "declined",
  /** Attribution was attempted and failed unexpectedly. */
  "failed",
  /** Input was recognized but intentionally carried no telemetry. */
  "not-applicable",
]);
export type AttributionOutcome = z.infer<typeof attributionOutcomeSchema>;

export const attributionReasonSchema = z.enum([
  "provider-unknown",
  "provider-detection-ambiguous",
  "identity-conflict",
  "identity-incomplete",
  "adapter-ignored-input",
  "adapter-failure",
  "invalid-input",
  "internal-error",
]);
export type AttributionReason = z.infer<typeof attributionReasonSchema>;
