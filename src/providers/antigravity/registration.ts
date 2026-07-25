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
};

export type MergeAntigravityHookRegistrationResult = {
  /** The merged document; write this back verbatim. */
  readonly config: Record<string, unknown>;
  /** True when the merge added or changed anything relative to `existing`. */
  readonly changed: boolean;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isOwnCommandEntry = (value: unknown, command: string): boolean =>
  isPlainObject(value) && value.command === command;

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

  for (const event of events) {
    const currentList = Array.isArray(existingHooks[event]) ? [...(existingHooks[event] as unknown[])] : [];
    if (currentList.some((entry) => isOwnCommandEntry(entry, input.command))) {
      nextHooks[event] = currentList;
      continue;
    }
    changed = true;
    const entry: AntigravityHookCommandEntry = {
      command: input.command,
      ...(input.matcher === undefined ? {} : { matcher: input.matcher }),
    };
    nextHooks[event] = [...currentList, entry];
  }

  return {
    config: { ...base, hooks: nextHooks },
    changed,
  };
};
