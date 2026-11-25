import type {
  HookDocumentChange,
  HookDocumentConflict,
  HookHandlerPredicate,
} from "../hook-document.js";
import {
  ANTIGRAVITY_HOOK_EVENT_NAMES,
  ANTIGRAVITY_TOOL_HOOK_EVENT_NAMES,
  type AntigravityHookEventName,
  type AntigravityToolHookEventName,
} from "./payload.js";

/**
 * The group name this tool writes. Antigravity's `hooks.json` is a map of
 * hook names to event configuration, not a `hooks` wrapper. Documented at
 * antigravity.google/docs/hooks (read 2026-11-02).
 */
export const ANTIGRAVITY_MANAGED_HOOK_NAME = "otel-hook";

/**
 * Events whose stdin shape this adapter turns into telemetry.
 *
 * `PreToolUse` is unlabeled against a `PostToolUse` that omits `error`.
 * `PreInvocation` and `PostInvocation` share one shape. `Stop` is a real
 * event and still not a canonical one. Registering those would spawn a
 * process that emits nothing. `--event` can still opt in.
 */
export const ANTIGRAVITY_REGISTRABLE_HOOK_EVENTS: readonly AntigravityHookEventName[] = Object.freeze([
  "SessionStart",
  "PostToolUse",
]);

/** Documented, and deliberately not registered, with the reason. */
export const ANTIGRAVITY_UNREGISTERED_HOOK_EVENTS: Readonly<Record<string, string>> = Object.freeze({
  PreToolUse:
    "stdin does not distinguish PreToolUse from a PostToolUse that omits error, so the adapter emits no tool.start",
  PreInvocation:
    "PreInvocation and PostInvocation share one stdin shape, so the adapter emits no generation event",
  PostInvocation:
    "PreInvocation and PostInvocation share one stdin shape, so the adapter emits no generation event",
  Stop: "Stop is execution-loop termination, not a session or generation boundary, so the adapter emits nothing",
});

/** One command handler, as the reference writes it. */
export type AntigravityHookCommandEntry = {
  readonly type: "command";
  readonly command: string;
  /** Seconds. Omitted to keep the host default of 30. */
  readonly timeout?: number;
};

export type MergeAntigravityHookRegistrationInput = {
  /** Parsed JSON of an existing hook file, or anything non-object when none exists yet. */
  readonly existing?: unknown;
  /** Command line this library's hook installs. */
  readonly command: string;
  /** Defaults to {@link ANTIGRAVITY_REGISTRABLE_HOOK_EVENTS}. */
  readonly events?: readonly AntigravityHookEventName[];
  /**
   * Tool-event matcher. `PreToolUse` and `PostToolUse` document `""` and `"*"`
   * as match-all. Direct events ignore a matcher, so it is not written there.
   * Defaults to `"*"`.
   */
  readonly matcher?: string;
  /** Seconds, matching the reference. Written only when the caller sets it. */
  readonly timeoutSeconds?: number;
  /**
   * Recognizes entries an earlier version of this tool wrote. Defaults to
   * exact-command equality.
   */
  readonly identifies?: HookHandlerPredicate;
};

export type MergeAntigravityHookRegistrationResult = {
  /** The merged document; write this back verbatim. Unchanged when `conflicts` is non-empty. */
  readonly config: Record<string, unknown>;
  readonly changed: boolean;
  readonly changes: readonly HookDocumentChange[];
  readonly conflicts: readonly HookDocumentConflict[];
};

