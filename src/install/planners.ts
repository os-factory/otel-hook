import { ANTIGRAVITY_PROVIDER_ID } from "../providers/antigravity/adapter.js";
import { ANTIGRAVITY_HOOK_EVENT_NAMES } from "../providers/antigravity/payload.js";
import {
  mergeAntigravityHookRegistration,
  readAntigravityHookRegistrations,
  removeAntigravityHookRegistration,
} from "../providers/antigravity/registration.js";
import { CLAUDE_CODE_PROVIDER_ID } from "../providers/claude/detect.js";
import {
  CLAUDE_REGISTRABLE_HOOK_EVENTS,
  mergeClaudeHookRegistration,
  readClaudeHookRegistrations,
  removeClaudeHookRegistration,
} from "../providers/claude/registration.js";
import {
  CODEX_REGISTRABLE_HOOK_EVENTS,
  mergeCodexHookRegistration,
  readCodexHookRegistrations,
  removeCodexHookRegistration,
} from "../providers/codex/registration.js";
import { CODEX_PROVIDER_ID } from "../providers/codex/version.js";
import { GEMINI_PROVIDER_ID } from "../providers/gemini/adapter.js";
import { GEMINI_HOOK_EVENT_NAMES, type GeminiHookEventName } from "../providers/gemini/schema.js";
import {
  mergeGeminiHookRegistration,
  readGeminiHookRegistrations,
  removeGeminiHookRegistration,
} from "../providers/gemini/setup.js";
import type {
  HookDocumentChange,
  HookDocumentConflict,
  HookHandlerPredicate,
  NestedHookDocumentResult,
} from "../providers/hook-document.js";

/**
 * One uniform interface over planners whose *document shapes differ*.
 *
 * Four providers, three shapes: Claude Code, the Codex CLI, and the Gemini CLI
 * share the nested matcher-group document (with Gemini adding a `name` field),
 * while Antigravity's hook file is a flat list per event. Keeping the shape
 * knowledge inside each provider's planner and adapting only the *result* here
 * is what lets `setup`, `diagnose`, and `uninstall` be written once.
 *
 * Nothing in this module reads or writes a file; `lifecycle.ts` does that.
 */

/** The hook name this tool registers under, where the vocabulary has one. */
export const MANAGED_HOOK_NAME = "otel-hook";

/**
 * Substring that marks a command as this tool's, across versions.
 *
 * Setup has to recognize what an *older* version of itself wrote, or an upgrade
 * that changed the command string (a new absolute path, a new `--endpoint`)
 * would append a second registration and double every span. There is no field
 * in either documented vocabulary to stamp ownership into, so the command
 * string is the only available marker.
 */
export const DEFAULT_MANAGED_COMMAND_MARKER = "otel-hook";

/**
 * The token that makes a marker *this tool's*.
 *
 * Ownership cannot be inferred from a command being "specific enough" — a
 * plausible-looking marker like `run` or `npm` is specific enough to read as
 * deliberate and still matches half the hooks a developer has configured. So the
 * marker has to name this package, and the only name that does is this one.
 */
export const MANAGED_MARKER_TOKEN = "otel-hook";

export const MAX_MANAGED_COMMAND_MARKER_LENGTH = 200;

/**
 * Shortest absolute path accepted as an ownership marker in its own right.
 *
 * An absolute path is a different kind of evidence from a name: `/opt/tools/oh`
 * does not contain `otel-hook`, but it also cannot appear inside `npm run build`
 * or any other command that is not literally invoking that path. So a rooted,
 * separator-bearing path is accepted on its specificity rather than its spelling —
 * which is what lets an operator point at a bespoke install location.
 */
const MIN_ABSOLUTE_PATH_MARKER_LENGTH = 8;

export type ManagedMarkerRejection =
  | "empty"
  | "too-long"
  | "untrimmed"
  | "not-ownership-bearing";

