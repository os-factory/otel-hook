import {
  mergeNestedHookRegistration,
  readNestedHookRegistrations,
  removeNestedHookRegistrations,
  type CommandHookEntry,
  type HookHandlerPredicate,
  type NestedHookDocumentResult,
} from "../hook-document.js";
import { CODEX_HOOK_EVENT_NAMES, type CodexHookEventName } from "./payload.js";

/**
 * Idempotent registration planner for the Codex CLI's `hooks.json`.
 *
 * ## Evidence
 *
 * The public Codex hooks reference (`developers.openai.com/codex/hooks`,
 * redirecting to `learn.chatgpt.com/docs/hooks`, read 2026-07 — the same source
 * `payload.ts` cites for the stdin payloads) documents:
 *
 * - Discovery locations `~/.codex/hooks.json` and `<repo>/.codex/hooks.json`,
 *   with equivalent inline `[[hooks.EventName]]` tables in `config.toml`.
 * - The `hooks.<EventName>` → array-of-groups → `{ matcher?, hooks: [...] }`
 *   shape, matching Claude Code's.
 * - `matcher` optional, where omitting it "matches every occurrence".
 * - `timeout` in seconds.
 * - Hooks **enabled by default**; `[features] hooks = false` in `config.toml`
 *   turns them off.
 *
 * This planner writes only `hooks.json`. It never edits `config.toml`: hooks
 * being on by default means no edit is required, and rewriting a hand-authored
 * TOML file to flip a flag that is already set is a mutation with more downside
 * (comment loss, formatting loss, merge-warning on a layer that also declares
 * inline hooks) than value. {@link readCodexHooksFeatureFlag} lets `diagnose`
 * *report* an explicit opt-out instead.
 *
 * ## Why not every documented event
 *
 * The reference lists `SessionEnd`, but this repository's adapter deliberately
 * does not model it (see `payload.ts`: Codex has no dependable `SessionEnd`, and
 * `adapter.ts` substitutes `Stop` plus a state-store TTL). Registering an event
 * whose payload the adapter would reject is worse than not registering it.
 * `PermissionRequest` is modelled but produces no telemetry of its own, so it is
 * not in the default set either.
 */

/** Every `hook_event_name` this repository's Codex adapter accepts. */
export const CODEX_HOOK_EVENTS_MODELLED: readonly CodexHookEventName[] = CODEX_HOOK_EVENT_NAMES;

/** Default registration set: modelled events that yield telemetry, in lifecycle order. */
export const CODEX_REGISTRABLE_HOOK_EVENTS: readonly CodexHookEventName[] = Object.freeze([
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "Stop",
] as const);

/** Documented or modelled but intentionally not registered, with the reason. */
export const CODEX_UNREGISTERED_HOOK_EVENTS: Readonly<Record<string, string>> = Object.freeze({
  PermissionRequest:
    "the adapter reports the decision on the paired tool.end event, so a hook here would emit nothing",
  SessionEnd:
    "documented by Codex but not modelled by this adapter; the payload would be rejected (see payload.ts)",
});

export type CodexHookRegistrationOptions = {
  /** Parsed `hooks.json`, or `undefined` when the file does not exist yet. */
  readonly existing?: unknown;
  readonly command: string;
  /** Defaults to {@link CODEX_REGISTRABLE_HOOK_EVENTS}. */
  readonly events?: readonly string[];
  /** Seconds. Omitted leaves Codex's own per-event default in force. */
  readonly timeoutSeconds?: number;
  readonly matcher?: string;
  readonly identifies: HookHandlerPredicate;
};

export type CodexHookRemovalOptions = {
  readonly existing?: unknown;
  readonly events?: readonly string[];
  readonly identifies: HookHandlerPredicate;
};

const buildEntry = (options: CodexHookRegistrationOptions): CommandHookEntry => ({
  type: "command",
  command: options.command,
  ...(options.timeoutSeconds === undefined ? {} : { timeout: options.timeoutSeconds }),
});

export const mergeCodexHookRegistration = (
  options: CodexHookRegistrationOptions,
): NestedHookDocumentResult =>
  mergeNestedHookRegistration({
    ...(options.existing === undefined ? {} : { existing: options.existing }),
    events: options.events ?? CODEX_REGISTRABLE_HOOK_EVENTS,
    entry: buildEntry(options),
    ...(options.matcher === undefined ? {} : { matcher: options.matcher }),
    identifies: options.identifies,
  });

export const removeCodexHookRegistration = (
  options: CodexHookRemovalOptions,
): NestedHookDocumentResult =>
  removeNestedHookRegistrations({
    ...(options.existing === undefined ? {} : { existing: options.existing }),
    ...(options.events === undefined ? {} : { events: options.events }),
    identifies: options.identifies,
  });

export const readCodexHookRegistrations = readNestedHookRegistrations;

export type CodexHooksFeatureFlag = "enabled" | "disabled" | "unset";

/**
 * Read the `[features] hooks` opt-out from a `config.toml`'s text.
 *
 * Line-scoped on purpose: this is a read-only diagnostic for one documented
 * boolean, not a TOML parser, and it must never be used to decide a write. It
 * looks only at bare `key = value` lines inside a top-level `[features]` table,
 * so a `hooks` key in any other table cannot be mistaken for this one. Anything
 * it cannot interpret is reported as `"unset"` — Codex's own default.
 */
export const readCodexHooksFeatureFlag = (configToml: string): CodexHooksFeatureFlag => {
  let inFeatures = false;
  for (const line of configToml.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || trimmed.length === 0) {
      continue;
    }
    if (trimmed.startsWith("[")) {
      inFeatures = trimmed === "[features]";
      continue;
    }
    if (!inFeatures) {
      continue;
    }
    const match = /^hooks\s*=\s*(true|false)\s*(?:#.*)?$/.exec(trimmed);
    if (match !== null) {
      return match[1] === "false" ? "disabled" : "enabled";
    }
  }
  return "unset";
};
