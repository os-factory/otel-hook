import { coerceClaudeUsage } from "./usage.js";

/**
 * Fold Claude Code hook and print/`-p` payload aliases onto the snake_case
 * shapes {@link claudeHookPayloadSchema} already accepts.
 *
 * Interactive Stop payloads document `last_assistant_message`. Print / `-p` /
 * Agent SDK result messages use `type: "result"` and `result` instead, and some
 * wrappers emit camelCase field names. None of these are invented: each alias
 * is a name Claude Code or its published result JSON has actually used. An
 * unrecognized shape is returned unchanged so detection can decline it.
 */

const FIELD_ALIASES = Object.freeze({
  hookEventName: "hook_event_name",
  sessionId: "session_id",
  lastAssistantMessage: "last_assistant_message",
  transcriptPath: "transcript_path",
  promptId: "prompt_id",
  toolUseId: "tool_use_id",
  toolName: "tool_name",
  toolInput: "tool_input",
  toolResponse: "tool_response",
  toolError: "tool_error",
  stopHookActive: "stop_hook_active",
  agentId: "agent_id",
  agentType: "agent_type",
  errorType: "error_type",
  errorMessage: "error_message",
  tokenUsage: "token_usage",
} as const);

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * Copy documented camelCase aliases onto their snake_case names when the
 * snake_case field is absent. Existing snake_case values win, so a payload that
 * carries both is not rewritten.
 */
const applyFieldAliases = (record: Record<string, unknown>): Record<string, unknown> => {
  const normalized: Record<string, unknown> = { ...record };
  for (const [alias, canonical] of Object.entries(FIELD_ALIASES)) {
    if (normalized[canonical] === undefined && normalized[alias] !== undefined) {
      normalized[canonical] = normalized[alias];
    }
  }
  return normalized;
};

/**
 * Claude Code print / `-p` / Agent SDK result messages are not hook events, but
 * they are the stop/result payload a non-interactive session actually produces.
 * When one arrives with a session id and no `hook_event_name`, treat it as the
 * Stop (or StopFailure) the interactive protocol would have fired.
 */
const applyPrintResultShape = (record: Record<string, unknown>): Record<string, unknown> => {
  if (record.hook_event_name !== undefined || record.type !== "result") {
    return record;
  }
  if (typeof record.session_id !== "string" || record.session_id.length === 0) {
    return record;
  }

  const isError = record.subtype === "error" || record.is_error === true;
  const normalized: Record<string, unknown> = {
    ...record,
    hook_event_name: isError ? "StopFailure" : "Stop",
  };
  if (
    normalized.last_assistant_message === undefined &&
    typeof record.result === "string" &&
    record.result.length > 0
  ) {
    normalized.last_assistant_message = record.result;
  }
  if (isError && (typeof normalized.error_type !== "string" || normalized.error_type.length === 0)) {
    normalized.error_type = "unknown";
  }
  return normalized;
};

/**
 * Return a Claude-shaped payload with documented aliases folded onto canonical
 * field names, or the original value when it is not an object.
 */
export const normalizeClaudeHookPayload = (payload: unknown): unknown => {
  const record = asRecord(payload);
  if (record === undefined) {
    return payload;
  }
  return applyUsageShape(applyPrintResultShape(applyFieldAliases(record)));
};

/**
 * Coerce `usage` / `token_usage` onto the Anthropic snake_case object the
 * Stop schema accepts, so a camelCase print-result usage object is not
 * rejected as an invalid `usage` field.
 */
const applyUsageShape = (record: Record<string, unknown>): Record<string, unknown> => {
  const usage =
    coerceClaudeUsage(record.usage) ??
    coerceClaudeUsage(record.token_usage) ??
    coerceClaudeUsage(record.tokenUsage);
  if (usage === undefined) {
    return record;
  }
  return { ...record, usage };
};
