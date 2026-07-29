/**
 * Registration lifecycle: pure planners, plus the safe application of a plan.
 *
 * Two layers, deliberately separated:
 *
 * - **Planners** (`providers/<id>/registration.ts`, re-exported here) are pure.
 *   They take the *already parsed* contents of a provider's configuration
 *   document and return the document to write back plus whether anything
 *   changed. ADR 0003 keeps a provider adapter away from the filesystem, and a
 *   pure merge is testable against every "already registered", "registered with
 *   an older command", and "unrelated hooks present" case without a temporary
 *   directory.
 * - **Lifecycle** (`lifecycle.ts`) reads and writes real files: locking a
 *   third party's config for the read-merge-write, preserving its formatting,
 *   writing atomically, and refusing rather than clobbering when the document
 *   is not what the provider documents.
 *
 * Registration is only offered for providers whose configuration contract this
 * repository has verified. {@link PROVIDER_REGISTRATION_SUPPORT} names the
 * others and says exactly what would unblock them — an invented settings shape
 * written into a real `settings.json` is worse than no installer at all.
 */
import { ANTIGRAVITY_PROVIDER_ID } from "../providers/antigravity/adapter.js";
import {
  mergeAntigravityHookRegistration,
  readAntigravityHookRegistrations,
  removeAntigravityHookRegistration,
  type AntigravityHookCommandEntry,
  type MergeAntigravityHookRegistrationInput,
  type MergeAntigravityHookRegistrationResult,
  type RemoveAntigravityHookRegistrationInput,
} from "../providers/antigravity/registration.js";
import { CLAUDE_CODE_PROVIDER_ID } from "../providers/claude/detect.js";
import {
  CLAUDE_HOOK_EVENTS_MODELLED,
  CLAUDE_REGISTRABLE_HOOK_EVENTS,
  CLAUDE_UNREGISTERED_HOOK_EVENTS,
  mergeClaudeHookRegistration,
  readClaudeHookRegistrations,
  removeClaudeHookRegistration,
  type ClaudeHookRegistrationOptions,
  type ClaudeHookRemovalOptions,
} from "../providers/claude/registration.js";
import {
  CODEX_HOOK_EVENTS_MODELLED,
  CODEX_REGISTRABLE_HOOK_EVENTS,
  CODEX_UNREGISTERED_HOOK_EVENTS,
  mergeCodexHookRegistration,
  readCodexHookRegistrations,
  readCodexHooksFeatureFlag,
  removeCodexHookRegistration,
  type CodexHookRegistrationOptions,
  type CodexHookRemovalOptions,
  type CodexHooksFeatureFlag,
} from "../providers/codex/registration.js";
import { CODEX_PROVIDER_ID } from "../providers/codex/version.js";
import { CURSOR_PROVIDER_ID } from "../providers/cursor/payload.js";
import {
  CURSOR_HOOK_EVENTS_MODELLED,
  CURSOR_HOOKS_DOCUMENT_VERSION,
  CURSOR_REGISTRABLE_HOOK_EVENTS,
  CURSOR_UNREGISTERED_HOOK_EVENTS,
  mergeCursorHookRegistration,
  readCursorHookRegistrations,
  removeCursorHookRegistration,
  type CursorHookCommandEntry,
  type CursorHookDocumentResult,
  type CursorHookRemovalInput,
  type MergeCursorHookRegistrationInput,
} from "../providers/cursor/registration.js";
import { GEMINI_PROVIDER_ID } from "../providers/gemini/adapter.js";
import {
  mergeGeminiHookRegistration,
  readGeminiHookRegistrations,
  removeGeminiHookRegistration,
  type GeminiHookCommandEntry,
  type GeminiHookMatcherEntry,
  type GeminiHooksSettings,
  type MergeGeminiHookResult,
  type RegisterGeminiHookOptions,
  type RemoveGeminiHookOptions,
} from "../providers/gemini/setup.js";
import {
  mergeNestedHookRegistration,
  readNestedHookRegistrations,
  removeNestedHookRegistrations,
  type CommandHookEntry,
  type HookDocumentAction,
  type HookDocumentChange,
  type HookDocumentConflict,
  type HookGroupEntry,
  type HookHandlerPredicate,
  type MergeNestedHookInput,
  type NestedHookDocumentResult,
  type RemoveNestedHookInput,
} from "../providers/hook-document.js";
import { findRegistrationPlanner, managedHookPredicate } from "./planners.js";
import { findRegistrationSupport } from "./support.js";

