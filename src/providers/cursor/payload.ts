import { z } from "zod";

/**
 * Synthetic Cursor CLI hook payload contract.
 *
 * Provenance: every shape in this module is invented for this repository. It
 * encodes no captured Cursor transcript, path, or credential. Field names were
 * chosen to plausibly match publicly documented Cursor hook terminology
 * (`conversation_id`, `generation_id`, `hook_event_name`, `workspace_roots`),
 * but the exact envelope, the "legacy" snake_case generation, and every
 * event-specific field are a self-consistent invention for exercising the
 * provider-adapter boundary (ADR 0003).
 *
 * Two payload generations are modelled:
 * - "current": camelCase keys, current hook event names.
 * - "legacy": snake_case keys, older hook event names, tagged only by that
 *   naming convention. `normalizeCursorPayload` folds legacy payloads onto the
 *   current shape so the adapter has one interpretation path.
 *
 * Durations and timestamps are documented as milliseconds throughout.
 */

export const CURSOR_PROVIDER_ID = "cursor" as const;

/** Current (camelCase) hook event names — the contract this adapter targets. */
export const CURSOR_HOOK_EVENT_NAMES = [
  "sessionStart",
  "sessionEnd",
  "beforeSubmitPrompt",
  "afterAgentResponse",
  "beforeToolUse",
  "afterToolUse",
  "toolUseFailed",
  "beforeShellExecution",
  "afterShellExecution",
  "beforeMCPExecution",
  "afterMCPExecution",
  "subagentStart",
  "subagentStop",
  "preCompact",
  "stop",
  "afterFileEdit",
  "beforeReadFile",
  "afterAgentThought",
] as const;
export type CursorHookEventName = (typeof CURSOR_HOOK_EVENT_NAMES)[number];

/**
 * Legacy (snake_case) hook event names mapped 1:1 onto the current names.
 * Most are a pure case-convention change; three (`before_user_prompt`,
 * `after_agent_turn`, `agent_stop`) are genuine renames, kept to exercise
 * alias resolution beyond casing.
 */
export const LEGACY_TO_CURRENT_EVENT_NAME: Readonly<Record<string, CursorHookEventName>> =
  Object.freeze({
    session_start: "sessionStart",
    session_end: "sessionEnd",
    before_user_prompt: "beforeSubmitPrompt",
    after_agent_turn: "afterAgentResponse",
    before_tool_use: "beforeToolUse",
    after_tool_use: "afterToolUse",
    tool_use_failed: "toolUseFailed",
    before_shell_execution: "beforeShellExecution",
    after_shell_execution: "afterShellExecution",
    before_mcp_execution: "beforeMCPExecution",
    after_mcp_execution: "afterMCPExecution",
    subagent_start: "subagentStart",
    subagent_stop: "subagentStop",
    pre_compact: "preCompact",
    agent_stop: "stop",
    after_file_edit: "afterFileEdit",
    before_read_file: "beforeReadFile",
    after_agent_thought: "afterAgentThought",
  });

const modelInputSchema = z.strictObject({
  name: z.string().min(1),
  provider: z.string().min(1).optional(),
});
export type CursorModelInput = z.infer<typeof modelInputSchema>;

const openShellInvocationSchema = z.strictObject({
  toolCallId: z.string().min(1),
  command: z.string().min(1),
});

const openMcpInvocationSchema = z.strictObject({
  toolCallId: z.string().min(1),
  server: z.string().min(1),
  tool: z.string().min(1),
});

const outcomeLabelSchema = z.enum(["ok", "error", "cancelled", "timeout"]);
const toolKindLabelSchema = z.enum([
  "read",
  "write",
  "execute",
  "search",
  "network",
  "delegate",
  "other",
]);

/**
 * Fields shared by every current-shape hook payload. `generationId` is
 * deliberately not here: whether it is required, optional, or absent differs
 * per event, and each event schema below declares it explicitly.
 */
const envelopeShape = {
  conversationId: z.string().min(1),
  workspaceRoots: z.array(z.string().min(1)).max(16).optional(),
  model: modelInputSchema.optional(),
  timestampMillis: z.number().int().min(0),
  agentVersion: z.string().min(1).optional(),
};

const event = <TName extends CursorHookEventName, TShape extends z.ZodRawShape>(
  name: TName,
  shape: TShape,
) => z.strictObject({ ...envelopeShape, hookEventName: z.literal(name), ...shape });

const sessionStartPayloadSchema = event("sessionStart", {
  sessionKind: z.enum(["interactive", "non-interactive"]).optional(),
  agentName: z.string().min(1).optional(),
});

const sessionEndPayloadSchema = event("sessionEnd", {
  reason: z.enum(["completed", "aborted", "error", "timeout"]).optional(),
  durationMillis: z.number().min(0).optional(),
});

const beforeSubmitPromptPayloadSchema = event("beforeSubmitPrompt", {
  generationId: z.string().min(1),
  promptSource: z.enum(["user", "automation", "resumed"]).optional(),
  promptText: z.string().optional(),
  turnIndex: z.number().int().min(0).optional(),
});

const afterAgentResponsePayloadSchema = event("afterAgentResponse", {
  generationId: z.string().min(1),
  responseText: z.string().optional(),
  durationMillis: z.number().min(0).optional(),
  outcome: outcomeLabelSchema.optional(),
});

const beforeToolUsePayloadSchema = event("beforeToolUse", {
  generationId: z.string().min(1).optional(),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  toolKind: toolKindLabelSchema.optional(),
  toolInput: z.unknown().optional(),
});

const afterToolUsePayloadSchema = event("afterToolUse", {
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  toolOutput: z.unknown().optional(),
  durationMillis: z.number().min(0).optional(),
});

