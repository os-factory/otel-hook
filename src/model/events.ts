import { z } from "zod";

import {
  errorPhaseSchema,
  errorSeveritySchema,
  otelHookErrorCodeSchema,
} from "../errors/taxonomy.js";
import { contentFactSchema, contentFactsSchema } from "./content.js";
import { extensionsSchema, emptyExtensions } from "./extensions.js";
import { sourceProvenanceSchema, workspaceIdentitySchema } from "./identity.js";
import {
  durationMillisSchema,
  epochMillisSchema,
  eventIdSchema,
  invocationIdSchema,
  nonEmptyStringSchema,
  sequenceNumberSchema,
  sessionIdSchema,
  tokenCountSchema,
} from "./primitives.js";
import { canonicalUsageSchema, type CanonicalUsage } from "./usage.js";
import { canonicalSchemaVersionSchema } from "./version.js";

/** Model being invoked. Model identifiers are not treated as sensitive. */
export const modelDescriptorSchema = z.strictObject({
  modelId: nonEmptyStringSchema,
  /** Vendor of the model, e.g. `anthropic`. Distinct from the agent provider. */
  vendor: nonEmptyStringSchema.optional(),
  family: nonEmptyStringSchema.optional(),
});
export type ModelDescriptor = z.infer<typeof modelDescriptorSchema>;

export const costFactsSchema = z.strictObject({
  /** ISO 4217 code. */
  currency: z.string().length(3),
  amount: z.number().min(0).finite(),
  source: z.enum(["provider-reported", "computed"]),
});
export type CostFacts = z.infer<typeof costFactsSchema>;

export const canonicalEventTypeSchema = z.enum([
  "session.start",
  "session.end",
  "prompt.submitted",
  "generation.start",
  "generation.end",
  "tool.start",
  "tool.end",
  "subagent.start",
  "subagent.end",
  "compaction.performed",
  "error.raised",
]);
export type CanonicalEventType = z.infer<typeof canonicalEventTypeSchema>;

export const CANONICAL_EVENT_TYPES = canonicalEventTypeSchema.options;

const outcomeSchema = z.enum(["ok", "error", "cancelled", "timeout", "denied", "unknown"]);
export type EventOutcome = z.infer<typeof outcomeSchema>;

/**
 * Fields present on every canonical event.
 *
 * Identity fields are duplicated onto each event rather than referenced through
 * shared state, so an event is self-describing once it leaves the process.
 */
const baseEventFields = {
  schemaVersion: canonicalSchemaVersionSchema,
  eventId: eventIdSchema,
  invocationId: invocationIdSchema,
  sessionId: sessionIdSchema,
  /** Per-invocation ordering key. Stable across replays of the same input. */
  sequence: sequenceNumberSchema,
  occurredAt: epochMillisSchema,
  provenance: sourceProvenanceSchema,
  workspace: workspaceIdentitySchema,
  extensions: extensionsSchema.default(emptyExtensions),
} as const;

const event = <TShape extends z.ZodRawShape>(shape: TShape) =>
  z.strictObject({ ...baseEventFields, ...shape });

export const sessionStartEventSchema = event({
  type: z.literal("session.start"),
  sessionKind: z.enum(["interactive", "non-interactive", "unknown"]),
  agentName: nonEmptyStringSchema.optional(),
  agentVersion: nonEmptyStringSchema.optional(),
  model: modelDescriptorSchema.optional(),
});

export const sessionEndEventSchema = event({
  type: z.literal("session.end"),
  reason: z.enum(["completed", "aborted", "error", "timeout", "unknown"]),
  durationMillis: durationMillisSchema.optional(),
  /** Session totals, typically cumulative. */
  usage: canonicalUsageSchema.optional(),
  cost: costFactsSchema.optional(),
});

export const promptSubmittedEventSchema = event({
  type: z.literal("prompt.submitted"),
  promptSource: z.enum(["user", "automation", "resumed", "unknown"]),
  content: contentFactSchema.optional(),
  turnIndex: z.number().int().min(0).optional(),
});

export const generationStartEventSchema = event({
  type: z.literal("generation.start"),
  generationId: nonEmptyStringSchema,
  model: modelDescriptorSchema,
  requestedMaxOutputTokens: tokenCountSchema.optional(),
  inputContent: contentFactsSchema.optional(),
});

export const generationEndEventSchema = event({
  type: z.literal("generation.end"),
  generationId: nonEmptyStringSchema,
  model: modelDescriptorSchema,
  outcome: outcomeSchema,
  stopReason: nonEmptyStringSchema.optional(),
  durationMillis: durationMillisSchema.optional(),
  usage: canonicalUsageSchema.optional(),
  cost: costFactsSchema.optional(),
  outputContent: contentFactsSchema.optional(),
});

export const toolKindSchema = z.enum([
  "read",
  "write",
  "execute",
  "search",
  "network",
  "delegate",
  "other",
  "unknown",
]);
export type ToolKind = z.infer<typeof toolKindSchema>;

