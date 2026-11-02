import { z } from "zod";

/**
 * Raw hook payload shapes for Google Antigravity.
 *
 * Provenance: the published hooks reference at `antigravity.google/docs/hooks`,
 * read 2026-11-02. Every example on that page is camelCase JSON on stdin, and
 * none of them carries `hookEventName` or any other event discriminator. A
 * secondary note (agenticcontrolplane.com, checked against `agy` 1.1.21) states
 * the same absence. `google-antigravity/antigravity-cli` issue 49 records one
 * real `PreToolUse` key set — `conversationId`, `workspacePaths`,
 * `transcriptPath`, `stepIdx`, `toolCall` — and explicitly no model id and no
 * usage. No fixture in this package copies that report's paths or values.
 *
 * Because stdin does not name the event, two documented pairs are not
 * disjoint: `PreInvocation` and `PostInvocation` share `invocationNum` and
 * `initialNumSteps`, and `PreToolUse` shares `toolCall` plus `stepIdx` with a
 * `PostToolUse` that omits the optional `error` string. This module classifies
 * only the shapes the reference makes unique. It does not treat a reconstructed
 * `hookEventName` as evidence.
 */

export const ANTIGRAVITY_HOOK_EVENT_NAMES = [
  "SessionStart",
  "PreToolUse",
  "PostToolUse",
  "PreInvocation",
  "PostInvocation",
  "Stop",
] as const;
export type AntigravityHookEventName = (typeof ANTIGRAVITY_HOOK_EVENT_NAMES)[number];

/** Tool events are matcher groups. The other four events are bare handler lists. */
export const ANTIGRAVITY_TOOL_HOOK_EVENT_NAMES = ["PreToolUse", "PostToolUse"] as const;
export type AntigravityToolHookEventName = (typeof ANTIGRAVITY_TOOL_HOOK_EVENT_NAMES)[number];

export const ANTIGRAVITY_DIRECT_HOOK_EVENT_NAMES = [
  "SessionStart",
  "PreInvocation",
  "PostInvocation",
  "Stop",
] as const;

/**
 * The tool the reference documents as spawning subagents. It is a tool name,
 * not a subagent lifecycle hook — Antigravity documents no such hook.
 */
export const ANTIGRAVITY_SUBAGENT_TOOL_NAME = "invoke_subagent" as const;

const commonSchema = z
  .object({
    conversationId: z.string().min(1),
    workspacePaths: z.array(z.string().min(1)).max(64),
    /** Never disclosed: a filesystem path. Accepted, never propagated. */
    transcriptPath: z.string().min(1).optional(),
    /** Never disclosed: a filesystem path. Accepted, never propagated. */
    artifactDirectoryPath: z.string().min(1).optional(),
    /**
     * Documented on every hook. Optional in this schema because a captured
     * CLI `PreToolUse` omitted it (antigravity-cli issue 49). Never invented
     * when absent, and never read as usage.
     */
    modelName: z.string().min(1).optional(),
  })
  .passthrough();
export type AntigravityCommonPayload = z.infer<typeof commonSchema>;

const toolCallSchema = z
  .object({
    name: z.string().min(1),
    args: z.unknown().optional(),
  })
  .passthrough();

const toolSchema = commonSchema.extend({
  toolCall: toolCallSchema,
  stepIdx: z.number().int().min(0),
  error: z.string().optional(),
});
export type AntigravityToolPayload = z.infer<typeof toolSchema>;

const invocationSchema = commonSchema.extend({
  invocationNum: z.number().int().min(0),
  initialNumSteps: z.number().int().min(0),
});
export type AntigravityInvocationPayload = z.infer<typeof invocationSchema>;

const stopSchema = commonSchema.extend({
  executionNum: z.number().int().min(0),
  terminationReason: z.string().min(1),
  fullyIdle: z.boolean(),
  error: z.string().optional(),
});
export type AntigravityStopPayload = z.infer<typeof stopSchema>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOwn = (record: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key);

const FAMILY_KEYS = [
  "toolCall",
  "stepIdx",
  "invocationNum",
  "initialNumSteps",
  "fullyIdle",
  "executionNum",
  "terminationReason",
  "error",
] as const;