export type RemoveAntigravityHookRegistrationInput = {
  readonly existing?: unknown;
  /** Restrict removal to these events. Omitted means every event in the document. */
  readonly events?: readonly AntigravityHookEventName[];
  readonly identifies: HookHandlerPredicate;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isToolEvent = (event: string): event is AntigravityToolHookEventName =>
  (ANTIGRAVITY_TOOL_HOOK_EVENT_NAMES as readonly string[]).includes(event);

const isKnownEvent = (event: string): event is AntigravityHookEventName =>
  (ANTIGRAVITY_HOOK_EVENT_NAMES as readonly string[]).includes(event);

const normalizeMatcher = (value: unknown): string =>
  typeof value === "string" && value !== "" && value !== "*" ? value : "*";

const desiredHandler = (
  command: string,
  timeoutSeconds: number | undefined,
): AntigravityHookCommandEntry => ({
  type: "command",
  command,
  ...(timeoutSeconds === undefined ? {} : { timeout: timeoutSeconds }),
});

const sameJson = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

const structuralConflicts = (existing: unknown): readonly HookDocumentConflict[] => {
  if (!isPlainObject(existing)) {
    return [];
  }
  const conflicts: HookDocumentConflict[] = [];
  for (const [name, hook] of Object.entries(existing)) {
    if (!isPlainObject(hook)) {
      conflicts.push({
        location: name,
        detail: `expected a hook definition object, found ${Array.isArray(hook) ? "an array" : hook === null ? "null" : typeof hook}`,
      });
      continue;
    }
    if (hasOwn(hook, "enabled") && typeof hook.enabled !== "boolean") {
      conflicts.push({
        location: `${name}.enabled`,
        detail: `expected a boolean, found ${hook.enabled === null ? "null" : typeof hook.enabled}`,
      });
    }
    for (const [key, value] of Object.entries(hook)) {
      if (key === "enabled") {
        continue;
      }
      if (!Array.isArray(value)) {
        conflicts.push({
          location: `${name}.${key}`,
          detail: `expected an array of hook handlers, found ${value === null ? "null" : typeof value}`,
        });
      }
    }
  }
  return conflicts;
};

const hasOwn = (record: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key);

const commandsInEntry = (
  entry: unknown,
  identifies: HookHandlerPredicate,
): readonly string[] => {
  if (!isPlainObject(entry)) {
    return [];
  }
  const own =
    typeof entry.command === "string" && identifies(entry) ? [entry.command] : [];
  const nested = Array.isArray(entry.hooks)
    ? entry.hooks.flatMap((handler) => commandsInEntry(handler, identifies))
    : [];
  return [...own, ...nested];
};

/** Managed command strings currently registered, per event, across every named hook. */
export const readAntigravityHookRegistrations = (
  existing: unknown,
  identifies: HookHandlerPredicate,
): ReadonlyMap<string, readonly string[]> => {
  const found = new Map<string, string[]>();
  if (!isPlainObject(existing)) {
    return found;
  }
  for (const hook of Object.values(existing)) {
    if (!isPlainObject(hook)) {
      continue;
    }
    for (const [event, list] of Object.entries(hook)) {
      if (!Array.isArray(list)) {
        continue;
      }
      const commands = list.flatMap((entry) => commandsInEntry(entry, identifies));
      if (commands.length === 0) {
        continue;
      }
      found.set(event, [...(found.get(event) ?? []), ...commands]);
    }
  }
  return found;
};

const hookContainsManaged = (hook: Record<string, unknown>, identifies: HookHandlerPredicate): boolean =>
  Object.values(hook).some(
    (list) => Array.isArray(list) && list.some((entry) => commandsInEntry(entry, identifies).length > 0),
  );

const preferredHookName = (existing: Record<string, unknown>, identifies: HookHandlerPredicate): string => {
  const named = existing[ANTIGRAVITY_MANAGED_HOOK_NAME];
  if (isPlainObject(named)) {
    return ANTIGRAVITY_MANAGED_HOOK_NAME;
  }
  for (const [name, hook] of Object.entries(existing)) {
    if (isPlainObject(hook) && hookContainsManaged(hook, identifies)) {
      return name;
    }
  }
  return ANTIGRAVITY_MANAGED_HOOK_NAME;
};

const rewriteHandlers = (
  list: readonly unknown[],
  handler: AntigravityHookCommandEntry,
  identifies: HookHandlerPredicate,
): { readonly next: unknown[]; readonly changed: boolean } => {
  const managedIndexes = list.flatMap((entry, index) =>
    isPlainObject(entry) && identifies(entry) ? [index] : [],
  );
  const keep = managedIndexes[0];
  if (keep === undefined) {
    return { next: [...list, handler], changed: true };
  }
  const kept = list[keep];
  const updated = { ...(isPlainObject(kept) ? kept : {}), ...handler };
  const next = list.filter(
    (entry, index) => index === keep || !(isPlainObject(entry) && identifies(entry)),
  );
  const keptIndex = next.indexOf(kept);
  next[keptIndex] = updated;
  return { next, changed: next.length !== list.length || !sameJson(kept, updated) };
};

const rewriteToolGroups = (
  list: readonly unknown[],
  handler: AntigravityHookCommandEntry,
  matcher: string,
  identifies: HookHandlerPredicate,
): { readonly next: unknown[]; readonly changed: boolean } => {
  const groups = list.map((entry) => (isPlainObject(entry) ? { ...entry } : entry));
  const managed = groups.flatMap((entry, index) =>
    commandsInEntry(entry, identifies).length > 0 ? [index] : [],
  );
  const keepIndex = managed[0];
  if (keepIndex === undefined) {
    return {
      next: [...list, { matcher, hooks: [handler] }],
      changed: true,
    };
  }
  const keep = groups[keepIndex];
  if (!isPlainObject(keep) || !Array.isArray(keep.hooks)) {
    const next = groups.filter(
      (entry, index) => index === keepIndex || commandsInEntry(entry, identifies).length === 0,
    );
    const placedAt = next.indexOf(keep);
    next[placedAt] = { matcher, hooks: [handler] };
    return { next, changed: true };
  }
  const rewritten = rewriteHandlers(keep.hooks, handler, identifies);
  const nextGroup = { ...keep, matcher, hooks: rewritten.next };
  const next = groups.filter((entry, index) => index === keepIndex || commandsInEntry(entry, identifies).length === 0);
  const placedAt = next.indexOf(keep);
  next[placedAt] = nextGroup;
  return {
    next,
    changed: rewritten.changed || normalizeMatcher(keep.matcher) !== matcher || next.length !== list.length,
  };
};

const stripManaged = (list: readonly unknown[], identifies: HookHandlerPredicate, tool: boolean): unknown[] => {
  if (!tool) {
    return list.filter((entry) => !(isPlainObject(entry) && identifies(entry)));
  }
  const next: unknown[] = [];
  for (const entry of list) {
    if (!isPlainObject(entry) || !Array.isArray(entry.hooks)) {
      next.push(entry);
      continue;
    }
    const hooks = entry.hooks.filter((handler) => !(isPlainObject(handler) && identifies(handler)));
    if (hooks.length === 0) {
      continue;
    }
    if (hooks.length !== entry.hooks.length) {
      next.push({ ...entry, hooks });
    } else {
      next.push(entry);
    }
  }
  return next;
};

const changesBetween = (
  before: ReadonlyMap<string, readonly string[]>,
  after: ReadonlyMap<string, readonly string[]>,
  events: readonly string[],
  removal: boolean,
): readonly HookDocumentChange[] => {
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
    if (!had && has) {
      changes.push({ event, action: "added" });
    } else if (had && has) {
      changes.push({
        event,
        action: sameJson(before.get(event), after.get(event)) ? "unchanged" : "updated",
      });
    }
  }
  return changes;
};