/** Non-sensitive explanations, safe to print: the operator just typed the marker. */
export const MANAGED_MARKER_REJECTION_DETAIL: Readonly<Record<ManagedMarkerRejection, string>> =
  Object.freeze({
    empty: "the managed marker is empty, which would match every hook already configured",
    "too-long": `the managed marker is longer than ${String(MAX_MANAGED_COMMAND_MARKER_LENGTH)} characters`,
    untrimmed:
      "the managed marker has leading or trailing whitespace, which is almost always a quoting mistake and would not match the command as written",
    "not-ownership-bearing":
      `the managed marker must identify this tool: either contain "${MANAGED_MARKER_TOKEN}", or be an absolute path to the installed command. ` +
      "A generic marker matches hooks this tool does not own, and uninstall would delete them",
  });

/**
 * Whether a marker is an absolute path, on either platform's spelling.
 *
 * POSIX `/usr/local/bin/...`, Windows `C:\...` or `C:/...`, and UNC `\\host\share`
 * all count. Deliberately platform-independent rather than using `path.isAbsolute`:
 * a settings file written on one machine is read on another, and a marker that
 * validated on Linux must not become unusable when the same repository is opened
 * on Windows.
 */
const isAbsolutePathMarker = (marker: string): boolean =>
  /^\//.test(marker) || /^[A-Za-z]:[\\/]/.test(marker) || /^\\\\[^\\]/.test(marker);

/**
 * Why a managed marker is unusable, or `undefined` when it is safe.
 *
 * The marker is used as a **substring test** against commands already in a
 * developer's configuration, and that test decides what `uninstall` deletes and
 * what `setup` rewrites in place. Two failure modes, both destructive, and neither
 * recoverable from a backup the developer does not have:
 *
 * - An empty marker makes `"".includes()` true for every handler, so
 *   `uninstall --managed-marker ""` would delete every hook configured by every
 *   tool.
 * - A *generic* marker is the same bug wearing a disguise. `run` matches
 *   `npm run build`, `cargo run`, and any `runner.sh`; `npm` matches every npm
 *   script hook a developer has. Length and alphanumerics do not distinguish these
 *   from a real marker, so the test is ownership: the marker must either name this
 *   package or be an absolute path to it.
 *
 * Validated *before* a document is read, let alone written — a refusal costs one
 * re-run, a wrong match costs a configuration nobody has a copy of.
 */
export const checkManagedMarker = (marker: string): ManagedMarkerRejection | undefined => {
  if (marker.length === 0) {
    return "empty";
  }
  if (marker !== marker.trim()) {
    return "untrimmed";
  }
  if (marker.length > MAX_MANAGED_COMMAND_MARKER_LENGTH) {
    return "too-long";
  }
  // Case-insensitive: a Windows path may well be spelled `Otel-Hook`, and the
  // comparison that matters happens against the command string either way.
  if (marker.toLowerCase().includes(MANAGED_MARKER_TOKEN)) {
    return undefined;
  }
  if (isAbsolutePathMarker(marker) && marker.length >= MIN_ABSOLUTE_PATH_MARKER_LENGTH) {
    return undefined;
  }
  return "not-ownership-bearing";
};

/**
 * Recognizes a hook handler this tool owns, by hook name or command marker.
 *
 * Throws on a marker {@link checkManagedMarker} refuses. A predicate is built
 * before any file is opened, so throwing here cannot leave a document
 * half-changed — and returning a match-everything predicate instead would turn
 * an operator's typo into data loss.
 */
export const managedHookPredicate = (marker: string): HookHandlerPredicate => {
  const rejection = checkManagedMarker(marker);
  if (rejection !== undefined) {
    throw new Error(MANAGED_MARKER_REJECTION_DETAIL[rejection]);
  }
  return (handler): boolean =>
    handler.name === MANAGED_HOOK_NAME ||
    (typeof handler.command === "string" && handler.command.includes(marker));
};

