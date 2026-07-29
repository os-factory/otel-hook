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
    supported: true,
    reason:
      "the ~/.cursor/hooks.json and .cursor/hooks.json documents, their shape, and the event vocabulary are " +
      "documented at cursor.com/docs/agent/hooks, and the payload contract this adapter parses is derived from " +
      "that reference plus four real redacted capture runs (Cursor IDE 3.12.17 and CLI 2026.07.17, recorded in " +
      "providers/cursor/payload.ts and replayed from fixtures/parity/cursor)",
    helper: "mergeCursorHookRegistration",
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
