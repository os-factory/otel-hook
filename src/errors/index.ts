import { z } from "zod";

import { attributesSchema, epochMillisSchema, type Attributes } from "../model/primitives.js";
import {
  describeErrorCode,
  errorPhaseSchema,
  errorSeveritySchema,
  failurePostureSchema,
  otelHookErrorCodeSchema,
  type ErrorPhase,
  type OtelHookErrorCode,
} from "./taxonomy.js";

export * from "./taxonomy.js";

/**
 * Serializable, privacy-safe description of a failure.
 *
 * `message` is a fixed-vocabulary summary derived from the code and phase, never
 * a provider or exception string, because exception messages routinely contain
 * prompt text, file paths, and credentials. `details` is restricted to attribute
 * primitives for the same reason.
 */
export const otelHookErrorInfoSchema = z.strictObject({
  code: otelHookErrorCodeSchema,
  severity: errorSeveritySchema,
  phase: errorPhaseSchema,
  posture: failurePostureSchema,
  retryable: z.boolean(),
  message: z.string().min(1).max(512),
  details: attributesSchema.optional(),
  occurredAt: epochMillisSchema.optional(),
});
export type OtelHookErrorInfo = z.infer<typeof otelHookErrorInfoSchema>;

export type CreateErrorInfoInput = {
  readonly code: OtelHookErrorCode;
  readonly phase: ErrorPhase;
  /** Short, non-sensitive detail, e.g. `"2 adapters matched"`. */
  readonly detail?: string;
  readonly details?: Attributes;
  readonly occurredAt?: number;
};

export const createErrorInfo = (input: CreateErrorInfoInput): OtelHookErrorInfo => {
  const descriptor = describeErrorCode(input.code);
  const message =
    input.detail === undefined
      ? `${input.code} during ${input.phase}: ${descriptor.summary}`
      : `${input.code} during ${input.phase}: ${input.detail}`;
  return otelHookErrorInfoSchema.parse({
    code: descriptor.code,
    severity: descriptor.severity,
    phase: input.phase,
    posture: descriptor.posture,
    retryable: descriptor.retryable,
    message: message.slice(0, 512),
    ...(input.details === undefined ? {} : { details: input.details }),
    ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
  });
};

export class OtelHookError extends Error {
  public readonly info: OtelHookErrorInfo;

  public constructor(info: OtelHookErrorInfo) {
    super(info.message);
    this.name = "OtelHookError";
    this.info = info;
  }

  public static of(input: CreateErrorInfoInput): OtelHookError {
    return new OtelHookError(createErrorInfo(input));
  }
}

export const isOtelHookError = (value: unknown): value is OtelHookError =>
  value instanceof OtelHookError;

/**
 * Describe an arbitrary thrown value without disclosing its message.
 *
 * Only the constructor name crosses the boundary; the presence of a message is
 * reported as a boolean so operators can tell "threw nothing useful" from
 * "threw something we deliberately did not log".
 */
export const describeThrown = (
  thrown: unknown,
): { readonly errorName: string; readonly hasMessage: boolean } => {
  if (thrown instanceof Error) {
    return {
      errorName: thrown.name.slice(0, 64) || "Error",
      hasMessage: typeof thrown.message === "string" && thrown.message.length > 0,
    };
  }
  return { errorName: typeof thrown, hasMessage: false };
};

/** Convert an unexpected throw into privacy-safe error info. */
export const errorInfoFromThrown = (
  thrown: unknown,
  input: { readonly code?: OtelHookErrorCode; readonly phase: ErrorPhase; readonly occurredAt?: number },
): OtelHookErrorInfo => {
  if (isOtelHookError(thrown)) {
    return thrown.info;
  }
  const described = describeThrown(thrown);
  return createErrorInfo({
    code: input.code ?? "internal-error",
    phase: input.phase,
    detail: `contained ${described.errorName}`,
    details: { "error.name": described.errorName, "error.has_message": described.hasMessage },
    ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
  });
};
