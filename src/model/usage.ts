import { z } from "zod";

import { tokenCountSchema } from "./primitives.js";

/**
 * Whether an observation reports the change since the previous observation
 * (`delta`) or the running total for the session/generation (`cumulative`).
 *
 * The canonical model keeps temporality explicit rather than assuming one:
 * summing cumulative observations double-counts, and diffing delta observations
 * silently loses tokens.
 */
export const usageTemporalitySchema = z.enum(["delta", "cumulative"]);
export type UsageTemporality = z.infer<typeof usageTemporalitySchema>;

/**
 * Whether the provider counts cache-creation tokens inside its input total or
 * reports them as a disjoint bucket.
 *
 * - `included-in-input`: `cacheCreationInputTokens` is a subset of `inputTokens`.
 * - `disjoint-from-input`: cache-creation tokens are billed in addition to
 *   `inputTokens` and must be added when computing a total.
 * - `not-reported`: the provider exposes no cache-creation counter; the field is
 *   pinned to zero.
 */
export const cacheCreationAccountingSchema = z.enum([
  "included-in-input",
  "disjoint-from-input",
  "not-reported",
]);
export type CacheCreationAccounting = z.infer<typeof cacheCreationAccountingSchema>;

/** Whether a provider-reported total agrees with the canonical computation. */
export const providerTotalAgreementSchema = z.enum(["unreported", "agrees", "disagrees"]);
export type ProviderTotalAgreement = z.infer<typeof providerTotalAgreementSchema>;

/**
 * What an adapter reports, before normalization.
 *
 * `inputTokens` is *inclusive*: it counts every input token the provider
 * attributes to the call, including cache reads (and cache creation when the
 * provider folds it in). `outputTokens` is likewise inclusive of reasoning
 * output. Subset fields describe portions of those totals, never additions.
 */
export const usageReportSchema = z.strictObject({
  temporality: usageTemporalitySchema,
  /** Inclusive input tokens. */
  inputTokens: tokenCountSchema.optional(),
  /** Subset of `inputTokens` served from a prompt cache. */
  cachedInputTokens: tokenCountSchema.optional(),
  /** Tokens written to a prompt cache. */
  cacheCreationInputTokens: tokenCountSchema.optional(),
  /** Required when `cacheCreationInputTokens` is present and non-zero. */
  cacheCreationAccounting: cacheCreationAccountingSchema.optional(),
  /** Inclusive output tokens. */
  outputTokens: tokenCountSchema.optional(),
  /** Subset of `outputTokens` spent on reasoning. */
  reasoningOutputTokens: tokenCountSchema.optional(),
  /** Total exactly as the provider reported it, if it reported one. */
  providerTotalTokens: tokenCountSchema.optional(),
});
export type UsageReport = z.infer<typeof usageReportSchema>;

/**
 * Fully normalized usage.
 *
 * Derived fields (`uncachedInputTokens`, `totalTokens`,
 * `providerTotalAgreement`) are part of the schema and are re-checked on parse,
 * so an inconsistent object cannot exist. Construct values with
 * {@link normalizeUsage} rather than by hand.
 */