export {
  CLAUDE_HOOK_EVENTS_MODELLED,
  CLAUDE_REGISTRABLE_HOOK_EVENTS,
  CLAUDE_UNREGISTERED_HOOK_EVENTS,
  CODEX_HOOK_EVENTS_MODELLED,
  CODEX_REGISTRABLE_HOOK_EVENTS,
  CODEX_UNREGISTERED_HOOK_EVENTS,
  CURSOR_HOOK_EVENTS_MODELLED,
  CURSOR_HOOKS_DOCUMENT_VERSION,
  CURSOR_REGISTRABLE_HOOK_EVENTS,
  CURSOR_UNREGISTERED_HOOK_EVENTS,
  mergeAntigravityHookRegistration,
  mergeClaudeHookRegistration,
  mergeCodexHookRegistration,
  mergeCursorHookRegistration,
  mergeGeminiHookRegistration,
  mergeNestedHookRegistration,
  readAntigravityHookRegistrations,
  readClaudeHookRegistrations,
  readCodexHookRegistrations,
  readCodexHooksFeatureFlag,
  readCursorHookRegistrations,
  readGeminiHookRegistrations,
  readNestedHookRegistrations,
  removeAntigravityHookRegistration,
  removeClaudeHookRegistration,
  removeCodexHookRegistration,
  removeCursorHookRegistration,
  removeGeminiHookRegistration,
  removeNestedHookRegistrations,
  type AntigravityHookCommandEntry,
  type ClaudeHookRegistrationOptions,
  type ClaudeHookRemovalOptions,
  type CodexHookRegistrationOptions,
  type CodexHookRemovalOptions,
  type CodexHooksFeatureFlag,
  type CommandHookEntry,
  type CursorHookCommandEntry,
  type CursorHookDocumentResult,
  type CursorHookRemovalInput,
  type GeminiHookCommandEntry,
  type GeminiHookMatcherEntry,
  type GeminiHooksSettings,
  type HookDocumentAction,
  type HookDocumentChange,
  type HookDocumentConflict,
  type HookGroupEntry,
  type HookHandlerPredicate,
  type MergeAntigravityHookRegistrationInput,
  type MergeAntigravityHookRegistrationResult,
  type MergeCursorHookRegistrationInput,
  type MergeGeminiHookResult,
  type MergeNestedHookInput,
  type NestedHookDocumentResult,
  type RegisterGeminiHookOptions,
  type RemoveAntigravityHookRegistrationInput,
  type RemoveGeminiHookOptions,
  type RemoveNestedHookInput,
};

export {
  checkManagedMarker,
  DEFAULT_MANAGED_COMMAND_MARKER,
  MANAGED_HOOK_NAME,
  MANAGED_MARKER_REJECTION_DETAIL,
  MANAGED_MARKER_TOKEN,
  REGISTRATION_PLANNERS,
  findRegistrationPlanner,
  managedHookPredicate,
  type ManagedMarkerRejection,
  type ProviderRegistrationPlanner,
  type RegistrationPlanInput,
  type RegistrationRemovalInput,
} from "./planners.js";

export {
  PROVIDER_REGISTRATION_SUPPORT,
  SUPPORTED_REGISTRATION_PROVIDER_IDS,
  findRegistrationSupport,
  type ProviderRegistrationSupport,
} from "./support.js";

