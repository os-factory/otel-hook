import {
  mergeNestedHookRegistration,
  readNestedHookRegistrations,
  removeNestedHookRegistrations,
  type HookDocumentChange,
  type HookDocumentConflict,
  type HookHandlerPredicate,
  type NestedHookDocumentResult,
} from "../hook-document.js";
import { GEMINI_HOOK_EVENT_NAMES, type GeminiHookEventName } from "./schema.js";

/**
 * Idempotent helper for registering this adapter's command hook into a Gemini
 * CLI `settings.json`. It never touches the filesystem itself — callers read
 * the existing settings, pass the parsed value in, and write the returned
 * value back — so the merge logic stays pure and testable, and this package
 * never needs a filesystem handle (see ADR 0003).
 *
 * Gemini CLI's settings share the nested `hooks -> event -> [{matcher, hooks}]`
 * shape that Claude Code and the Codex CLI document, so the merge itself is
 * delegated to `providers/hook-document.ts`; what stays here is the part that is
 * specific to Gemini — the event vocabulary, the `"*"` matcher default, and the
 * `name` field that serves as this vocabulary's identity key.
 *
 * The scopes are `~/.gemini/settings.json` (user-global) and
 * `.gemini/settings.json` (project), as written by `o11y-dev/opentelemetry-hooks`
 * v0.14.0 (`setup.sh`, `setup_gemini`).
 */

export type GeminiHookCommandEntry = {
  readonly name: string;
  readonly type: "command";
  readonly command: string;
  readonly timeout?: number;
};

export type GeminiHookMatcherEntry = {
  readonly matcher?: string;
  readonly hooks: readonly GeminiHookCommandEntry[];
};

export type GeminiHooksSettings = {
  readonly hooks?: Partial<Record<GeminiHookEventName, readonly GeminiHookMatcherEntry[]>>;
  readonly [key: string]: unknown;
};

export type RegisterGeminiHookOptions = {
  /** Hook id as it will appear in settings.json; also the idempotency key. */
  readonly name: string;
  readonly command: string;
  /** Defaults to `"*"` (every tool / every context). */
  readonly matcher?: string;
  /** Defaults to every documented Gemini CLI hook event. */
  readonly events?: readonly GeminiHookEventName[];
  readonly timeout?: number;
  /**
   * Recognizes registrations this tool owns. Defaults to `name` equality — the
   * documented idempotency key — but an installer that has to find entries an
   * older version wrote under a different name can widen it.
   */
  readonly identifies?: HookHandlerPredicate;
};

export type MergeGeminiHookResult = {
  readonly settings: GeminiHooksSettings;
  /** False when every requested event already had this exact registration. */
  readonly changed: boolean;
  readonly registeredEvents: readonly GeminiHookEventName[];
  /** Per-event outcome, for a caller that reports what it is about to do. */
  readonly changes: readonly HookDocumentChange[];
  /** Non-empty when the document's `hooks` value is not the documented shape. */
  readonly conflicts: readonly HookDocumentConflict[];
};

const buildCommandEntry = (options: RegisterGeminiHookOptions): GeminiHookCommandEntry => ({
  name: options.name,
  type: "command",
  command: options.command,
  ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
});

/**
 * Identity is the hook's `name`, exactly as {@link RegisterGeminiHookOptions}
 * documents it: re-running setup after the command string changed (a new
 * install path, a new endpoint flag) must *rewrite* the existing entry, not
 * leave a stale one firing beside it.
 */
const identifiesByName =
  (name: string): HookHandlerPredicate =>
  (handler): boolean =>
    handler.name === name;

/**
 * Merge this adapter's hook registration into an existing (parsed)
 * `settings.json` value, once per requested event.
 *
 * Re-running with identical options is a no-op (`changed: false`). Existing
 * hooks from other tools, matchers a developer narrowed by hand, and settings
 * fields outside `hooks` are all preserved untouched.
 */
export const mergeGeminiHookRegistration = (
  existing: unknown,
  options: RegisterGeminiHookOptions,
): MergeGeminiHookResult => {
  const events = options.events ?? GEMINI_HOOK_EVENT_NAMES;
  const merged = mergeNestedHookRegistration({
    existing,
    events,
    entry: buildCommandEntry(options),
    matcher: options.matcher ?? "*",
    identifies: options.identifies ?? identifiesByName(options.name),
  });

  return {
    settings: merged.document,
    changed: merged.changed,
    registeredEvents: merged.conflicts.length > 0 ? [] : events,
    changes: merged.changes,
    conflicts: merged.conflicts,
  };
};

export type RemoveGeminiHookOptions = {
  /** Restrict removal to these events. Omitted means every event in the document. */
  readonly events?: readonly GeminiHookEventName[];
  /** Recognizes handlers this tool wrote, across versions. */
  readonly identifies: HookHandlerPredicate;
};

/**
 * Reverse {@link mergeGeminiHookRegistration}.
 *
 * An emptied matcher group, an emptied event, and an emptied `hooks` key are all
 * dropped, which is what makes setup-then-uninstall restore the original
 * document exactly.
 */
export const removeGeminiHookRegistration = (
  existing: unknown,
  options: RemoveGeminiHookOptions,
): NestedHookDocumentResult =>
  removeNestedHookRegistrations({
    existing,
    ...(options.events === undefined ? {} : { events: options.events }),
    identifies: options.identifies,
  });

export const readGeminiHookRegistrations = readNestedHookRegistrations;