const toolUseFailedPayloadSchema = event("toolUseFailed", {
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  errorText: z.string().optional(),
  durationMillis: z.number().min(0).optional(),
});

const beforeShellExecutionPayloadSchema = event("beforeShellExecution", {
  generationId: z.string().min(1).optional(),
  toolCallId: z.string().min(1).optional(),
  command: z.string().min(1),
});

const afterShellExecutionPayloadSchema = event("afterShellExecution", {
  toolCallId: z.string().min(1).optional(),
  command: z.string().min(1),
  exitCode: z.number().int().optional(),
  outputText: z.string().optional(),
  durationMillis: z.number().min(0).optional(),
  openInvocations: z.array(openShellInvocationSchema).max(64).optional(),
});

const beforeMCPExecutionPayloadSchema = event("beforeMCPExecution", {
  generationId: z.string().min(1).optional(),
  toolCallId: z.string().min(1).optional(),
  server: z.string().min(1),
  tool: z.string().min(1),
  input: z.unknown().optional(),
});

const afterMCPExecutionPayloadSchema = event("afterMCPExecution", {
  toolCallId: z.string().min(1).optional(),
  server: z.string().min(1),
  tool: z.string().min(1),
  output: z.unknown().optional(),
  durationMillis: z.number().min(0).optional(),
  isError: z.boolean().optional(),
  openInvocations: z.array(openMcpInvocationSchema).max(64).optional(),
});

const subagentStartPayloadSchema = event("subagentStart", {
  subagentInvocationId: z.string().min(1),
  subagentType: z.string().min(1).optional(),
  delegationDepth: z.number().int().min(0).max(64).optional(),
});

const subagentStopPayloadSchema = event("subagentStop", {
  subagentInvocationId: z.string().min(1),
  outcome: outcomeLabelSchema.optional(),
  durationMillis: z.number().min(0).optional(),
});

const preCompactPayloadSchema = event("preCompact", {
  trigger: z.enum(["automatic", "manual"]).optional(),
  contextTokensBefore: z.number().int().min(0).optional(),
});

const stopPayloadSchema = event("stop", {
  generationId: z.string().min(1),
  stopReason: z.enum(["completed", "cancelled", "error", "timeout"]),
  /** Whether `afterAgentResponse` already reported this generation's outcome. */
  generationCompleted: z.boolean(),
  durationMillis: z.number().min(0).optional(),
});

const afterFileEditPayloadSchema = event("afterFileEdit", {
  generationId: z.string().min(1).optional(),
  toolCallId: z.string().min(1).optional(),
  filePath: z.string().min(1),
  editKind: z.enum(["create", "modify", "delete"]).optional(),
});

const beforeReadFilePayloadSchema = event("beforeReadFile", {
  generationId: z.string().min(1).optional(),
  toolCallId: z.string().min(1).optional(),
  filePath: z.string().min(1),
});

const afterAgentThoughtPayloadSchema = event("afterAgentThought", {
  generationId: z.string().min(1),
  thoughtText: z.string().optional(),
  thoughtIndex: z.number().int().min(0).optional(),
});

export const cursorPayloadSchema = z.discriminatedUnion("hookEventName", [
  sessionStartPayloadSchema,
  sessionEndPayloadSchema,
  beforeSubmitPromptPayloadSchema,
  afterAgentResponsePayloadSchema,
  beforeToolUsePayloadSchema,
  afterToolUsePayloadSchema,
  toolUseFailedPayloadSchema,
  beforeShellExecutionPayloadSchema,
  afterShellExecutionPayloadSchema,
  beforeMCPExecutionPayloadSchema,
  afterMCPExecutionPayloadSchema,
  subagentStartPayloadSchema,
  subagentStopPayloadSchema,
  preCompactPayloadSchema,
  stopPayloadSchema,
  afterFileEditPayloadSchema,
  beforeReadFilePayloadSchema,
  afterAgentThoughtPayloadSchema,
]);
export type CursorPayload = z.infer<typeof cursorPayloadSchema>;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const snakeToCamelKey = (key: string): string => key.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());

const deepSnakeToCamel = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(deepSnakeToCamel);
  }
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[snakeToCamelKey(key)] = deepSnakeToCamel(entry);
    }
    return result;
  }
  return value;
};

export type NormalizedCursorPayload = {
  /** Validated, current-shape payload the adapter builds events from. */
  readonly payload: CursorPayload;
  /** The exact event-name string the source payload used, current or legacy. */
  readonly rawEventName: string;
  readonly isLegacy: boolean;
};

/**
 * Recognize and normalize a raw hook payload.
 *
 * Legacy (snake_case) payloads are deep-transformed to camelCase keys and their
 * event name is resolved through the alias table before validation, so the rest
 * of the adapter only ever handles the current shape.
 */
export const normalizeCursorPayload = (payload: unknown): NormalizedCursorPayload | undefined => {
  if (!isPlainObject(payload)) {
    return undefined;
  }

  if (typeof payload.hookEventName === "string") {
    const parsed = cursorPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      return undefined;
    }
    return { payload: parsed.data, rawEventName: payload.hookEventName, isLegacy: false };
  }

  if (typeof payload.hook_event_name === "string") {
    const rawEventName = payload.hook_event_name;
    const current = LEGACY_TO_CURRENT_EVENT_NAME[rawEventName];
    if (current === undefined) {
      return undefined;
    }
    const camelCased = deepSnakeToCamel(payload);
    const candidate = isPlainObject(camelCased) ? { ...camelCased, hookEventName: current } : undefined;
    const parsed = cursorPayloadSchema.safeParse(candidate);
    if (!parsed.success) {
      return undefined;
    }
    return { payload: parsed.data, rawEventName, isLegacy: true };
  }

  return undefined;
};
