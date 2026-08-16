/**
 * Locate assistant text on a Claude Code Stop / print-result payload.
 *
 * Field names are the ones Claude Code and its published `-p` / Agent SDK
 * result JSON have used. The first non-empty string wins. Empty strings and
 * missing fields are treated as "the provider sent nothing" — this module
 * never invents text.
 */

const TOP_LEVEL_TEXT_FIELDS = [
  "last_assistant_message",
  "lastAssistantMessage",
  "result",
  "assistant_message",
  "final_message",
] as const;

const MESSAGE_TEXT_FIELDS = ["content", "text", "result"] as const;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const textFromContentBlocks = (value: unknown): string | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const block of value) {
    const record = asRecord(block);
    if (record === undefined) {
      continue;
    }
    const text = nonEmptyString(record.text);
    if (text !== undefined && (record.type === undefined || record.type === "text")) {
      parts.push(text);
    }
  }
  return parts.length === 0 ? undefined : parts.join("");
};

/**
 * Return the assistant text Claude sent on this stop/result payload, or
 * `undefined` when no non-empty string was present.
 */
export const extractClaudeAssistantText = (payload: unknown): string | undefined => {
  const record = asRecord(payload);
  if (record === undefined) {
    return undefined;
  }

  for (const field of TOP_LEVEL_TEXT_FIELDS) {
    const text = nonEmptyString(record[field]);
    if (text !== undefined) {
      return text;
    }
  }

  const messageText = nonEmptyString(record.message);
  if (messageText !== undefined) {
    return messageText;
  }

  const message = asRecord(record.message);
  if (message === undefined) {
    return undefined;
  }
  for (const field of MESSAGE_TEXT_FIELDS) {
    const text = nonEmptyString(message[field]) ?? textFromContentBlocks(message[field]);
    if (text !== undefined) {
      return text;
    }
  }
  return undefined;
};
