/**
 * Pure merge/removal engine for the "nested command hooks" configuration family.
 *
 * Claude Code and the Codex CLI document the same document shape:
 *
 * ```jsonc
 * {
 *   "hooks": {
 *     "<EventName>": [
 *       { "matcher": "Bash", "hooks": [{ "type": "command", "command": "…", "timeout": 30 }] }
 *     ]
 *   }
 * }
 * ```
 *
 * The shape is generic; the *vocabulary* is not. Which events exist, which
 * matchers are meaningful, and what a timeout means stay in each provider's own
 * planner (`claude/registration.ts`, `codex/registration.ts`), so nothing here
 * encodes a provider contract and nothing here has to be re-verified when one
 * provider adds an event.
 *
 * Everything is pure: callers read the file, pass the parsed value in, and write
 * the returned document back (ADR 0003). Two properties this engine guarantees,
 * both covered by tests:
 *
 * - **Idempotence.** Re-merging identical options against the returned document
 *   yields `changed: false` and a deep-equal document.
 * - **Reversibility.** `removeNestedHookRegistrations` after
 *   `mergeNestedHookRegistration` restores the input document exactly, including
 *   dropping structure the merge created.
 *
 * A document whose `hooks` value is not the documented shape is *reported*, not
 * coerced: silently replacing a developer's unexpected `hooks` value would
 * destroy configuration this package does not understand.
 */

export type CommandHookEntry = {
  readonly type: "command";
  readonly command: string;
  /** Seconds. Both documented vocabularies use seconds, not milliseconds. */
  readonly timeout?: number;
  readonly [key: string]: unknown;
};

export type HookGroupEntry = {
  readonly matcher?: string;
  readonly hooks: readonly unknown[];
  readonly [key: string]: unknown;
};

export type HookDocumentAction = "added" | "updated" | "unchanged" | "removed";

export type HookDocumentChange = {
  readonly event: string;
  readonly action: HookDocumentAction;
};

/** A structural surprise. Reported so a caller can refuse to write. */
export type HookDocumentConflict = {
  /** Dotted location inside the document, e.g. `hooks.PreToolUse`. */
  readonly location: string;
  readonly detail: string;
};

export type NestedHookDocumentResult = {
  /** Write this back verbatim. Identical to the input when `conflicts` is non-empty. */
  readonly document: Record<string, unknown>;
  readonly changed: boolean;
  readonly changes: readonly HookDocumentChange[];
  readonly conflicts: readonly HookDocumentConflict[];
};

export type MergeNestedHookInput = {
  /** Parsed configuration document, or anything else when no file exists yet. */
  readonly existing?: unknown;
  readonly events: readonly string[];
  /** The exact command entry to write. Compared field-by-field for idempotence. */
  readonly entry: CommandHookEntry;
  /**
   * Matcher for a *newly created* group. Omitted means "no matcher key", which
   * both vocabularies define as matching every occurrence.
   */
  readonly matcher?: string;
  /**
   * Recognizes a handler this tool previously wrote, so an upgrade rewrites its
   * own entry instead of appending a second one. Takes the whole handler
   * because the identity key differs by vocabulary: Gemini CLI handlers carry a
   * `name`, Claude Code and Codex handlers are identified by their command.
   */
  readonly identifies: HookHandlerPredicate;
};

export type HookHandlerPredicate = (handler: Readonly<Record<string, unknown>>) => boolean;

export type RemoveNestedHookInput = {
  readonly existing?: unknown;
  /** Restrict removal to these events. Omitted means every event in the document. */
  readonly events?: readonly string[];
  readonly identifies: HookHandlerPredicate;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `"*"`, `""` and an absent matcher are all documented as "match everything",
 * so they must compare equal or an upgrade would append a duplicate beside the
 * entry it meant to replace.
 */
const normalizeMatcher = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" && value !== "*" ? value : undefined;

const isManaged = (value: unknown, identifies: HookHandlerPredicate): boolean =>
  isPlainObject(value) && identifies(value);

const cloneGroup = (value: unknown): Record<string, unknown> | undefined =>
  isPlainObject(value) && Array.isArray(value.hooks)
    ? { ...value, hooks: [...(value.hooks as unknown[])] }
    : undefined;

/** Field-by-field equality against the desired entry, over the desired keys only. */
const matchesDesired = (existing: Record<string, unknown>, desired: CommandHookEntry): boolean => {
  for (const [key, value] of Object.entries(desired)) {
    if (existing[key] !== value) {
      return false;
    }
  }
  return true;
};

const readEventList = (
  hooks: Record<string, unknown>,
  event: string,
  conflicts: HookDocumentConflict[],
): unknown[] | undefined => {
  const raw = hooks[event];
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    conflicts.push({
      location: `hooks.${event}`,
      detail: `expected an array of hook groups, found ${raw === null ? "null" : typeof raw}`,
    });
    return undefined;
  }
  return [...(raw as unknown[])];
};