const unknownEventConflicts = (events: readonly string[]): readonly HookDocumentConflict[] =>
  events
    .filter((event) => !isKnownEvent(event))
    .map((event) => ({
      location: event,
      detail: `unknown antigravity hook event; expected one of ${ANTIGRAVITY_HOOK_EVENT_NAMES.join(", ")}`,
    }));

/**
 * Idempotently merge this library's hook registration into an Antigravity
 * `hooks.json`.
 *
 * The document is a map of hook names. Tool events are `{ matcher, hooks }`
 * groups; `SessionStart`, `PreInvocation`, `PostInvocation`, and `Stop` are
 * bare handler lists. Calling this twice with the same inputs is a no-op the
 * second time. A value that is not that shape is reported and left untouched.
 */
export const mergeAntigravityHookRegistration = (
  input: MergeAntigravityHookRegistrationInput,
): MergeAntigravityHookRegistrationResult => {
  const events = input.events ?? ANTIGRAVITY_REGISTRABLE_HOOK_EVENTS;
  const unknown = unknownEventConflicts(events);
  if (unknown.length > 0) {
    return {
      config: isPlainObject(input.existing) ? input.existing : {},
      changed: false,
      changes: [],
      conflicts: unknown,
    };
  }
  const conflicts = structuralConflicts(input.existing);
  if (conflicts.length > 0) {
    return {
      config: isPlainObject(input.existing) ? input.existing : {},
      changed: false,
      changes: [],
      conflicts,
    };
  }

  const identifies: HookHandlerPredicate =
    input.identifies ?? ((entry): boolean => entry.command === input.command);
  const base = isPlainObject(input.existing) ? input.existing : {};
  const before = readAntigravityHookRegistrations(base, identifies);
  const hookName = preferredHookName(base, identifies);
  const currentHook = isPlainObject(base[hookName]) ? { ...base[hookName] } : {};
  const handler = desiredHandler(input.command, input.timeoutSeconds);
  const matcher = normalizeMatcher(input.matcher);
  let changed = !isPlainObject(input.existing) || !isPlainObject(base[hookName]);

  for (const event of events) {
    const currentList = Array.isArray(currentHook[event]) ? (currentHook[event] as unknown[]) : [];
    const rewritten = isToolEvent(event)
      ? rewriteToolGroups(currentList, handler, matcher, identifies)
      : rewriteHandlers(currentList, handler, identifies);
    if (rewritten.changed || !Array.isArray(currentHook[event])) {
      changed = true;
      currentHook[event] = rewritten.next;
    }
  }

  // A copy of this command under some other hook name would double every span.
  const merged: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(base)) {
    if (name === hookName) {
      continue;
    }
    if (!isPlainObject(value)) {
      merged[name] = value;
      continue;
    }
    const cleaned: Record<string, unknown> = {};
    let hookChanged = false;
    for (const [key, list] of Object.entries(value)) {
      if (!Array.isArray(list) || !events.includes(key as AntigravityHookEventName)) {
        cleaned[key] = list;
        continue;
      }
      const stripped = stripManaged(list, identifies, isToolEvent(key));
      if (stripped.length !== list.length) {
        hookChanged = true;
        changed = true;
      }
      if (stripped.length > 0) {
        cleaned[key] = stripped;
      }
    }
    if (!hookChanged) {
      merged[name] = value;
      continue;
    }
    const remainder = Object.keys(cleaned).filter((key) => key !== "enabled");
    if (remainder.length > 0) {
      merged[name] = cleaned;
    }
  }
  merged[hookName] = currentHook;

  const after = readAntigravityHookRegistrations(merged, identifies);
  return {
    config: merged,
    changed,
    changes: changesBetween(before, after, events, false),
    conflicts: [],
  };
};