export const canonicalUsageSchema = z
  .strictObject({
    temporality: usageTemporalitySchema,
    inputTokens: tokenCountSchema,
    cachedInputTokens: tokenCountSchema,
    cacheCreationInputTokens: tokenCountSchema,
    cacheCreationAccounting: cacheCreationAccountingSchema,
    outputTokens: tokenCountSchema,
    reasoningOutputTokens: tokenCountSchema,
    /** Derived: input tokens that were neither cache reads nor cache writes. */
    uncachedInputTokens: tokenCountSchema,
    /** Derived: canonical billable total. */
    totalTokens: tokenCountSchema,
    providerTotalTokens: tokenCountSchema.optional(),
    providerTotalAgreement: providerTotalAgreementSchema,
  })
  .check((ctx) => {
    const usage = ctx.value;
    const push = (message: string): void => {
      ctx.issues.push({ code: "custom", input: usage, message });
    };

    if (usage.cachedInputTokens > usage.inputTokens) {
      push("cachedInputTokens must not exceed inputTokens (it is a subset)");
    }
    if (usage.reasoningOutputTokens > usage.outputTokens) {
      push("reasoningOutputTokens must not exceed outputTokens (it is a subset)");
    }
    if (usage.cacheCreationAccounting === "not-reported" && usage.cacheCreationInputTokens !== 0) {
      push("cacheCreationInputTokens must be 0 when cacheCreationAccounting is not-reported");
    }
    const creationInsideInput =
      usage.cacheCreationAccounting === "included-in-input" ? usage.cacheCreationInputTokens : 0;
    if (usage.cachedInputTokens + creationInsideInput > usage.inputTokens) {
      push(
        "cachedInputTokens + cacheCreationInputTokens must not exceed inputTokens when cache creation is included in input",
      );
    }
    const expectedUncached = usage.inputTokens - usage.cachedInputTokens - creationInsideInput;
    if (expectedUncached >= 0 && usage.uncachedInputTokens !== expectedUncached) {
      push(`uncachedInputTokens must equal ${expectedUncached}`);
    }
    const creationOutsideInput =
      usage.cacheCreationAccounting === "disjoint-from-input" ? usage.cacheCreationInputTokens : 0;
    const expectedTotal = usage.inputTokens + creationOutsideInput + usage.outputTokens;
    if (usage.totalTokens !== expectedTotal) {
      push(`totalTokens must equal ${expectedTotal}`);
    }
    const expectedAgreement: ProviderTotalAgreement =
      usage.providerTotalTokens === undefined
        ? "unreported"
        : usage.providerTotalTokens === expectedTotal
          ? "agrees"
          : "disagrees";
    if (usage.providerTotalAgreement !== expectedAgreement) {
      push(`providerTotalAgreement must be ${expectedAgreement}`);
    }
  });
export type CanonicalUsage = z.infer<typeof canonicalUsageSchema>;

export type UsageNormalizationIssue = {
  readonly code:
    | "invalid-report"
    | "cached-exceeds-input"
    | "reasoning-exceeds-output"
    | "cache-creation-exceeds-input"
    | "cache-creation-accounting-missing";
  readonly message: string;
};

export type UsageNormalizationResult =
  | { readonly status: "ok"; readonly usage: CanonicalUsage; readonly notes: readonly string[] }
  | { readonly status: "invalid"; readonly issues: readonly UsageNormalizationIssue[] };

/**
 * Normalize a provider usage report into canonical usage.
 *
 * Deterministic rules:
 * 1. Absent counters default to `0`; `providerTotalTokens` stays absent.
 * 2. Non-integer, negative, or non-finite counters are rejected.
 * 3. A subset exceeding its total is rejected — never clamped — because
 *    clamping would silently invent a billing story.
 * 4. `cacheCreationAccounting` defaults to `not-reported` when no cache-creation
 *    tokens are reported, and is *required* when they are: guessing whether the
 *    bucket is disjoint would mis-total every downstream cost calculation.
 * 5. A provider total that disagrees with the canonical total is preserved as
 *    reported and flagged `disagrees`. Both numbers survive; neither is edited.
 */
