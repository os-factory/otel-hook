import type { HookHandlerPredicate } from "../hook-document.js";
import { CURSOR_HOOK_EVENT_NAMES, type CursorHookEventName } from "./payload.js";

/**
 * Idempotent registration planner for Cursor's `hooks.json`.
 *
 * ## Evidence
 *
 * The document half was already verified before the payload half was: Cursor's
 * hooks reference (`cursor.com/docs/agent/hooks` and `cursor.com/docs/hooks.md`,
 * read 2026-07-29) documents the discovery locations `~/.cursor/hooks.json`
 * (user) and `<project-root>/.cursor/hooks.json` (project), and the document
 * shape
 *
 * ```jsonc
 * {
 *   "version": 1,
 *   "hooks": {
 *     "preToolUse": [
 *       { "command": "…", "type": "command", "timeout": 30, "matcher": "…" }
 *     ]
 *   }
 * }
 * ```
 *
 * with `timeout` in **seconds**, `type` defaulting to `"command"`, `matcher`
 * optional, and `failClosed` defaulting to false. `o11y-dev/opentelemetry-hooks`
 * v0.14.0 writes exactly that shape. Enterprise-managed locations
 * (`/etc/cursor/hooks.json` and the macOS/Windows equivalents) are documented
 * too but are deliberately not offered as a scope: they are MDM-owned, live
 * outside a home directory, and this tool has no business writing there.
 *
 * The list is *flat* — one array of command entries per event, no matcher-group
 * nesting — so this cannot share the engine Claude Code, Codex, and the Gemini
 * CLI use, for the same reason Antigravity cannot.
 *
 * ## Why not every documented event
 *
 * {@link CURSOR_REGISTRABLE_HOOK_EVENTS} is the intersection of "Cursor
 * documents it", "this adapter turns it into telemetry", and "registering it
 * does not double-count something already registered".
 * {@link CURSOR_UNREGISTERED_HOOK_EVENTS} records every exclusion with its
 * reason; the shell and MCP exclusions are the interesting ones, and they come
 * from a capture rather than from the reference — see `payload.ts`.
 */

/** Every `hook_event_name` this repository's Cursor adapter accepts. */
export const CURSOR_HOOK_EVENTS_MODELLED: readonly CursorHookEventName[] = CURSOR_HOOK_EVENT_NAMES;

/** Default registration set: modelled events that yield telemetry, in lifecycle order. */
export const CURSOR_REGISTRABLE_HOOK_EVENTS: readonly CursorHookEventName[] = Object.freeze([
  "sessionStart",
  "beforeSubmitPrompt",
  "preToolUse",
  "postToolUse",
  "postToolUseFailure",
  "afterFileEdit",
  "preCompact",
  "stop",
  "sessionEnd",
] as const);

/** Documented or modelled but intentionally not registered, with the reason. */
export const CURSOR_UNREGISTERED_HOOK_EVENTS: Readonly<Record<string, string>> = Object.freeze({
  afterAgentResponse:
    "the generation's outcome and the same token snapshot arrive on stop; registering both would double-count usage",
  afterAgentThought:
    "a reasoning notification with no canonical event type, and its text is never exported",
  beforeShellExecution:
    "one shell call also fires preToolUse/postToolUse — the capture's fired.log shows all four for a single command — and only the generic pair carries tool_use_id, so registering this one duplicates the tool call",
  afterShellExecution:
    "the same shell call also fires postToolUse, which duplicates this tool end and — unlike this callback — carries both a tool_use_id and a success/failure signal",
  beforeMCPExecution:
    "an MCP call also fires preToolUse/postToolUse, which additionally carry tool_use_id; registering this one duplicates the tool call",
  afterMCPExecution:
    "the same MCP call also fires postToolUse, which duplicates this tool end and, unlike this callback, reports a success/failure signal",
  beforeReadFile:
    "no completion callback exists for it, so a tool.start emitted here would never close",
  subagentStart:
    "subagentStop carries no subagent id to pair with, so no closable delegation lifecycle can be produced",
  subagentStop:
    "it carries no subagent id, so it cannot be paired with the subagentStart it ends",
  beforeTabFileRead: "a Tab (inline-completion) hook, not an agent-session hook; not modelled by this adapter",
  afterTabFileEdit: "a Tab (inline-completion) hook, not an agent-session hook; not modelled by this adapter",
  workspaceOpen:
    "an app-lifecycle hook that carries no conversation_id, so it has no session to attribute telemetry to",
});

/** The schema version Cursor documents for `hooks.json`. */
export const CURSOR_HOOKS_DOCUMENT_VERSION = 1;

/** One command entry inside a Cursor hook event's list. */
export type CursorHookCommandEntry = {
  readonly type: "command";
  readonly command: string;
  /** Seconds, per the reference. */
  readonly timeout?: number;
  readonly matcher?: string;
};

export type MergeCursorHookRegistrationInput = {
  /** Parsed `hooks.json`, or `undefined`/anything non-object when none exists yet. */
  readonly existing?: unknown;
  readonly command: string;
  /** Defaults to {@link CURSOR_REGISTRABLE_HOOK_EVENTS}. */
  readonly events?: readonly string[];
  /** Seconds. Omitted leaves Cursor's own default in force. */
  readonly timeoutSeconds?: number;
  readonly matcher?: string;
  /** Recognizes entries an earlier version of this tool wrote. */
  readonly identifies: HookHandlerPredicate;
};

export type CursorHookRemovalInput = {
  readonly existing?: unknown;
  /** Restrict removal to these events. Omitted means every event in the document. */
  readonly events?: readonly string[];
  readonly identifies: HookHandlerPredicate;
};