export {
  PROVIDERS_WITHOUT_VERIFIED_LOCATION,
  PROVIDERS_WITH_VERIFIED_LOCATION,
  PROVIDER_INSTALL_LOCATIONS,
  REGISTRATION_SCOPES,
  findInstallLocation,
  resolveInstallPath,
  type InstallLocation,
  type RegistrationScope,
  type ScopeRoots,
} from "./scopes.js";

export {
  DEFAULT_DOCUMENT_FORMAT,
  detectDocumentFormat,
  readJsonDocument,
  renderJsonDocument,
  writeDocumentAtomically,
  type JsonDocumentFormat,
  type ReadDocumentResult,
} from "./document.js";

export {
  FileLockTimeoutError,
  lockPathFor,
  withFileLock,
  type FileLockOptions,
} from "./file-lock.js";

export {
  defaultHookCommand,
  runRegistrationLifecycle,
  type RegistrationAction,
  type RegistrationLifecycleRequest,
  type RegistrationOutcome,
  type RegistrationOutcomeStatus,
  type RegistrationReport,
} from "./lifecycle.js";

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
      readonly providerId: typeof CLAUDE_CODE_PROVIDER_ID;
      readonly existing?: unknown;
      readonly options: Omit<ClaudeHookRegistrationOptions, "existing" | "identifies"> & {
        readonly identifies?: HookHandlerPredicate;
      };
    }
  | {
      readonly providerId: typeof CODEX_PROVIDER_ID;
      readonly existing?: unknown;
      readonly options: Omit<CodexHookRegistrationOptions, "existing" | "identifies"> & {
        readonly identifies?: HookHandlerPredicate;
      };
    }
  | {
      readonly providerId: typeof CURSOR_PROVIDER_ID;
      readonly existing?: unknown;
      readonly options: Omit<MergeCursorHookRegistrationInput, "existing" | "identifies"> & {
        readonly identifies?: HookHandlerPredicate;
      };
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
      readonly changes: readonly HookDocumentChange[];
    }
  | {
      /** The document is not the shape this provider documents; nothing was changed. */
      readonly status: "conflict";
      readonly providerId: string;
      readonly conflicts: readonly HookDocumentConflict[];
    }
  | { readonly status: "unsupported"; readonly providerId: string; readonly reason: string }
  | { readonly status: "invalid"; readonly providerId: string; readonly reason: string };

/**
 * Plan one provider's hook registration.
 *
 * Idempotent: calling it again with the same `options` against the document it
 * returned yields `changed: false` and an identical document.
 */
export const planProviderRegistration = (
  input: PlanProviderRegistrationInput,
): PlanProviderRegistrationResult => {
  const support = findRegistrationSupport(input.providerId);
  const planner = findRegistrationPlanner(input.providerId);
  if (planner === undefined || support?.supported !== true) {
    return {
      status: "unsupported",
      providerId: input.providerId,
      reason: support?.reason ?? `no registration planner is available for provider "${input.providerId}"`,
    };
  }

  const options = (input.options ?? {}) as {
    readonly command?: unknown;
    readonly events?: readonly string[];
    readonly matcher?: string;
    readonly timeout?: number;
    readonly timeoutSeconds?: number;
    readonly identifies?: HookHandlerPredicate;
  };
  if (typeof options.command !== "string" || options.command.length === 0) {
    return {
      status: "invalid",
      providerId: input.providerId,
      reason: `planning a "${input.providerId}" registration requires a non-empty options.command`,
    };
  }

  const timeoutSeconds = options.timeoutSeconds ?? options.timeout;
  const result = planner.merge({
    ...(input.existing === undefined ? {} : { existing: input.existing }),
    command: options.command,
    ...(options.events === undefined ? {} : { events: options.events }),
    ...(options.matcher === undefined ? {} : { matcher: options.matcher }),
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
    identifies: options.identifies ?? managedHookPredicate(options.command),
  });

  if (result.conflicts.length > 0) {
    return { status: "conflict", providerId: input.providerId, conflicts: result.conflicts };
  }
  return {
    status: "planned",
    providerId: input.providerId,
    document: result.document,
    changed: result.changed,
    changes: result.changes,
  };
};
