import {
  mergeNestedHookRegistration,
  readNestedHookRegistrations,
  removeNestedHookRegistrations,
  type CommandHookEntry,
  type HookHandlerPredicate,
  type NestedHookDocumentResult,
} from "../hook-document.js";
import { CLAUDE_HOOK_EVENT_NAMES, type ClaudeHookEventName } from "./schema.js";

/**
 * Idempotent registration planner for Claude Code's `settings.json`.
 *
 * ## Evidence
 *
 * The document shape, the scopes, and the event vocabulary come from the public
 * Claude Code hooks reference (`code.claude.com/docs/en/hooks`, read 2026-07),
 * cross-checked against the setup implementation in
 * `o11y-dev/opentelemetry-hooks` v0.14.0 (`setup.sh`, `setup_claude`). Both
 * agree on:
 *
 * - `hooks.<EventName>` is an array of groups; each group is
 *   `{ matcher?, hooks: [{ type: "command", command, timeout? }] }`.
 * - `~/.claude/settings.json` is the user-global file and
 *   `.claude/settings.json` the project file (`.claude/settings.local.json` is
 *   the gitignored project override).
 * - `timeout` is in seconds.
 *
 * The reference additionally documents that an omitted `matcher` matches every
 * occurrence, and that `UserPromptSubmit` and `Stop` take no matcher at all.
 * This planner therefore writes **no** `matcher` key by default: one spelling
 * that is valid for every event it registers, rather than a per-event table
 * that would have to be re-verified whenever Claude Code adds an event.
 *
 * ## Why not every documented event
 *
 * {@link CLAUDE_REGISTRABLE_HOOK_EVENTS} is the intersection of "documented as a
 * hook event" and "this adapter turns it into a canonical event". `PreCompact`
 * and `PermissionRequest` are parsed but deliberately produce no telemetry
 * (see `events.ts`), so registering them would spawn a process per occurrence
 * for nothing. Callers who want them anyway can pass `events` explicitly.
 */

/** Every event name this repository's Claude Code adapter accepts on stdin. */
export const CLAUDE_HOOK_EVENTS_MODELLED: readonly ClaudeHookEventName[] = CLAUDE_HOOK_EVENT_NAMES;

/**
 * Default registration set: the modelled events that yield telemetry.
 * Ordered as the reference documents the lifecycle, so a written settings file
 * reads in the order the events fire.
 */
export const CLAUDE_REGISTRABLE_HOOK_EVENTS: readonly ClaudeHookEventName[] = Object.freeze([
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "SubagentStart",
  "SubagentStop",
  "PostCompact",
  "Stop",
  "StopFailure",
  "SessionEnd",
] as const);

/** Documented but intentionally not registered, with the reason. */
export const CLAUDE_UNREGISTERED_HOOK_EVENTS: Readonly<Record<string, string>> = Object.freeze({
  PermissionRequest:
    "the adapter reports permission decisions on the paired tool.end event, so a hook here would emit nothing",
  PreCompact:
    "the adapter reports compaction once it completes, at PostCompact, so a hook here would emit nothing",
});

export type ClaudeHookRegistrationOptions = {
  /** Parsed `settings.json`, or `undefined` when the file does not exist yet. */
  readonly existing?: unknown;
  readonly command: string;
  /** Defaults to {@link CLAUDE_REGISTRABLE_HOOK_EVENTS}. */
  readonly events?: readonly string[];
  /** Seconds. Omitted leaves Claude Code's own default in force. */
  readonly timeoutSeconds?: number;
  /**
   * Written only when creating a new group. Omitted (the default) means "every
   * occurrence", the only spelling valid for every registrable event.
   */
  readonly matcher?: string;
  /** Recognizes entries written by an earlier version of this tool. */
  readonly identifies: HookHandlerPredicate;
};

export type ClaudeHookRemovalOptions = {
  readonly existing?: unknown;
  readonly events?: readonly string[];
  readonly identifies: HookHandlerPredicate;
};

const buildEntry = (options: ClaudeHookRegistrationOptions): CommandHookEntry => ({
  type: "command",
  command: options.command,
  ...(options.timeoutSeconds === undefined ? {} : { timeout: options.timeoutSeconds }),
});

export const mergeClaudeHookRegistration = (
  options: ClaudeHookRegistrationOptions,
): NestedHookDocumentResult =>
  mergeNestedHookRegistration({
    ...(options.existing === undefined ? {} : { existing: options.existing }),
    events: options.events ?? CLAUDE_REGISTRABLE_HOOK_EVENTS,
    entry: buildEntry(options),
    ...(options.matcher === undefined ? {} : { matcher: options.matcher }),
    identifies: options.identifies,
  });

export const removeClaudeHookRegistration = (
  options: ClaudeHookRemovalOptions,
): NestedHookDocumentResult =>
  removeNestedHookRegistrations({
    ...(options.existing === undefined ? {} : { existing: options.existing }),
    ...(options.events === undefined ? {} : { events: options.events }),
    identifies: options.identifies,
  });

export const readClaudeHookRegistrations = readNestedHookRegistrations;
