import { sessionIdSchema, type SessionId } from "../../model/primitives.js";
import { deriveWorkspaceIdentity } from "../../privacy/workspace.js";
import type { WorkspaceIdentity } from "../../model/identity.js";
import type { ProviderContext } from "../adapter.js";
import type { GeminiHookInput } from "./schema.js";

/** Deterministic, sorted-key serialization used to derive content-addressed ids. */
export const stableKey = (value: unknown): string => {
  const seen = new WeakSet<object>();
  const walk = (input: unknown): string => {
    if (input === null || input === undefined) {
      return "null";
    }
    if (typeof input === "string") {
      return JSON.stringify(input);
    }
    if (typeof input === "number") {
      return Number.isFinite(input) ? JSON.stringify(input) : "null";
    }
    if (typeof input === "boolean") {
      return input ? "true" : "false";
    }
    if (typeof input !== "object") {
      return "null";
    }
    if (seen.has(input)) {
      return '"<circular>"';
    }
    seen.add(input);
    if (Array.isArray(input)) {
      return `[${input.map((entry) => walk(entry)).join(",")}]`;
    }
    const record = input as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${walk(record[key])}`).join(",")}}`;
  };
  return walk(value);
};

export const geminiSessionId = (input: GeminiHookInput): SessionId => sessionIdSchema.parse(input.session_id);

/** `undefined` when the timestamp is absent or unparsable; the caller supplies a fallback. */
export const parseGeminiTimestamp = (timestamp: string | undefined): number | undefined => {
  if (timestamp === undefined) {
    return undefined;
  }
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? undefined : parsed;
};

export const geminiWorkspace = (
  context: ProviderContext,
  input: GeminiHookInput,
): WorkspaceIdentity | undefined =>
  input.cwd === undefined
    ? undefined
    : deriveWorkspaceIdentity(context.privacy, { kind: "working-directory", absolutePath: input.cwd });

/**
 * Stable content used to key a tool call across its `BeforeTool`/`AfterTool`
 * pair. Deliberately excludes `tool_input`: a preceding hook may rewrite the
 * arguments before the tool runs (`hookSpecificOutput.tool_input`), so the
 * `AfterTool` payload's echoed input can legitimately differ from what
 * `BeforeTool` observed. Keying on the tool name alone survives that rewrite;
 * the trade-off is that two calls to the same tool in a row within one turn are
 * not distinguishable from this protocol alone (see gemini adapter gaps).
 */
export const geminiToolCallKey = (input: {
  readonly tool_name: string;
  readonly original_request_name?: string | undefined;
}): string => input.original_request_name ?? input.tool_name;

export const geminiToolCallId = (
  context: ProviderContext,
  sessionId: string,
  toolKey: string,
): string => context.ids.newOpaqueId([sessionId, "gemini-cli", "tool", toolKey]);

/**
 * Stable content used to key a model call across its `BeforeModel` and
 * (possibly many, streaming) `AfterModel` firings: both carry `llm_request`
 * unchanged for the same call, so hashing it correlates them without needing an
 * explicit request id, which the protocol does not provide.
 */
export const geminiGenerationId = (
  context: ProviderContext,
  sessionId: string,
  llmRequest: unknown,
): string => context.ids.newOpaqueId([sessionId, "gemini-cli", "generation", stableKey(llmRequest)]);

/**
 * Content that distinguishes one hook firing from the next, mixed into the
 * derived `invocationId`. Re-delivering the exact same payload (a retried or
 * duplicated hook call) reproduces the same content and therefore the same
 * invocation id, which is what makes replay idempotent at the collector.
 */
export const geminiCorrelationSeed = (input: GeminiHookInput): string => {
  switch (input.hook_event_name) {
    case "SessionStart":
      return input.source ?? "session-start";
    case "SessionEnd":
      return input.reason ?? "session-end";
    case "BeforeAgent":
      return stableKey({ prompt: input.prompt });
    case "AfterAgent":
      return stableKey({ prompt: input.prompt, response: input.prompt_response });
    case "BeforeModel":
      return stableKey(input.llm_request);
    case "AfterModel":
      return stableKey({ request: input.llm_request, response: input.llm_response });
    case "BeforeToolSelection":
      return stableKey(input.llm_request);
    case "BeforeTool":
      return stableKey({ tool: geminiToolCallKey(input), input: input.tool_input });
    case "AfterTool":
      return stableKey({
        tool: geminiToolCallKey(input),
        input: input.tool_input,
        response: input.tool_response,
      });
    case "PreCompress":
      return input.trigger ?? "compress";
    case "Notification":
      return stableKey({ type: input.notification_type, message: input.message });
  }
};