export type CursorHookDocumentResult = {
  /** Write this back verbatim. */
  readonly config: Record<string, unknown>;
  readonly changed: boolean;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const buildEntry = (input: MergeCursorHookRegistrationInput): CursorHookCommandEntry => ({
  type: "command",
  command: input.command,
  ...(input.timeoutSeconds === undefined ? {} : { timeout: input.timeoutSeconds }),
  ...(input.matcher === undefined ? {} : { matcher: input.matcher }),
});

/**
 * Merge this tool's registration into a Cursor hook document.
 *
 * Pure and filesystem-free (ADR 0003): the caller reads the file, passes the
 * parsed value in, and writes the returned document back. Two guarantees, both
 * asserted in `tests/install/cursor-registration.test.ts`:
 *
 * - **Idempotence.** Re-merging identical options against the returned document
 *   is a no-op (`changed: false`) with a deep-equal document.
 * - **One entry per event.** Our entry is rewritten in place on an upgrade and
 *   any duplicate of it is collapsed, so a changed command cannot leave a stale
 *   handler firing beside the new one and double every span.
 *
 * `version` is added only when the document does not already declare one. A
 * developer's existing `version` is never rewritten — Cursor could raise it, and
 * downgrading a document to match this constant would be a guess about a schema
 * this tool does not own.
 */
export const mergeCursorHookRegistration = (
  input: MergeCursorHookRegistrationInput,
): CursorHookDocumentResult => {
  const events = input.events ?? CURSOR_REGISTRABLE_HOOK_EVENTS;
  const base = isPlainObject(input.existing) ? { ...input.existing } : {};
  const existingHooks = isPlainObject(base.hooks) ? base.hooks : {};
  const nextHooks: Record<string, unknown> = { ...existingHooks };
  const desired = buildEntry(input);

  let changed = false;
  if (base.version === undefined) {
    base.version = CURSOR_HOOKS_DOCUMENT_VERSION;
    changed = true;
  }

  for (const event of events) {
    const currentList = Array.isArray(existingHooks[event])
      ? [...(existingHooks[event] as unknown[])]
      : [];
    const managed = currentList.filter(
      (entry): entry is Record<string, unknown> => isPlainObject(entry) && input.identifies(entry),
    );
    const [ours] = managed;

    if (ours === undefined) {
      nextHooks[event] = [...currentList, desired];
      changed = true;
      continue;
    }

    // Rewrite our own entry where it already sits, and drop every duplicate of
    // it. Rewriting in place rather than re-appending keeps an unchanged merge
    // from reordering a developer's file.
    const rewritten = { ...ours, ...desired };
    const next = currentList
      .filter((entry) => entry === ours || !(isPlainObject(entry) && input.identifies(entry)))
      .map((entry) => (entry === ours ? rewritten : entry));
    const entryChanged = Object.entries(desired).some(([key, value]) => ours[key] !== value);
    if (entryChanged || managed.length > 1) {
      changed = true;
    }
    nextHooks[event] = next;
  }

  return { config: { ...base, hooks: nextHooks }, changed };
};

/**
 * Reverse {@link mergeCursorHookRegistration}.
 *
 * An event whose list becomes empty is deleted, and an emptied `hooks` object is
 * deleted with it, so uninstalling restores a document that had no hooks before
 * setup. A lone `version` left behind by that pruning is dropped too: a
 * `hooks.json` declaring a schema version for no hooks is a document Cursor
 * reads nothing from, and leaving it would mean `setup` followed by `uninstall`
 * created a file where there was none.
 */
export const removeCursorHookRegistration = (
  input: CursorHookRemovalInput,
): CursorHookDocumentResult => {
  const base = isPlainObject(input.existing) ? { ...input.existing } : {};
  if (!isPlainObject(base.hooks)) {
    return { config: base, changed: false };
  }

  const nextHooks: Record<string, unknown> = { ...base.hooks };
  const events = input.events ?? Object.keys(nextHooks);
  let changed = false;

  for (const event of events) {
    const currentList = nextHooks[event];
    if (!Array.isArray(currentList)) {
      continue;
    }
    const kept = currentList.filter(
      (entry) => !(isPlainObject(entry) && input.identifies(entry)),
    );
    if (kept.length === currentList.length) {
      continue;
    }
    changed = true;
    if (kept.length === 0) {
      delete nextHooks[event];
    } else {
      nextHooks[event] = kept;
    }
  }

  if (!changed) {
    return { config: base, changed: false };
  }

  const config = { ...base };
  if (Object.keys(nextHooks).length === 0) {
    delete config.hooks;
    if (Object.keys(config).length === 1 && config.version === CURSOR_HOOKS_DOCUMENT_VERSION) {
      delete config.version;
    }
  } else {
    config.hooks = nextHooks;
  }
  return { config, changed };
};

/** Managed command strings currently registered, per event. */
export const readCursorHookRegistrations = (
  existing: unknown,
  identifies: HookHandlerPredicate,
): ReadonlyMap<string, readonly string[]> => {
  const found = new Map<string, string[]>();
  if (!isPlainObject(existing) || !isPlainObject(existing.hooks)) {
    return found;
  }
  for (const [event, list] of Object.entries(existing.hooks)) {
    if (!Array.isArray(list)) {
      continue;
    }
    const commands = list
      .filter(
        (entry): entry is Record<string, unknown> =>
          isPlainObject(entry) && typeof entry.command === "string" && identifies(entry),
      )
      .map((entry) => entry.command as string);
    if (commands.length > 0) {
      found.set(event, commands);
    }
  }
  return found;
};
