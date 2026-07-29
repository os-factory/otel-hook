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
 * specific to Gemini. Four things are, all read from
 * `google-gemini/gemini-cli@3499c84` (`docs/hooks/reference.md`,
 * `packages/core/src/hooks/types.ts`, `packages/core/src/hooks/hookPlanner.ts`):
 *
 * - **`timeout` is milliseconds**, default `60000` — not seconds, as Claude Code
 *   and the Codex CLI both use. `hookRunner` passes the value straight to
 *   `setTimeout`. Callers speak seconds ({@link RegisterGeminiHookOptions}), and
 *   the conversion happens here, because writing `timeout: 30` from a
 *   `--timeout-seconds 30` would kill the hook after 30ms.
 * - **`"*"` is a real matcher value.** `HookPlanner.matchesContext` special-cases
 *   `""` and `"*"` as match-everything before treating a matcher as a regex, so
 *   the wildcard is safe here even though `new RegExp("*")` would throw.
 * - **`name` is the identity key.** The CLI's own `getHookKey` is
 *   `` `${name}:${command}` ``, which would treat a changed command as a
 *   *different* hook and leave the stale entry firing beside the new one. This
 *   planner keys on `name` alone so an upgrade rewrites in place.
 * - **`hooks` holds non-event keys.** `HOOKS_CONFIG_FIELDS` is
 *   `['enabled', 'disabled', 'notifications']`, so `hooks.enabled: true` sits
 *   beside the event arrays. Both merge and removal are therefore driven by an
 *   explicit event list and never iterate the object's keys.
 *
 * The scopes are `~/.gemini/settings.json` (user-global) and
 * `.gemini/settings.json` (project), as written by `o11y-dev/opentelemetry-hooks`
 * v0.14.0 (`setup.sh`, `setup_gemini`).
 */

export type GeminiHookCommandEntry = {
  readonly name: string;
  readonly type: "command";
  readonly command: string;
  /** Milliseconds, per the Gemini CLI's own `CommandHookConfig`. */
  readonly timeout?: number;
};

export type GeminiHookMatcherEntry = {
  readonly matcher?: string;
  /** True runs the group's hooks one after another; preserved, never written. */
  readonly sequential?: boolean;
  readonly hooks: readonly GeminiHookCommandEntry[];
};

/**
 * Default registration set: the documented events this adapter turns into
 * telemetry, in the order the CLI fires them. A hook registered on an event that
 * emits nothing is a process spawn per occurrence for no data.
 */
export const GEMINI_REGISTRABLE_HOOK_EVENTS: readonly GeminiHookEventName[] = Object.freeze([
  "SessionStart",
  "BeforeAgent",
  "BeforeModel",
  "AfterModel",
  "BeforeTool",
  "AfterTool",
  "PreCompress",
  "SessionEnd",
]);

/** Documented and modelled, but intentionally not registered, with the reason. */
export const GEMINI_UNREGISTERED_HOOK_EVENTS: Readonly<Record<string, string>> = Object.freeze({
  AfterAgent:
    "marks turn completion, which the canonical model has no event for distinct from generation.end",
  BeforeToolSelection: "carries tool-choice configuration only, so the adapter emits nothing",
  Notification: "observability-only in this protocol; no canonical event type corresponds",
});

/**
 * Keys the CLI documents *inside* `hooks` that are not event names
 * (`HOOKS_CONFIG_FIELDS`). Anything registering or removing hooks has to know
 * these exist, or it will read `hooks.enabled: true` as a malformed event list.
 */
export const GEMINI_HOOKS_CONFIG_FIELDS = Object.freeze([
  "enabled",
  "disabled",
  "notifications",
] as const);

export type GeminiHooksObject = Partial<
  Record<GeminiHookEventName, readonly GeminiHookMatcherEntry[]>
> & {
  readonly enabled?: boolean;
  readonly disabled?: readonly string[];
  readonly notifications?: unknown;
};

export type GeminiHooksSettings = {
  readonly hooks?: GeminiHooksObject;
  readonly [key: string]: unknown;
};

export type RegisterGeminiHookOptions = {
  /** Hook id as it will appear in settings.json; also the idempotency key. */
  readonly name: string;
  readonly command: string;
  /** Defaults to `"*"` (every tool / every context). */
  readonly matcher?: string;
  /** Defaults to {@link GEMINI_REGISTRABLE_HOOK_EVENTS}. */
  readonly events?: readonly GeminiHookEventName[];
  /**
   * Seconds, matching every other planner's vocabulary. Converted to the
   * milliseconds the Gemini CLI expects before it is written.
   */
  readonly timeoutSeconds?: number;
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

const MILLIS_PER_SECOND = 1_000;

const buildCommandEntry = (options: RegisterGeminiHookOptions): GeminiHookCommandEntry => ({
  name: options.name,
  type: "command",
  command: options.command,
  ...(options.timeoutSeconds === undefined
    ? {}
    : { timeout: options.timeoutSeconds * MILLIS_PER_SECOND }),
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
  const events = options.events ?? GEMINI_REGISTRABLE_HOOK_EVENTS;
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
  /** Restrict removal to these events. Omitted means the whole event vocabulary. */
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
 *
 * Removal names the full event vocabulary rather than letting the engine scan
 * the document's own keys, because in this vocabulary not every key under
 * `hooks` is an event: `HOOKS_CONFIG_FIELDS` puts `enabled`, `disabled`, and
 * `notifications` there too. Scanning would read `hooks.enabled: true` as a
 * malformed event list, report a conflict, and abandon the whole uninstall —
 * leaving every registration in place on exactly the documents that had hooks
 * configured most deliberately. `GEMINI_HOOK_EVENT_NAMES` is complete, so naming
 * it loses nothing: the CLI cannot fire an event outside it.
 */
export const removeGeminiHookRegistration = (
  existing: unknown,
  options: RemoveGeminiHookOptions,
): NestedHookDocumentResult =>
  removeNestedHookRegistrations({
    existing,
    events: options.events ?? GEMINI_HOOK_EVENT_NAMES,
    identifies: options.identifies,
  });

export const readGeminiHookRegistrations = readNestedHookRegistrations;