const eventNamesIn = (existing: unknown): readonly string[] => {
  if (!isPlainObject(existing)) {
    return [];
  }
  const names = new Set<string>();
  for (const hook of Object.values(existing)) {
    if (!isPlainObject(hook)) {
      continue;
    }
    for (const [key, value] of Object.entries(hook)) {
      if (key !== "enabled" && Array.isArray(value)) {
        names.add(key);
      }
    }
  }
  return [...names];
};

/**
 * Reverse {@link mergeAntigravityHookRegistration}.
 *
 * An event list that becomes empty is deleted. A named hook with no events
 * left is deleted too, unless the operator had set other keys on it, so an
 * uninstall restores a document that had no hooks before setup.
 */
export const removeAntigravityHookRegistration = (
  input: RemoveAntigravityHookRegistrationInput,
): MergeAntigravityHookRegistrationResult => {
  const conflicts = structuralConflicts(input.existing);
  if (conflicts.length > 0 || !isPlainObject(input.existing)) {
    return {
      config: isPlainObject(input.existing) ? input.existing : {},
      changed: false,
      changes: [],
      conflicts,
    };
  }

  const events = input.events ?? eventNamesIn(input.existing);
  const before = readAntigravityHookRegistrations(input.existing, input.identifies);
  let changed = false;
  const config: Record<string, unknown> = {};

  for (const [name, hook] of Object.entries(input.existing)) {
    if (!isPlainObject(hook)) {
      config[name] = hook;
      continue;
    }
    const nextHook: Record<string, unknown> = {};
    let hookChanged = false;
    for (const [key, value] of Object.entries(hook)) {
      if (!Array.isArray(value) || !events.includes(key)) {
        nextHook[key] = value;
        continue;
      }
      const stripped = stripManaged(value, input.identifies, isToolEvent(key));
      if (stripped.length !== value.length) {
        hookChanged = true;
        changed = true;
      }
      if (stripped.length > 0) {
        nextHook[key] = stripped;
      }
    }
    if (!hookChanged) {
      config[name] = hook;
      continue;
    }
    const leftoverKeys = Object.keys(nextHook).filter((key) => key !== "enabled");
    if (leftoverKeys.length === 0 && !hasOwn(hook, "enabled")) {
      continue;
    }
    if (leftoverKeys.length === 0 && Object.keys(nextHook).every((key) => key === "enabled")) {
      // `enabled` alone is the default switch, not a hook the operator authored
      // beside us. Dropping the group restores an empty document.
      const onlyEnabled = Object.keys(hook).every((key) => key === "enabled" || events.includes(key));
      if (onlyEnabled) {
        continue;
      }
    }
    config[name] = nextHook;
  }

  const after = readAntigravityHookRegistrations(config, input.identifies);
  return {
    config,
    changed,
    changes: changesBetween(before, after, events, true),
    conflicts: [],
  };
};
