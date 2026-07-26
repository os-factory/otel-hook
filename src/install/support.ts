import { ANTIGRAVITY_PROVIDER_ID } from "../providers/antigravity/adapter.js";
import { CLAUDE_CODE_PROVIDER_ID } from "../providers/claude/detect.js";
import { CODEX_PROVIDER_ID } from "../providers/codex/version.js";
import { CURSOR_PROVIDER_ID } from "../providers/cursor/payload.js";
import { GEMINI_PROVIDER_ID } from "../providers/gemini/adapter.js";

/**
 * Per-provider registration availability, and the evidence behind it.
 *
 * `supported: false` is a statement about *this repository's* verified
 * knowledge, not about the provider. Each entry is meant to be checkable: a
 * reviewer should be able to read the reason, open the named source, and agree
 * or disagree without running anything.
 */

export type ProviderRegistrationSupport = {
  readonly providerId: string;
  readonly supported: boolean;
  /** Why registration is or is not offered, in one reviewable sentence. */
  readonly reason: string;
  /** Name of the planner to call, when supported. */
  readonly helper?: string;
  /** For an unsupported provider: precisely what would have to be verified. */
  readonly evidenceBlocker?: string;
};

/**
 * Cursor is the one provider whose *configuration* is verified but whose
 * *payloads* are not, which is the reverse of the usual blocker and worth
 * stating plainly: registering it would succeed, fire, and then drop every
 * event on the floor.
 */
const CURSOR_REASON =
  "Cursor's hooks.json location and shape are verified (cursor.com/docs/agent/hooks; o11y-dev/opentelemetry-hooks " +
  "v0.14.0 setup.sh), but this repository's Cursor payload contract is explicitly synthetic " +
  "(providers/cursor/payload.ts), so a registration would fire a hook whose payloads the adapter rejects";

const CURSOR_EVIDENCE_BLOCKER =
  "Two concrete mismatches, both from providers/cursor/payload.ts against cursor.com/docs/agent/hooks: " +
  "(1) the adapter's tool events are beforeToolUse/afterToolUse/toolUseFailed where Cursor documents " +
  "preToolUse/postToolUse/postToolUseFailure, and (2) the adapter's current-shape envelope is camelCase " +
  "(hookEventName, conversationId, timestampMillis) while its snake_case path only resolves snake_case event " +
  "names (before_tool_use, …), so a real payload keyed hook_event_name: \"preToolUse\" matches neither path. " +
  "Unblocked by capturing real Cursor hook payloads under fixtures/parity/cursor with provenance and " +
  "re-deriving the payload contract from them; the planner can then reuse the verified hooks.json shape.";

export const PROVIDER_REGISTRATION_SUPPORT: readonly ProviderRegistrationSupport[] = Object.freeze([
  Object.freeze({
    providerId: ANTIGRAVITY_PROVIDER_ID,
    supported: true,
    reason:
      "the five documented camelCase command hooks and the hook-file shape are recorded by the antigravity adapter",
    helper: "mergeAntigravityHookRegistration",
  }),
  Object.freeze({
    providerId: CLAUDE_CODE_PROVIDER_ID,
    supported: true,
    reason:
      "the settings.json hook document, its global and project scopes, and every event this adapter models are " +
      "documented at code.claude.com/docs/en/hooks and cross-checked against o11y-dev/opentelemetry-hooks v0.14.0",
    helper: "mergeClaudeHookRegistration",
  }),
  Object.freeze({
    providerId: CODEX_PROVIDER_ID,
    supported: true,
    reason:
      "the .codex/hooks.json document, its global and project scopes, and the event vocabulary are documented at " +
      "learn.chatgpt.com/docs/hooks — the same reference this adapter's payload contract is drawn from",
    helper: "mergeCodexHookRegistration",
  }),
  Object.freeze({
    providerId: CURSOR_PROVIDER_ID,
    supported: false,
    reason: CURSOR_REASON,
    evidenceBlocker: CURSOR_EVIDENCE_BLOCKER,
  }),
  Object.freeze({
    providerId: GEMINI_PROVIDER_ID,
    supported: true,
    reason: "the Gemini CLI settings.json hooks schema and event vocabulary are recorded by the gemini adapter",
    helper: "mergeGeminiHookRegistration",
  }),
]);

export const findRegistrationSupport = (providerId: string): ProviderRegistrationSupport | undefined =>
  PROVIDER_REGISTRATION_SUPPORT.find((entry) => entry.providerId === providerId);

/** Provider ids this repository can plan a registration for, in catalog order. */
export const SUPPORTED_REGISTRATION_PROVIDER_IDS: readonly string[] = Object.freeze(
  PROVIDER_REGISTRATION_SUPPORT.filter((entry) => entry.supported).map((entry) => entry.providerId),
);
