/**
 * Pure, idempotent registration planners for provider hook configuration.
 *
 * Nothing in this module reads or writes the filesystem. A planner takes the
 * *already parsed* contents of a provider's configuration document and returns
 * the document to write back, plus whether anything actually changed. Applying
 * it — reading the file, writing it atomically, deciding where it lives — is the
 * caller's job, for two reasons:
 *
 * 1. ADR 0003: a provider adapter must never touch the filesystem, and a hook
 *    installer that silently rewrites a developer's editor settings is exactly
 *    the kind of side effect that makes telemetry untrustworthy.
 * 2. A pure merge is testable against every "already registered", "registered
 *    with different options", and "unrelated hooks present" case without a
 *    temporary directory.
 *
 * Registration is only offered for providers whose configuration contract this
 * repository has verified. {@link PROVIDER_REGISTRATION_SUPPORT} names the
 * others and says why — an invented settings shape written into a real
 * `settings.json` is worse than no installer at all.
 */
import { ANTIGRAVITY_PROVIDER_ID } from "../providers/antigravity/adapter.js";
import {
  mergeAntigravityHookRegistration,
  type AntigravityHookCommandEntry,
  type MergeAntigravityHookRegistrationInput,
  type MergeAntigravityHookRegistrationResult,
} from "../providers/antigravity/registration.js";
import { CLAUDE_CODE_PROVIDER_ID } from "../providers/claude/detect.js";
import { CODEX_PROVIDER_ID } from "../providers/codex/version.js";
import { CURSOR_PROVIDER_ID } from "../providers/cursor/payload.js";
import { GEMINI_PROVIDER_ID } from "../providers/gemini/adapter.js";
import {
  mergeGeminiHookRegistration,
  type GeminiHookCommandEntry,
  type GeminiHookMatcherEntry,
  type GeminiHooksSettings,
  type MergeGeminiHookResult,
  type RegisterGeminiHookOptions,
} from "../providers/gemini/setup.js";

export {
  mergeAntigravityHookRegistration,
  mergeGeminiHookRegistration,
  type AntigravityHookCommandEntry,
  type GeminiHookCommandEntry,
  type GeminiHookMatcherEntry,
  type GeminiHooksSettings,
  type MergeAntigravityHookRegistrationInput,
  type MergeAntigravityHookRegistrationResult,
  type MergeGeminiHookResult,
  type RegisterGeminiHookOptions,
};

export type ProviderRegistrationSupport = {
  readonly providerId: string;
  readonly supported: boolean;
  /** Why registration is or is not offered, in one reviewable sentence. */
  readonly reason: string;
  /** Name of the planner to call, when supported. */
  readonly helper?: string;
};

/**
 * Per-provider registration availability.
 *
 * `supported: false` is a statement about *this repository's* verified
 * knowledge, not about the provider: Cursor's payload contract in this package
 * is explicitly synthetic, and no Codex hook-configuration format has been
 * confirmed here, so neither has a settings shape that could be written without
 * guessing. Claude Code's hook *payloads* are modelled, but the adapter's event
 * list is its own protocol reconstruction and includes names
 * (`PostToolUseFailure`, `StopFailure`, `PermissionRequest`) that no verified
 * settings schema in this repository lists as registrable events.
 */
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
    supported: false,
    reason:
      "the adapter models Claude Code hook payloads, not a verified settings.json hook-event vocabulary; " +
      "registering a reconstructed event name would write an entry the host may never fire",
  }),
  Object.freeze({
    providerId: CODEX_PROVIDER_ID,
    supported: false,
    reason: "no Codex hook-configuration document shape has been verified in this repository",
  }),
  Object.freeze({
    providerId: CURSOR_PROVIDER_ID,
    supported: false,
    reason:
      "the cursor payload contract in this package is explicitly synthetic (see providers/cursor/payload.ts), " +
      "so no real settings shape is known",
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

export type PlanProviderRegistrationInput =
  | {
      readonly providerId: typeof GEMINI_PROVIDER_ID;
      /** Parsed contents of the provider's settings document, if one exists. */
      readonly existing?: unknown;
      readonly options: RegisterGeminiHookOptions;
    }
  | {
      readonly providerId: typeof ANTIGRAVITY_PROVIDER_ID;
      readonly existing?: unknown;
      readonly options: Omit<MergeAntigravityHookRegistrationInput, "existing">;
    }
  | {
      readonly providerId: string;
      readonly existing?: unknown;
      readonly options?: unknown;
    };

export type PlanProviderRegistrationResult =
  | {
      readonly status: "planned";
      readonly providerId: string;
      /** Write this back verbatim; unrelated keys are carried through unchanged. */
      readonly document: Record<string, unknown>;
      /** False when the document already contained exactly this registration. */
      readonly changed: boolean;
    }
  | { readonly status: "unsupported"; readonly providerId: string; readonly reason: string };

/**
 * Plan one provider's hook registration.
 *
 * Idempotent: calling it again with the same `options` against the document it
 * returned yields `changed: false` and an identical document.
 */
export const planProviderRegistration = (
  input: PlanProviderRegistrationInput,
): PlanProviderRegistrationResult => {
  if (input.providerId === GEMINI_PROVIDER_ID) {
    const merged: MergeGeminiHookResult = mergeGeminiHookRegistration(
      input.existing,
      input.options as RegisterGeminiHookOptions,
    );
    return {
      status: "planned",
      providerId: input.providerId,
      document: { ...merged.settings },
      changed: merged.changed,
    };
  }

  if (input.providerId === ANTIGRAVITY_PROVIDER_ID) {
    const options = input.options as Omit<MergeAntigravityHookRegistrationInput, "existing">;
    const merged = mergeAntigravityHookRegistration({
      ...options,
      ...(input.existing === undefined ? {} : { existing: input.existing }),
    });
    return {
      status: "planned",
      providerId: input.providerId,
      document: merged.config,
      changed: merged.changed,
    };
  }

  const support = findRegistrationSupport(input.providerId);
  return {
    status: "unsupported",
    providerId: input.providerId,
    reason: support?.reason ?? `no registration planner is available for provider "${input.providerId}"`,
  };
};