export type AntigravityClassification =
  | { readonly status: "none" }
  | { readonly status: "weak"; readonly family: "tool" | "other" }
  | {
      readonly status: "exact";
      readonly kind: "session-start";
      readonly sourceEventName: "SessionStart";
      readonly payload: AntigravityCommonPayload;
    }
  | {
      readonly status: "exact";
      readonly kind: "tool-after";
      readonly sourceEventName: "PostToolUse";
      readonly payload: AntigravityToolPayload;
    }
  | {
      readonly status: "exact";
      readonly kind: "tool-absent";
      readonly sourceEventName: "PostToolUse" | undefined;
      readonly payload: AntigravityCommonPayload & { readonly stepIdx: number };
    }
  | {
      readonly status: "exact";
      readonly kind: "tool-ambiguous";
      readonly payload: AntigravityToolPayload;
    }
  | {
      readonly status: "exact";
      readonly kind: "invocation-ambiguous";
      readonly payload: AntigravityInvocationPayload;
    }
  | {
      readonly status: "exact";
      readonly kind: "stop";
      readonly sourceEventName: "Stop";
      readonly payload: AntigravityStopPayload;
    };

const weak = (record: Record<string, unknown>): AntigravityClassification => ({
  status: "weak",
  family: hasOwn(record, "toolCall") || hasOwn(record, "stepIdx") ? "tool" : "other",
});

const errorDisposition = (record: Record<string, unknown>): "absent" | "string" | "invalid" => {
  if (!hasOwn(record, "error")) {
    return "absent";
  }
  return typeof record.error === "string" ? "string" : "invalid";
};

/**
 * Classify one stdin payload.
 *
 * `none` is not Antigravity. `weak` names the provider but is not a documented
 * input. `exact` is a documented input; `sourceEventName` is set only when a
 * single event owns that shape.
 */
export const classifyAntigravityPayload = (value: unknown): AntigravityClassification => {
  if (!isRecord(value) || typeof value.conversationId !== "string" || value.conversationId.length === 0) {
    return { status: "none" };
  }

  const stopFamily =
    hasOwn(value, "fullyIdle") || hasOwn(value, "executionNum") || hasOwn(value, "terminationReason");
  if (stopFamily) {
    if (errorDisposition(value) === "invalid") {
      return weak(value);
    }
    const parsed = stopSchema.safeParse(value);
    return parsed.success
      ? { status: "exact", kind: "stop", sourceEventName: "Stop", payload: parsed.data }
      : weak(value);
  }

  const toolFamily = hasOwn(value, "toolCall") || hasOwn(value, "stepIdx");
  if (toolFamily) {
    const error = errorDisposition(value);
    if (error === "invalid") {
      return weak(value);
    }
    if (value.toolCall === null && typeof value.stepIdx === "number" && Number.isInteger(value.stepIdx)) {
      const common = commonSchema.safeParse(value);
      if (!common.success || value.stepIdx < 0) {
        return weak(value);
      }
      return {
        status: "exact",
        kind: "tool-absent",
        ...(error === "string" ? { sourceEventName: "PostToolUse" as const } : {}),
        payload: { ...common.data, stepIdx: value.stepIdx },
      };
    }
    const parsed = toolSchema.safeParse(value);
    if (!parsed.success) {
      return weak(value);
    }
    if (error === "string") {
      return { status: "exact", kind: "tool-after", sourceEventName: "PostToolUse", payload: parsed.data };
    }
    return { status: "exact", kind: "tool-ambiguous", payload: parsed.data };
  }

  const invocationFamily = hasOwn(value, "invocationNum") || hasOwn(value, "initialNumSteps");
  if (invocationFamily) {
    const parsed = invocationSchema.safeParse(value);
    return parsed.success
      ? { status: "exact", kind: "invocation-ambiguous", payload: parsed.data }
      : weak(value);
  }

  if (FAMILY_KEYS.some((key) => hasOwn(value, key))) {
    return weak(value);
  }
  const parsed = commonSchema.safeParse(value);
  return parsed.success
    ? { status: "exact", kind: "session-start", sourceEventName: "SessionStart", payload: parsed.data }
    : weak(value);
};

/** True when this classification is a complete documented input. */
export const isExactAntigravityClassification = (
  classification: AntigravityClassification,
): classification is Extract<AntigravityClassification, { status: "exact" }> => classification.status === "exact";