export const normalizeUsage = (report: unknown): UsageNormalizationResult => {
  const parsed = usageReportSchema.safeParse(report);
  if (!parsed.success) {
    return {
      status: "invalid",
      issues: parsed.error.issues.map((issue) => ({
        code: "invalid-report" as const,
        message: `${issue.path.join(".") || "<root>"}: ${issue.message}`,
      })),
    };
  }

  const input = parsed.data;
  const issues: UsageNormalizationIssue[] = [];
  const notes: string[] = [];

  const inputTokens = input.inputTokens ?? 0;
  const cachedInputTokens = input.cachedInputTokens ?? 0;
  const cacheCreationInputTokens = input.cacheCreationInputTokens ?? 0;
  const outputTokens = input.outputTokens ?? 0;
  const reasoningOutputTokens = input.reasoningOutputTokens ?? 0;

  let accounting: CacheCreationAccounting;
  if (cacheCreationInputTokens === 0) {
    accounting = input.cacheCreationAccounting ?? "not-reported";
    if (accounting !== "not-reported") {
      notes.push(
        `cacheCreationAccounting=${accounting} retained with zero cache-creation tokens`,
      );
    }
  } else if (input.cacheCreationAccounting === undefined) {
    issues.push({
      code: "cache-creation-accounting-missing",
      message:
        "cacheCreationAccounting is required when cacheCreationInputTokens is non-zero; it cannot be inferred",
    });
    accounting = "not-reported";
  } else if (input.cacheCreationAccounting === "not-reported") {
    issues.push({
      code: "cache-creation-accounting-missing",
      message: "cacheCreationAccounting=not-reported conflicts with non-zero cacheCreationInputTokens",
    });
    accounting = "not-reported";
  } else {
    accounting = input.cacheCreationAccounting;
  }

  if (cachedInputTokens > inputTokens) {
    issues.push({
      code: "cached-exceeds-input",
      message: `cachedInputTokens (${cachedInputTokens}) exceeds inclusive inputTokens (${inputTokens})`,
    });
  }
  if (reasoningOutputTokens > outputTokens) {
    issues.push({
      code: "reasoning-exceeds-output",
      message: `reasoningOutputTokens (${reasoningOutputTokens}) exceeds inclusive outputTokens (${outputTokens})`,
    });
  }

  const creationInsideInput = accounting === "included-in-input" ? cacheCreationInputTokens : 0;
  if (cachedInputTokens + creationInsideInput > inputTokens) {
    issues.push({
      code: "cache-creation-exceeds-input",
      message: `cachedInputTokens + cacheCreationInputTokens (${cachedInputTokens + creationInsideInput}) exceeds inclusive inputTokens (${inputTokens})`,
    });
  }

  if (issues.length > 0) {
    return { status: "invalid", issues };
  }

  const creationOutsideInput = accounting === "disjoint-from-input" ? cacheCreationInputTokens : 0;
  const totalTokens = inputTokens + creationOutsideInput + outputTokens;
  const providerTotalAgreement: ProviderTotalAgreement =
    input.providerTotalTokens === undefined
      ? "unreported"
      : input.providerTotalTokens === totalTokens
        ? "agrees"
        : "disagrees";

  if (providerTotalAgreement === "disagrees") {
    notes.push(
      `providerTotalTokens (${input.providerTotalTokens ?? 0}) disagrees with canonical total (${totalTokens}); both retained`,
    );
  }

  const usage: CanonicalUsage = {
    temporality: input.temporality,
    inputTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    cacheCreationAccounting: accounting,
    outputTokens,
    reasoningOutputTokens,
    uncachedInputTokens: inputTokens - cachedInputTokens - creationInsideInput,
    totalTokens,
    ...(input.providerTotalTokens === undefined
      ? {}
      : { providerTotalTokens: input.providerTotalTokens }),
    providerTotalAgreement,
  };

  return { status: "ok", usage, notes };
};

export class UsageNormalizationError extends Error {
  public readonly issues: readonly UsageNormalizationIssue[];

  public constructor(issues: readonly UsageNormalizationIssue[]) {
    super(`invalid usage report: ${issues.map((issue) => issue.message).join("; ")}`);
    this.name = "UsageNormalizationError";
    this.issues = issues;
  }
}

/** Convenience wrapper for call sites that treat invalid usage as a bug. */
export const normalizeUsageOrThrow = (report: unknown): CanonicalUsage => {
  const result = normalizeUsage(report);
  if (result.status === "invalid") {
    throw new UsageNormalizationError(result.issues);
  }
  return result.usage;
};

export const EMPTY_DELTA_USAGE: CanonicalUsage = Object.freeze(
  normalizeUsageOrThrow({ temporality: "delta" }),
);

export type UsageDeltaResult = {
  readonly usage: CanonicalUsage;
  /**
   * True when the current snapshot is smaller than the previous one on any
   * counter. That means the cumulative series restarted (new session, replayed
   * transcript, provider reset), so the current snapshot is emitted as the delta
   * instead of a negative difference.
   */
  readonly resetDetected: boolean;
};

const requireCumulative = (usage: CanonicalUsage, label: string): void => {
  if (usage.temporality !== "cumulative") {
    throw new UsageNormalizationError([
      { code: "invalid-report", message: `${label} must have cumulative temporality` },
    ]);
  }
};

