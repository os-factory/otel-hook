import { GEMINI_HOOK_EVENT_NAMES, type GeminiHookEventName } from "./schema.js";

/**
 * Idempotent helper for registering this adapter's command hook into a Gemini
 * CLI `settings.json`. It never touches the filesystem itself — callers read
 * the existing settings, pass the parsed value in, and write the returned
 * value back — so the merge logic stays pure and testable, and this package
 * never needs a filesystem handle (see ADR 0003).
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
};

export type MergeGeminiHookResult = {
  readonly settings: GeminiHooksSettings;
  /** False when every requested event already had this exact registration. */
  readonly changed: boolean;
  readonly registeredEvents: readonly GeminiHookEventName[];
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const buildCommandEntry = (options: RegisterGeminiHookOptions): GeminiHookCommandEntry => ({
  name: options.name,
  type: "command",
  command: options.command,
  ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
});

const isSameRegistration = (entry: GeminiHookCommandEntry, options: RegisterGeminiHookOptions): boolean =>
  entry.name === options.name &&
  entry.type === "command" &&
  entry.command === options.command &&
  entry.timeout === options.timeout;

const isMatcherEntry = (value: unknown): value is GeminiHookMatcherEntry =>
  isPlainRecord(value) && Array.isArray(value.hooks);

const readMatcherEntries = (value: unknown): GeminiHookMatcherEntry[] =>
  Array.isArray(value) ? value.filter(isMatcherEntry) : [];

/**
 * Merge this adapter's hook registration into an existing (parsed)
 * `settings.json` value, once per requested event.
 *
 * Re-running with identical options is a no-op (`changed: false`): the merge
 * looks for a matcher entry with the same `matcher` string, then for a command
 * entry with the same `name`/`command`/`timeout` within it, and only appends
 * when neither exists. Existing hooks from other tools, and settings fields
 * outside `hooks`, are preserved untouched.
 */
export const mergeGeminiHookRegistration = (
  existing: unknown,
  options: RegisterGeminiHookOptions,
): MergeGeminiHookResult => {
  const base = isPlainRecord(existing) ? { ...existing } : {};
  const matcher = options.matcher ?? "*";
  const events = options.events ?? GEMINI_HOOK_EVENT_NAMES;

  const existingHooks = isPlainRecord(base.hooks) ? base.hooks : {};
  const nextHooks: Record<string, readonly GeminiHookMatcherEntry[]> = {};
  for (const [event, value] of Object.entries(existingHooks)) {
    nextHooks[event] = readMatcherEntries(value);
  }
  let changed = false;
  const registeredEvents: GeminiHookEventName[] = [];

  for (const event of events) {
    const entries: GeminiHookMatcherEntry[] = [...(nextHooks[event] ?? [])];
    const matcherIndex = entries.findIndex((entry) => (entry.matcher ?? "*") === matcher);

    if (matcherIndex === -1) {
      entries.push({ matcher, hooks: [buildCommandEntry(options)] });
      changed = true;
    } else {
      const matcherEntry = entries[matcherIndex];
      if (matcherEntry === undefined) {
        continue;
      }
      const alreadyRegistered = matcherEntry.hooks.some((hook) => isSameRegistration(hook, options));
      if (!alreadyRegistered) {
        entries[matcherIndex] = {
          ...matcherEntry,
          hooks: [...matcherEntry.hooks, buildCommandEntry(options)],
        };
        changed = true;
      }
    }

    nextHooks[event] = entries;
    registeredEvents.push(event);
  }

  return {
    settings: { ...base, hooks: nextHooks },
    changed,
    registeredEvents,
  };
};
