import type { HookHandlerPredicate } from "../hook-document.js";
import { ANTIGRAVITY_HOOK_EVENT_NAMES, type AntigravityHookEventName } from "./payload.js";

/** One command entry inside an Antigravity hook event's list. */
export type AntigravityHookCommandEntry = {
  readonly matcher?: string;
  readonly command: string;
};

export type MergeAntigravityHookRegistrationInput = {
  /** Parsed JSON of an existing hook file, or `undefined`/anything non-object if none exists yet. */
  readonly existing?: unknown;
  /** Command line this library's hook installs for every targeted event. */
  readonly command: string;
  /** Defaults to all five documented events. */
  readonly events?: readonly AntigravityHookEventName[];
  readonly matcher?: string;
  /**
   * Recognizes entries an earlier version of this tool wrote, so a changed
   * command string rewrites its own entry instead of leaving a stale one
   * firing beside the new one. Defaults to exact-command equality.
   */
  readonly identifies?: HookHandlerPredicate;
};

export type MergeAntigravityHookRegistrationResult = {
  /** The merged document; write this back verbatim. */
  readonly config: Record<string, unknown>;
  /** True when the merge added or changed anything relative to `existing`. */
  readonly changed: boolean;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Idempotently merge this library's hook registration into an Antigravity
 * workspace or global hook file, without touching unrelated keys or events.
 *
 * Pure and filesystem-free by design (see ADR 0003): callers own reading and
 * writing the file. Calling this twice with the same inputs is a no-op the
 * second time (`changed: false`), and every top-level key and every hook
 * event not named in `events` is carried through unmodified.
 */
export const mergeAntigravityHookRegistration = (
  input: MergeAntigravityHookRegistrationInput,
): MergeAntigravityHookRegistrationResult => {
  const events = input.events ?? ANTIGRAVITY_HOOK_EVENT_NAMES;
  const base = isPlainObject(input.existing) ? input.existing : {};
  const existingHooks = isPlainObject(base.hooks) ? base.hooks : {};
  let changed = !isPlainObject(input.existing) || !isPlainObject(base.hooks);

  const nextHooks: Record<string, unknown> = { ...existingHooks };

  const identifies: HookHandlerPredicate =
    input.identifies ?? ((entry): boolean => entry.command === input.command);
  const desired: AntigravityHookCommandEntry = {
    command: input.command,
    ...(input.matcher === undefined ? {} : { matcher: input.matcher }),
  };

  for (const event of events) {
    const currentList = Array.isArray(existingHooks[event]) ? [...(existingHooks[event] as unknown[])] : [];
    const managedIndex = currentList.findIndex((entry) => isPlainObject(entry) && identifies(entry));

    if (managedIndex === -1) {
      changed = true;
      nextHooks[event] = [...currentList, desired];
      continue;
    }

    // Rewrite our own entry in place (an upgrade) and drop any duplicate of it,
    // which would otherwise double every span this event produces.
    const managed = currentList[managedIndex] as Record<string, unknown>;
    const updated = { ...managed, ...desired };
    const next = currentList.filter(
      (entry, index) => index === managedIndex || !(isPlainObject(entry) && identifies(entry)),
    );
    next[next.indexOf(managed)] = updated;
    const rewritten = Object.entries(desired).some(([key, value]) => managed[key] !== value);
    if (next.length !== currentList.length || rewritten) {
      changed = true;
    }
    nextHooks[event] = next;
  }

  return {
    config: { ...base, hooks: nextHooks },
    changed,
  };
};

export type RemoveAntigravityHookRegistrationInput = {
  readonly existing?: unknown;
  /** Restrict removal to these events. Omitted means every event in the document. */
  readonly events?: readonly AntigravityHookEventName[];
  /** Recognizes hook entries this tool wrote, across versions. */
  readonly identifies: HookHandlerPredicate;
};

/**
 * Reverse {@link mergeAntigravityHookRegistration}.
 *
 * Antigravity's hook file is a *flat* list of command entries per event, not
 * the nested matcher-group shape Claude Code, Codex, and the Gemini CLI use, so
 * this cannot share their engine. An event whose list becomes empty is deleted,
 * and an emptied `hooks` object is deleted with it, so an uninstall restores a
 * document that had no hooks before setup.
 */
export const removeAntigravityHookRegistration = (
  input: RemoveAntigravityHookRegistrationInput,
): MergeAntigravityHookRegistrationResult => {
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
  } else {
    config.hooks = nextHooks;
  }
  return { config, changed };
};

/** Managed command strings currently registered, per event. */
export const readAntigravityHookRegistrations = (
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