const readHooksObject = (
  base: Record<string, unknown>,
  conflicts: HookDocumentConflict[],
): Record<string, unknown> | undefined => {
  const raw = base.hooks;
  if (raw === undefined) {
    return {};
  }
  if (!isPlainObject(raw)) {
    conflicts.push({
      location: "hooks",
      detail: `expected an object keyed by hook event name, found ${
        Array.isArray(raw) ? "an array" : raw === null ? "null" : typeof raw
      }`,
    });
    return undefined;
  }
  return { ...raw };
};

/** Drop groups with no handlers left, then the event key if no groups remain. */
const pruneEventList = (list: unknown[]): unknown[] =>
  list.filter((group) => !(isPlainObject(group) && Array.isArray(group.hooks) && group.hooks.length === 0));

const finalize = (
  base: Record<string, unknown>,
  hooks: Record<string, unknown>,
): Record<string, unknown> => {
  const next = { ...base };
  if (Object.keys(hooks).length === 0) {
    // Dropping an emptied `hooks` key is what makes uninstall exactly reversible:
    // a document that had no hooks before setup has none after uninstall.
    delete next.hooks;
    return next;
  }
  next.hooks = hooks;
  return next;
};

/**
 * Merge one command registration into the document, once per event.
 *
 * Identity is `(event, managed handler)`, deliberately not
 * `(event, matcher, command)`. An event ends up with **exactly one** handler of
 * ours afterwards, wherever it was before, which is what makes the three
 * interesting cases behave:
 *
 * - *Repeat.* Same options twice is a no-op, in place, byte for byte.
 * - *Upgrade.* A changed command, timeout, or matcher rewrites — or moves —
 *   the entry we already own instead of appending a second one that would
 *   double every span this event produces.
 * - *Repair.* Pre-existing duplicates of ours are collapsed to one.
 *
 * A handler that stays in its group is rewritten at its original index rather
 * than removed and re-appended, so an unchanged merge cannot reorder a
 * developer's file.
 */
