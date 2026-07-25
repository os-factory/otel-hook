import { z } from "zod";

/**
 * Raw hook payload shapes for Google Antigravity.
 *
 * Provenance: synthetic, reconstructed from the documented camelCase command
 * hooks and field names the integration task specified as verified —
 * `conversationId`, `workspacePaths`, `stepIdx`, `invocationNum`,
 * `transcriptPath`, `artifactDirectoryPath` — plus the five hook names
 * (`PreInvocation`, `PostInvocation`, `PreToolUse`, `PostToolUse`, `Stop`).
 * Every other field below (`toolName`, `toolInput`, `toolResponse`, `isError`,
 * `fullyIdle`, `agentVersion`) is an inferred reconstruction needed for the
 * hook to carry any tool or lifecycle fact at all; none of it has been
 * confirmed against a real Antigravity capture. See `./maturity.ts` for the
 * promotion gates that require that confirmation. No fixture in this package
 * is a copy of a real transcript, path, or credential.
 */

export const ANTIGRAVITY_HOOK_EVENT_NAMES = [
  "PreInvocation",
  "PostInvocation",
  "PreToolUse",
  "PostToolUse",
  "Stop",
] as const;
export type AntigravityHookEventName = (typeof ANTIGRAVITY_HOOK_EVENT_NAMES)[number];

const hookEventNameSchema = z.enum(ANTIGRAVITY_HOOK_EVENT_NAMES);

/**
 * Loose shape check used only to recognize a malformed-but-clearly-Antigravity
 * payload: unknown keys pass through so additive fields degrade safely.
 */
export const antigravityWeakShapeSchema = z.object({ hookEventName: hookEventNameSchema }).passthrough();

const commonFields = {
  conversationId: z.string().min(1),
  workspacePaths: z.array(z.string().min(1)).max(64),
  invocationNum: z.number().int().min(0),
  /** Never disclosed: a real filesystem path. Accepted, never propagated. */
  transcriptPath: z.string().min(1).optional(),
  /** Never disclosed: a real filesystem path. Accepted, never propagated. */
  artifactDirectoryPath: z.string().min(1).optional(),
};

export const preInvocationPayloadSchema = z.object({
  hookEventName: z.literal("PreInvocation"),
  ...commonFields,
  agentVersion: z.string().min(1).optional(),
});
export type PreInvocationPayload = z.infer<typeof preInvocationPayloadSchema>;

export const postInvocationPayloadSchema = z.object({
  hookEventName: z.literal("PostInvocation"),
  ...commonFields,
  agentVersion: z.string().min(1).optional(),
});
export type PostInvocationPayload = z.infer<typeof postInvocationPayloadSchema>;

export const preToolUsePayloadSchema = z.object({
  hookEventName: z.literal("PreToolUse"),
  ...commonFields,
  stepIdx: z.number().int().min(0),
  toolName: z.string().min(1),
  toolInput: z.unknown().optional(),
});
export type PreToolUsePayload = z.infer<typeof preToolUsePayloadSchema>;

export const postToolUsePayloadSchema = z.object({
  hookEventName: z.literal("PostToolUse"),
  ...commonFields,
  stepIdx: z.number().int().min(0),
  toolName: z.string().min(1),
  toolResponse: z.unknown().optional(),
  isError: z.boolean().optional(),
});
export type PostToolUsePayload = z.infer<typeof postToolUsePayloadSchema>;

export const stopPayloadSchema = z.object({
  hookEventName: z.literal("Stop"),
  ...commonFields,
  fullyIdle: z.boolean(),
});
export type StopPayload = z.infer<typeof stopPayloadSchema>;

export const antigravityHookPayloadSchema = z.discriminatedUnion("hookEventName", [
  preInvocationPayloadSchema,
  postInvocationPayloadSchema,
  preToolUsePayloadSchema,
  postToolUsePayloadSchema,
  stopPayloadSchema,
]);
export type AntigravityHookPayload = z.infer<typeof antigravityHookPayloadSchema>;

/** The tool name documented as the experimental subagent-delegation relationship. */
export const ANTIGRAVITY_SUBAGENT_TOOL_NAME = "invoke_subagent" as const;