/**
 * Convert two cumulative snapshots into a delta observation.
 *
 * Replay safety: re-processing the same snapshot yields an all-zero delta, and a
 * decreasing series is reported as a reset rather than a negative delta.
 * Accounting mode must match; mixing modes would make the subtraction meaningless.
 */
export const cumulativeToDelta = (
  previous: CanonicalUsage,
  current: CanonicalUsage,
): UsageDeltaResult => {
  requireCumulative(previous, "previous usage");
  requireCumulative(current, "current usage");

  if (
    previous.cacheCreationAccounting !== current.cacheCreationAccounting &&
    previous.cacheCreationInputTokens !== 0 &&
    current.cacheCreationInputTokens !== 0
  ) {
    throw new UsageNormalizationError([
      {
        code: "cache-creation-accounting-missing",
        message: "cannot diff cumulative usage across differing cacheCreationAccounting modes",
      },
    ]);
  }

  const resetDetected =
    current.inputTokens < previous.inputTokens ||
    current.cachedInputTokens < previous.cachedInputTokens ||
    current.cacheCreationInputTokens < previous.cacheCreationInputTokens ||
    current.outputTokens < previous.outputTokens ||
    current.reasoningOutputTokens < previous.reasoningOutputTokens;

  if (resetDetected) {
    return {
      usage: normalizeUsageOrThrow({ ...toReport(current), temporality: "delta" }),
      resetDetected: true,
    };
  }

  const usage = normalizeUsageOrThrow({
    temporality: "delta",
    inputTokens: current.inputTokens - previous.inputTokens,
    cachedInputTokens: current.cachedInputTokens - previous.cachedInputTokens,
    cacheCreationInputTokens:
      current.cacheCreationInputTokens - previous.cacheCreationInputTokens,
    cacheCreationAccounting: current.cacheCreationAccounting,
    outputTokens: current.outputTokens - previous.outputTokens,
    reasoningOutputTokens: current.reasoningOutputTokens - previous.reasoningOutputTokens,
  });

  return { usage, resetDetected: false };
};

/** Project canonical usage back onto the reported shape. */
export const toReport = (usage: CanonicalUsage): UsageReport => ({
  temporality: usage.temporality,
  inputTokens: usage.inputTokens,
  cachedInputTokens: usage.cachedInputTokens,
  cacheCreationInputTokens: usage.cacheCreationInputTokens,
  cacheCreationAccounting: usage.cacheCreationAccounting,
  outputTokens: usage.outputTokens,
  reasoningOutputTokens: usage.reasoningOutputTokens,
  ...(usage.providerTotalTokens === undefined
    ? {}
    : { providerTotalTokens: usage.providerTotalTokens }),
});

/**
 * Add two delta observations. Cumulative usage is never summed, because two
 * running totals do not compose.
 */
export const addUsage = (a: CanonicalUsage, b: CanonicalUsage): CanonicalUsage => {
  if (a.temporality !== "delta" || b.temporality !== "delta") {
    throw new UsageNormalizationError([
      { code: "invalid-report", message: "only delta usage may be summed" },
    ]);
  }
  const accounting =
    a.cacheCreationInputTokens === 0 && a.cacheCreationAccounting === "not-reported"
      ? b.cacheCreationAccounting
      : b.cacheCreationInputTokens === 0 && b.cacheCreationAccounting === "not-reported"
        ? a.cacheCreationAccounting
        : a.cacheCreationAccounting;

  if (
    a.cacheCreationInputTokens !== 0 &&
    b.cacheCreationInputTokens !== 0 &&
    a.cacheCreationAccounting !== b.cacheCreationAccounting
  ) {
    throw new UsageNormalizationError([
      {
        code: "cache-creation-accounting-missing",
        message: "cannot sum usage across differing cacheCreationAccounting modes",
      },
    ]);
  }

  const providerTotal =
    a.providerTotalTokens === undefined && b.providerTotalTokens === undefined
      ? undefined
      : (a.providerTotalTokens ?? 0) + (b.providerTotalTokens ?? 0);

  return normalizeUsageOrThrow({
    temporality: "delta",
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheCreationAccounting: accounting,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningOutputTokens: a.reasoningOutputTokens + b.reasoningOutputTokens,
    ...(providerTotal === undefined ? {} : { providerTotalTokens: providerTotal }),
  });
};
