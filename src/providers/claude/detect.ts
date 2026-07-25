import {
  asProviderId,
  providerDetectionSchema,
  type ProviderDetection,
  type ProviderDetectionInput,
} from "../adapter.js";
import { CLAUDE_HOOK_EVENT_NAMES } from "./schema.js";

/** Stable, hyphenated provider id for Claude Code. */
export const CLAUDE_CODE_PROVIDER_ID = asProviderId("claude-code");

const KNOWN_EVENT_NAMES: ReadonlySet<string> = new Set(CLAUDE_HOOK_EVENT_NAMES);

const none = (reason: string): ProviderDetection =>
  providerDetectionSchema.parse({
    providerId: "unknown",
    confidence: "none",
    reasons: [reason],
  });

/**
 * Recognize a Claude Code hook payload.
 *
 * Confidence is never `exact` from shape alone: Claude Code hook JSON has no
 * self-identifying `provider` field, so `hook_event_name` plus `session_id`
 * is the strongest evidence a shape check can offer. A caller-supplied
 * `providerHint` naming this adapter is treated as the stronger claim.
 */
export const detectClaudeCode = (input: ProviderDetectionInput): ProviderDetection => {
  const { payload } = input;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return none("payload is not a JSON object");
  }

  const record = payload as Record<string, unknown>;
  const hookEventName = record.hook_event_name;
  if (typeof hookEventName !== "string" || !KNOWN_EVENT_NAMES.has(hookEventName)) {
    return none("hook_event_name is missing or not a recognized Claude Code hook event");
  }

  const sessionId = record.session_id;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return none("session_id is missing");
  }

  const hasTranscriptPath =
    typeof record.transcript_path === "string" && record.transcript_path.length > 0;
  const hinted = input.providerHint === CLAUDE_CODE_PROVIDER_ID;

  return providerDetectionSchema.parse({
    providerId: CLAUDE_CODE_PROVIDER_ID,
    confidence: hinted ? "exact" : hasTranscriptPath ? "strong" : "weak",
    reasons: [
      `hook_event_name=${hookEventName} matches the Claude Code hooks protocol`,
      "session_id present",
      ...(hasTranscriptPath ? ["transcript_path present"] : []),
      ...(hinted ? ["caller asserted providerHint=claude-code"] : []),
    ],
    sourceEventName: hookEventName,
  });
};