export const mergeNestedHookRegistration = (
  input: MergeNestedHookInput,
): NestedHookDocumentResult => {
  const base = isPlainObject(input.existing) ? { ...input.existing } : {};
  const conflicts: HookDocumentConflict[] = [];
  const hooks = readHooksObject(base, conflicts);
  if (hooks === undefined) {
    return { document: base, changed: false, changes: [], conflicts };
  }

  const changes: HookDocumentChange[] = [];
  let changed = false;
  const desiredMatcher = normalizeMatcher(input.matcher);

  for (const event of input.events) {
    const list = readEventList(hooks, event, conflicts);
    if (list === undefined) {
      continue;
    }

    const groups = list.map((group) => cloneGroup(group) ?? group);
    const usableGroups = groups.filter(
      (group): group is Record<string, unknown> =>
        isPlainObject(group) && Array.isArray(group.hooks),
    );

    let ownHandler: Record<string, unknown> | undefined;
    let ownGroup: Record<string, unknown> | undefined;
    let ownIndex = -1;
    let duplicates = 0;
    for (const group of usableGroups) {
      const handlers = group.hooks as unknown[];
      for (let index = 0; index < handlers.length; index += 1) {
        if (!isManaged(handlers[index], input.identifies)) {
          continue;
        }
        if (ownHandler === undefined) {
          ownHandler = handlers[index] as Record<string, unknown>;
          ownGroup = group;
          ownIndex = index;
        } else {
          duplicates += 1;
        }
      }
    }

    if (duplicates > 0) {
      // Everything of ours except the first, which stays where it is so
      // `ownIndex` remains valid.
      for (const group of usableGroups) {
        group.hooks = (group.hooks as unknown[]).filter(
          (handler) => handler === ownHandler || !isManaged(handler, input.identifies),
        );
      }
    }

    let target = usableGroups.find(
      (group) => normalizeMatcher(group.matcher) === desiredMatcher,
    );
    if (target === undefined) {
      target = {
        ...(input.matcher === undefined ? {} : { matcher: input.matcher }),
        hooks: [] as unknown[],
      };
      groups.push(target);
    }

    let action: HookDocumentAction;
    if (ownHandler === undefined) {
      target.hooks = [...(target.hooks as unknown[]), { ...input.entry }];
      action = "added";
    } else if (ownGroup === target) {
      const handlers = [...(target.hooks as unknown[])];
      const alreadyDesired = matchesDesired(ownHandler, input.entry);
      handlers[ownIndex] = alreadyDesired ? ownHandler : { ...ownHandler, ...input.entry };
      target.hooks = handlers;
      action = alreadyDesired && duplicates === 0 ? "unchanged" : "updated";
    } else {
      // The requested matcher changed: move our entry rather than leave one
      // firing under the old matcher and add another under the new one.
      if (ownGroup !== undefined) {
        ownGroup.hooks = (ownGroup.hooks as unknown[]).filter((handler) => handler !== ownHandler);
      }
      target.hooks = [...(target.hooks as unknown[]), { ...ownHandler, ...input.entry }];
      action = "updated";
    }

    changes.push({ event, action });
    changed = changed || action !== "unchanged";

    hooks[event] = pruneEventList(groups);
  }

  if (conflicts.length > 0) {
    return { document: base, changed: false, changes: [], conflicts };
  }
  return { document: finalize(base, hooks), changed, changes, conflicts };
};

/**
 * Remove every registration this tool owns, leaving all other handlers,
 * matchers, events, and top-level keys untouched.
 *
 * Removal scans events actually present in the document rather than a fixed
 * list, so an uninstall still cleans up after a setup that used `--event`.
 */
export const removeNestedHookRegistrations = (
  input: RemoveNestedHookInput,
): NestedHookDocumentResult => {
  const base = isPlainObject(input.existing) ? { ...input.existing } : {};
  const conflicts: HookDocumentConflict[] = [];
  const hooks = readHooksObject(base, conflicts);
  if (hooks === undefined) {
    return { document: base, changed: false, changes: [], conflicts };
  }

  const changes: HookDocumentChange[] = [];
  let changed = false;
  const events = input.events ?? Object.keys(hooks);

  for (const event of events) {
    if (!(event in hooks)) {
      continue;
    }
    const list = readEventList(hooks, event, conflicts);
    if (list === undefined) {
      continue;
    }

    let removedHere = false;
    const groups: unknown[] = [];
    for (const group of list) {
      const cloned = cloneGroup(group);
      if (cloned === undefined) {
        groups.push(group);
        continue;
      }
      const handlers = (cloned.hooks as unknown[]).filter(
        (handler) => !isManaged(handler, input.identifies),
      );
      if (handlers.length !== (cloned.hooks as unknown[]).length) {
        removedHere = true;
      }
      cloned.hooks = handlers;
      groups.push(cloned);
    }

    if (!removedHere) {
      continue;
    }
    changed = true;
    changes.push({ event, action: "removed" });
    const pruned = pruneEventList(groups);
    if (pruned.length === 0) {
      delete hooks[event];
    } else {
      hooks[event] = pruned;
    }
  }

  if (conflicts.length > 0) {
    return { document: base, changed: false, changes: [], conflicts };
  }
  return { document: finalize(base, hooks), changed, changes, conflicts };
};

/**
 * Every managed command string currently registered, per event.
 *
 * Used by `diagnose` to tell "registered with the command we would write" from
 * "registered with a stale command an upgrade should rewrite".
 */
export const readNestedHookRegistrations = (
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
    const commands: string[] = [];
    for (const group of list) {
      if (!isPlainObject(group) || !Array.isArray(group.hooks)) {
        continue;
      }
      for (const handler of group.hooks) {
        if (isManaged(handler, identifies)) {
          const command = (handler as Record<string, unknown>).command;
          commands.push(typeof command === "string" ? command : "");
        }
      }
    }
    if (commands.length > 0) {
      found.set(event, commands);
    }
  }
  return found;
};