export type RegistrationPlanInput = {
  /** Parsed configuration document, or `undefined` when the file is absent. */
  readonly existing?: unknown;
  readonly command: string;
  /** Overrides the planner's default event set. */
  readonly events?: readonly string[];
  readonly matcher?: string;
  readonly timeoutSeconds?: number;
  readonly identifies: HookHandlerPredicate;
};

export type RegistrationRemovalInput = {
  readonly existing?: unknown;
  readonly events?: readonly string[];
  readonly identifies: HookHandlerPredicate;
};

export type ProviderRegistrationPlanner = {
  readonly providerId: string;
  /**
   * Events registered when the caller names none: the intersection of "the
   * provider documents it" and "this adapter turns it into telemetry". Each
   * planner's module records the exclusions and why.
   */
  readonly defaultEvents: readonly string[];
  merge(input: RegistrationPlanInput): NestedHookDocumentResult;
  remove(input: RegistrationRemovalInput): NestedHookDocumentResult;
  read(existing: unknown, identifies: HookHandlerPredicate): ReadonlyMap<string, readonly string[]>;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Antigravity's planner predates the shared result type and reports only
 * `{ config, changed }`. Rather than change a published contract, the per-event
 * outcome is recovered by comparing the registrations before and after, and the
 * one structural check the flat shape needs is applied here.
 */
const adaptAntigravityResult = (
  existing: unknown,
  events: readonly string[],
  identifies: HookHandlerPredicate,
  result: { readonly config: Record<string, unknown>; readonly changed: boolean },
  removal: boolean,
): NestedHookDocumentResult => {
  const before = readAntigravityHookRegistrations(existing, identifies);
  const after = readAntigravityHookRegistrations(result.config, identifies);
  const changes: HookDocumentChange[] = [];

  for (const event of events) {
    const had = before.has(event);
    const has = after.has(event);
    if (removal) {
      if (had && !has) {
        changes.push({ event, action: "removed" });
      }
      continue;
    }
    if (!had) {
      changes.push({ event, action: "added" });
    } else {
      const same =
        JSON.stringify(before.get(event) ?? []) === JSON.stringify(after.get(event) ?? []);
      changes.push({ event, action: same ? "unchanged" : "updated" });
    }
  }

  return { document: result.config, changed: result.changed, changes, conflicts: [] };
};

const antigravityConflicts = (existing: unknown): readonly HookDocumentConflict[] => {
  if (!isPlainObject(existing) || existing.hooks === undefined) {
    return [];
  }
  if (!isPlainObject(existing.hooks)) {
    return [
      {
        location: "hooks",
        detail: `expected an object keyed by hook event name, found ${
          Array.isArray(existing.hooks) ? "an array" : typeof existing.hooks
        }`,
      },
    ];
  }
  const conflicts: HookDocumentConflict[] = [];
  for (const [event, list] of Object.entries(existing.hooks)) {
    if (!Array.isArray(list)) {
      conflicts.push({
        location: `hooks.${event}`,
        detail: `expected an array of hook entries, found ${list === null ? "null" : typeof list}`,
      });
    }
  }
  return conflicts;
};

const asAntigravityEvents = (events: readonly string[]): readonly (typeof ANTIGRAVITY_HOOK_EVENT_NAMES)[number][] =>
  events as readonly (typeof ANTIGRAVITY_HOOK_EVENT_NAMES)[number][];

const PLANNERS: readonly ProviderRegistrationPlanner[] = Object.freeze([
  Object.freeze({
    providerId: ANTIGRAVITY_PROVIDER_ID,
    defaultEvents: ANTIGRAVITY_HOOK_EVENT_NAMES,
    merge: (input: RegistrationPlanInput): NestedHookDocumentResult => {
      const conflicts = antigravityConflicts(input.existing);
      if (conflicts.length > 0) {
        return {
          document: isPlainObject(input.existing) ? input.existing : {},
          changed: false,
          changes: [],
          conflicts,
        };
      }
      const events = input.events ?? ANTIGRAVITY_HOOK_EVENT_NAMES;
      return adaptAntigravityResult(
        input.existing,
        events,
        input.identifies,
        mergeAntigravityHookRegistration({
          ...(input.existing === undefined ? {} : { existing: input.existing }),
          command: input.command,
          events: asAntigravityEvents(events),
          ...(input.matcher === undefined ? {} : { matcher: input.matcher }),
          identifies: input.identifies,
        }),
        false,
      );
    },
    remove: (input: RegistrationRemovalInput): NestedHookDocumentResult => {
      const conflicts = antigravityConflicts(input.existing);
      if (conflicts.length > 0) {
        return {
          document: isPlainObject(input.existing) ? input.existing : {},
          changed: false,
          changes: [],
          conflicts,
        };
      }
      const events =
        input.events ??
        (isPlainObject(input.existing) && isPlainObject(input.existing.hooks)
          ? Object.keys(input.existing.hooks)
          : []);
      return adaptAntigravityResult(
        input.existing,
        events,
        input.identifies,
        removeAntigravityHookRegistration({
          ...(input.existing === undefined ? {} : { existing: input.existing }),
          ...(input.events === undefined ? {} : { events: asAntigravityEvents(input.events) }),
          identifies: input.identifies,
        }),
        true,
      );
    },
    read: readAntigravityHookRegistrations,
  }),
  Object.freeze({
    providerId: CLAUDE_CODE_PROVIDER_ID,
    defaultEvents: CLAUDE_REGISTRABLE_HOOK_EVENTS,
    merge: (input: RegistrationPlanInput): NestedHookDocumentResult =>
      mergeClaudeHookRegistration(input),
    remove: (input: RegistrationRemovalInput): NestedHookDocumentResult =>
      removeClaudeHookRegistration(input),
    read: readClaudeHookRegistrations,
  }),
  Object.freeze({
    providerId: CODEX_PROVIDER_ID,
    defaultEvents: CODEX_REGISTRABLE_HOOK_EVENTS,
    merge: (input: RegistrationPlanInput): NestedHookDocumentResult =>
      mergeCodexHookRegistration(input),
    remove: (input: RegistrationRemovalInput): NestedHookDocumentResult =>
      removeCodexHookRegistration(input),
    read: readCodexHookRegistrations,
  }),
  Object.freeze({
    providerId: GEMINI_PROVIDER_ID,
    defaultEvents: GEMINI_HOOK_EVENT_NAMES,
    merge: (input: RegistrationPlanInput): NestedHookDocumentResult => {
      const merged = mergeGeminiHookRegistration(input.existing, {
        name: MANAGED_HOOK_NAME,
        command: input.command,
        events: (input.events ?? GEMINI_HOOK_EVENT_NAMES) as readonly GeminiHookEventName[],
        ...(input.matcher === undefined ? {} : { matcher: input.matcher }),
        ...(input.timeoutSeconds === undefined ? {} : { timeout: input.timeoutSeconds }),
        identifies: input.identifies,
      });
      return {
        document: merged.settings,
        changed: merged.changed,
        changes: merged.changes,
        conflicts: merged.conflicts,
      };
    },
    remove: (input: RegistrationRemovalInput): NestedHookDocumentResult =>
      removeGeminiHookRegistration(input.existing, {
        ...(input.events === undefined
          ? {}
          : { events: input.events as readonly GeminiHookEventName[] }),
        identifies: input.identifies,
      }),
    read: readGeminiHookRegistrations,
  }),
]);

export const findRegistrationPlanner = (
  providerId: string,
): ProviderRegistrationPlanner | undefined =>
  PLANNERS.find((planner) => planner.providerId === providerId);

export const REGISTRATION_PLANNERS = PLANNERS;