export const toolStartEventSchema = event({
  type: z.literal("tool.start"),
  toolCallId: nonEmptyStringSchema,
  toolName: nonEmptyStringSchema,
  toolKind: toolKindSchema,
  generationId: nonEmptyStringSchema.optional(),
  input: contentFactSchema.optional(),
});

export const toolEndEventSchema = event({
  type: z.literal("tool.end"),
  toolCallId: nonEmptyStringSchema,
  toolName: nonEmptyStringSchema,
  outcome: outcomeSchema,
  durationMillis: durationMillisSchema.optional(),
  /** Present when the host asked for or recorded a permission decision. */
  permissionDecision: z.enum(["allowed", "denied", "deferred", "not-required"]).optional(),
  output: contentFactSchema.optional(),
});

export const subagentStartEventSchema = event({
  type: z.literal("subagent.start"),
  subagentInvocationId: invocationIdSchema,
  subagentType: nonEmptyStringSchema.optional(),
  /** 0 for the top-level agent; 1 for its direct children. */
  delegationDepth: z.number().int().min(0).max(64),
  model: modelDescriptorSchema.optional(),
});

export const subagentEndEventSchema = event({
  type: z.literal("subagent.end"),
  subagentInvocationId: invocationIdSchema,
  outcome: outcomeSchema,
  durationMillis: durationMillisSchema.optional(),
  usage: canonicalUsageSchema.optional(),
});

export const compactionPerformedEventSchema = event({
  type: z.literal("compaction.performed"),
  trigger: z.enum(["automatic", "manual", "unknown"]),
  /** Provider-reported context size before and after compaction, if known. */
  contextTokensBefore: tokenCountSchema.optional(),
  contextTokensAfter: tokenCountSchema.optional(),
  droppedMessageCount: z.number().int().min(0).optional(),
  usage: canonicalUsageSchema.optional(),
});

export const errorRaisedEventSchema = event({
  type: z.literal("error.raised"),
  errorCode: otelHookErrorCodeSchema,
  severity: errorSeveritySchema,
  phase: errorPhaseSchema,
  retryable: z.boolean(),
  /** Error text is content: it is described, never embedded verbatim by default. */
  message: contentFactSchema.optional(),
  /** Non-sensitive, provider-agnostic short label. */
  detail: nonEmptyStringSchema.optional(),
});

export const canonicalEventSchema = z.discriminatedUnion("type", [
  sessionStartEventSchema,
  sessionEndEventSchema,
  promptSubmittedEventSchema,
  generationStartEventSchema,
  generationEndEventSchema,
  toolStartEventSchema,
  toolEndEventSchema,
  subagentStartEventSchema,
  subagentEndEventSchema,
  compactionPerformedEventSchema,
  errorRaisedEventSchema,
]);

export type CanonicalEvent = z.infer<typeof canonicalEventSchema>;
export type CanonicalEventInput = z.input<typeof canonicalEventSchema>;

export type SessionStartEvent = z.infer<typeof sessionStartEventSchema>;
export type SessionEndEvent = z.infer<typeof sessionEndEventSchema>;
export type PromptSubmittedEvent = z.infer<typeof promptSubmittedEventSchema>;
export type GenerationStartEvent = z.infer<typeof generationStartEventSchema>;
export type GenerationEndEvent = z.infer<typeof generationEndEventSchema>;
export type ToolStartEvent = z.infer<typeof toolStartEventSchema>;
export type ToolEndEvent = z.infer<typeof toolEndEventSchema>;
export type SubagentStartEvent = z.infer<typeof subagentStartEventSchema>;
export type SubagentEndEvent = z.infer<typeof subagentEndEventSchema>;
export type CompactionPerformedEvent = z.infer<typeof compactionPerformedEventSchema>;
export type ErrorRaisedEvent = z.infer<typeof errorRaisedEventSchema>;

export type CanonicalEventOfType<TType extends CanonicalEventType> = Extract<
  CanonicalEvent,
  { type: TType }
>;

export type EventValidationResult =
  | { readonly status: "ok"; readonly event: CanonicalEvent }
  | { readonly status: "invalid"; readonly issues: readonly string[] };

export const validateCanonicalEvent = (value: unknown): EventValidationResult => {
  const parsed = canonicalEventSchema.safeParse(value);
  if (parsed.success) {
    return { status: "ok", event: parsed.data };
  }
  return {
    status: "invalid",
    issues: parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`,
    ),
  };
};

/** Parse or throw. Intended for fixtures and tests, not the hook path. */
export const parseCanonicalEvent = (value: unknown): CanonicalEvent =>
  canonicalEventSchema.parse(value);

/** Usage carried by an event, if the event type can carry any. */
export const eventUsage = (event: CanonicalEvent): CanonicalUsage | undefined =>
  "usage" in event ? event.usage : undefined;

/** Stable ordering: by sequence, then by timestamp, then by event id. */
export const compareEvents = (a: CanonicalEvent, b: CanonicalEvent): number =>
  a.sequence - b.sequence || a.occurredAt - b.occurredAt || a.eventId.localeCompare(b.eventId);
