import { readFile } from "node:fs/promises";
import * as path from "node:path";

import { CODEX_PROVIDER_ID } from "../providers/codex/version.js";
import { readCodexHooksFeatureFlag } from "../providers/codex/registration.js";
import type { HookDocumentChange, HookDocumentConflict } from "../providers/hook-document.js";
import type { Clock } from "../runtime/ports.js";
import {
  DEFAULT_DOCUMENT_FORMAT,
  readJsonDocument,
  renderJsonDocument,
  writeDocumentAtomically,
  type JsonDocumentFormat,
} from "./document.js";
import { withFileLock, type FileLockOptions } from "./file-lock.js";
import {
  checkManagedMarker,
  DEFAULT_MANAGED_COMMAND_MARKER,
  findRegistrationPlanner,
  MANAGED_MARKER_REJECTION_DETAIL,
  managedHookPredicate,
} from "./planners.js";
import {
  findInstallLocation,
  PROVIDERS_WITHOUT_VERIFIED_LOCATION,
  resolveInstallPath,
  type RegistrationScope,
  type ScopeRoots,
} from "./scopes.js";
import { findRegistrationSupport } from "./support.js";

/**
 * `setup`, `diagnose`, and `uninstall` over a provider's configuration file.
 *
 * The three commands are one function because they are one algorithm with three
 * endings: resolve where the document lives, take the lock, read it, ask the
 * provider's pure planner what the document should become, and then either
 * report the plan (`diagnose`, `--dry-run`) or write it atomically. Sharing the
 * path means a dry run cannot drift from what a real run would do — it is
 * literally the same plan, printed instead of written.
 *
 * Refusals are deliberate and specific. A document that does not parse, or whose
 * `hooks` value is not the documented shape, is reported and left exactly as it
 * is: overwriting a developer's configuration to make an installer succeed is a
 * worse outcome than the installer failing.
 */

export type RegistrationAction = "setup" | "diagnose" | "uninstall";

export type RegistrationOutcomeStatus =
  /** A change is required and this is a dry run. */
  | "planned"
  /** A change was required and has been written. */
  | "applied"
  /** The document already says exactly what it should. */
  | "unchanged"
  /** Nothing of ours is registered here (diagnose and uninstall). */
  | "absent"
  /** We refuse to touch this document; see `problems`. */
  | "blocked"
  /** This repository cannot plan a registration for this provider. */
  | "unsupported"
  /** The filesystem operation itself failed. */
  | "failed";

export type RegistrationOutcome = {
  readonly providerId: string;
  readonly scope: RegistrationScope;
  readonly configPath?: string;
  /** What established the path and document shape. */
  readonly evidence?: string;
  readonly status: RegistrationOutcomeStatus;
  readonly changed: boolean;
  readonly changes: readonly HookDocumentChange[];
  readonly conflicts: readonly HookDocumentConflict[];
  /** Events with a registration of ours right now. */
  readonly registeredEvents: readonly string[];
  /** Events that should be registered but are not. */
  readonly missingEvents: readonly string[];
  /** Informational; never a reason to exit non-zero. */
  readonly notes: readonly string[];
  /** Anything an operator must act on. Non-empty means the run is not `ok`. */
  readonly problems: readonly string[];
  /** Exact bytes a non-dry run would write. Present only when a change is planned. */
  readonly plannedContents?: string;
};

export type RegistrationReport = {
  readonly action: RegistrationAction;
  readonly dryRun: boolean;
  readonly ok: boolean;
  readonly hookCommand: string;
  readonly outcomes: readonly RegistrationOutcome[];
};

export type RegistrationLifecycleRequest = {
  readonly action: RegistrationAction;
  readonly providerIds: readonly string[];
  readonly scopes: readonly RegistrationScope[];
  readonly roots: ScopeRoots;
  /** Overrides the resolved location. Required for a provider with no verified path. */
  readonly configFile?: string;
  /** Defaults to {@link defaultHookCommand} for each provider. */
  readonly command?: string;
  readonly events?: readonly string[];
  readonly matcher?: string;
  readonly timeoutSeconds?: number;
  readonly managedMarker?: string;
  readonly dryRun: boolean;
  readonly clock: Clock;
  readonly lock?: Omit<FileLockOptions, "clock">;
};

/** What this tool registers when the caller names no command. */
export const defaultHookCommand = (providerId: string): string =>
  `otel-hook run --provider ${providerId}`;

const unsupportedOutcome = (
  providerId: string,
  scope: RegistrationScope,
  reason: string,
): RegistrationOutcome => ({
  providerId,
  scope,
  status: "unsupported",
  changed: false,
  changes: [],
  conflicts: [],
  registeredEvents: [],
  missingEvents: [],
  notes: [],
  problems: [reason],
});

type ResolvedTarget = {
  readonly configPath: string;
  readonly evidence: string;
};

const resolveTarget = (
  providerId: string,
  scope: RegistrationScope,
  request: RegistrationLifecycleRequest,
): ResolvedTarget | { readonly reason: string } => {
  if (request.configFile !== undefined) {
    return {
      configPath: path.resolve(request.configFile),
      evidence: "path supplied by the caller with --settings-file",
    };
  }
  const location = findInstallLocation(providerId, scope);
  if (location !== undefined) {
    return {
      configPath: resolveInstallPath(location, request.roots),
      evidence: location.evidence,
    };
  }
  const blocker = PROVIDERS_WITHOUT_VERIFIED_LOCATION[providerId];
  return {
    reason:
      blocker === undefined
        ? `no ${scope} configuration path is known for provider "${providerId}"`
        : `${blocker}; pass --settings-file to register into a path you have verified yourself`,
  };
};

/**
 * Codex documents hooks as on by default, so setup never edits `config.toml`.
 * An explicit opt-out is still worth reporting: the registration would be
 * written correctly and simply never fire.
 */
const codexFeatureNote = async (configPath: string): Promise<string | undefined> => {
  const tomlPath = path.join(path.dirname(configPath), "config.toml");
  let raw: string;
  try {
    raw = await readFile(tomlPath, "utf8");
  } catch {
    return undefined;
  }
  return readCodexHooksFeatureFlag(raw) === "disabled"
    ? `${path.basename(tomlPath)} sets [features] hooks = false; registered hooks will not fire until that is removed`
    : undefined;
};

type DocumentState = {
  readonly existing: unknown;
  readonly format: JsonDocumentFormat;
  readonly existed: boolean;
};

const readState = async (
  configPath: string,
): Promise<DocumentState | { readonly problem: string; readonly status: RegistrationOutcomeStatus }> => {
  const read = await readJsonDocument(configPath);
  switch (read.status) {
    case "absent":
      return { existing: undefined, format: read.format, existed: false };
    case "ok":
      return { existing: read.value, format: read.format, existed: true };
    case "unparseable":
      return {
        status: "blocked",
        problem: `${path.basename(configPath)} is not well-formed JSON (${read.detail}); it was left untouched`,
      };
    case "unreadable":
      return {
        status: "failed",
        problem: `${path.basename(configPath)} could not be read (${read.detail})`,
      };
  }
};

const duplicateProblems = (
  registrations: ReadonlyMap<string, readonly string[]>,
): readonly string[] => {
  const duplicated = [...registrations.entries()]
    .filter(([, commands]) => commands.length > 1)
    .map(([event]) => event);
  return duplicated.length === 0
    ? []
    : [
        `${String(duplicated.length)} event(s) carry more than one registration of this hook ` +
          `(${duplicated.join(", ")}), which would duplicate every span; re-run setup to collapse them`,
      ];
};

const staleCommandNotes = (
  registrations: ReadonlyMap<string, readonly string[]>,
  command: string,
): readonly string[] => {
  const stale = new Set<string>();
  for (const commands of registrations.values()) {
    for (const found of commands) {
      if (found !== command) {
        stale.add(found);
      }
    }
  }
  return [...stale]
    .sort()
    .map(
      (found) =>
        `registered command "${found}" differs from "${command}"; re-run setup to rewrite it in place`,
    );
};

const runOneTarget = async (
  providerId: string,
  scope: RegistrationScope,
  request: RegistrationLifecycleRequest,
  command: string,
): Promise<RegistrationOutcome> => {
  const support = findRegistrationSupport(providerId);
  const planner = findRegistrationPlanner(providerId);
  if (planner === undefined || support?.supported !== true) {
    return unsupportedOutcome(
      providerId,
      scope,
      support?.reason ?? `no registration planner is available for provider "${providerId}"`,
    );
  }

  const target = resolveTarget(providerId, scope, request);
  if ("reason" in target) {
    return unsupportedOutcome(providerId, scope, target.reason);
  }
  const { configPath, evidence } = target;

  const identifies = managedHookPredicate(
    request.managedMarker ?? DEFAULT_MANAGED_COMMAND_MARKER,
  );
  const events = request.events ?? planner.defaultEvents;
  const notes: string[] = [];
  if (providerId === CODEX_PROVIDER_ID) {
    const note = await codexFeatureNote(configPath);
    if (note !== undefined) {
      notes.push(note);
    }
  }

  const base = {
    providerId,
    scope,
    configPath,
    evidence,
    changes: [] as readonly HookDocumentChange[],
    conflicts: [] as readonly HookDocumentConflict[],
  };

  const work = async (): Promise<RegistrationOutcome> => {
    const state = await readState(configPath);
    if ("problem" in state) {
      return {
        ...base,
        status: state.status,
        changed: false,
        registeredEvents: [],
        missingEvents: [],
        notes,
        problems: [state.problem],
      };
    }

    const registrations = planner.read(state.existing, identifies);
    const registeredEvents = [...registrations.keys()].sort();

    if (request.action === "diagnose") {
      const missingEvents = events.filter((event) => !registrations.has(event));
      const problems = [...duplicateProblems(registrations)];
      if (registeredEvents.length > 0 && missingEvents.length > 0) {
        problems.push(
          `registered for ${String(registeredEvents.length)} event(s) but missing ` +
            `${String(missingEvents.length)} (${missingEvents.join(", ")}); re-run setup`,
        );
      }
      return {
        ...base,
        status: registeredEvents.length === 0 ? "absent" : "unchanged",
        changed: false,
        registeredEvents,
        missingEvents,
        notes: [...notes, ...staleCommandNotes(registrations, command)],
        problems,
      };
    }

    const planned =
      request.action === "setup"
        ? planner.merge({
            ...(state.existing === undefined ? {} : { existing: state.existing }),
            command,
            events,
            ...(request.matcher === undefined ? {} : { matcher: request.matcher }),
            ...(request.timeoutSeconds === undefined
              ? {}
              : { timeoutSeconds: request.timeoutSeconds }),
            identifies,
          })
        : planner.remove({
            ...(state.existing === undefined ? {} : { existing: state.existing }),
            ...(request.events === undefined ? {} : { events: request.events }),
            identifies,
          });

    if (planned.conflicts.length > 0) {
      return {
        ...base,
        status: "blocked",
        changed: false,
        conflicts: planned.conflicts,
        registeredEvents,
        missingEvents: [],
        notes,
        problems: planned.conflicts.map(
          (conflict) =>
            `${path.basename(configPath)} has an unexpected shape at ${conflict.location}: ${conflict.detail}; it was left untouched`,
        ),
      };
    }

    if (request.action === "uninstall" && !state.existed) {
      return {
        ...base,
        status: "absent",
        changed: false,
        registeredEvents: [],
        missingEvents: [],
        notes: [...notes, `${path.basename(configPath)} does not exist; nothing to remove`],
        problems: [],
      };
    }

    if (!planned.changed) {
      return {
        ...base,
        status: request.action === "uninstall" && registeredEvents.length === 0 ? "absent" : "unchanged",
        changed: false,
        changes: planned.changes,
        registeredEvents,
        missingEvents: [],
        notes,
        problems: [],
      };
    }

    const format = state.existed ? state.format : DEFAULT_DOCUMENT_FORMAT;
    const contents = renderJsonDocument(planned.document, format);

    if (request.dryRun) {
      return {
        ...base,
        status: "planned",
        changed: true,
        changes: planned.changes,
        registeredEvents,
        missingEvents: [],
        notes,
        problems: [],
        plannedContents: contents,
      };
    }

    try {
      await writeDocumentAtomically(configPath, contents);
    } catch (thrown) {
      return {
        ...base,
        status: "failed",
        changed: false,
        changes: planned.changes,
        registeredEvents,
        missingEvents: [],
        notes,
        problems: [
          `could not write ${path.basename(configPath)} (${
            thrown instanceof Error ? thrown.name : typeof thrown
          })`,
        ],
      };
    }

    return {
      ...base,
      status: "applied",
      changed: true,
      changes: planned.changes,
      registeredEvents,
      missingEvents: [],
      notes,
      problems: [],
    };
  };

  // Only a run that will actually write takes the lock. The lock guards the
  // read-merge-write *sequence*; a reader never needs it, because every write
  // lands through an atomic rename and so is never observed half-applied. It
  // also matters that `diagnose` and `--dry-run` take no lock: creating the
  // lock file would mean creating `~/.claude/` to hold it, and a read-only
  // command that leaves directories behind in a home directory is a bug.
  const mutating = request.action !== "diagnose" && !request.dryRun;
  try {
    return mutating
      ? await withFileLock(configPath, { ...request.lock, clock: request.clock }, work)
      : await work();
  } catch (thrown) {
    return {
      ...base,
      status: "failed",
      changed: false,
      registeredEvents: [],
      missingEvents: [],
      notes,
      problems: [
        thrown instanceof Error
          ? `${path.basename(configPath)}: ${thrown.message}`
          : `${path.basename(configPath)}: the configuration file could not be locked`,
      ],
    };
  }
};

/**
 * Run one lifecycle action across every requested provider and scope.
 *
 * Targets are processed sequentially rather than concurrently: they are few, and
 * a serial run makes the output order deterministic and keeps two targets that
 * resolve to the same file (a `--settings-file` naming a shared document) from
 * contending for the same lock.
 */
export const runRegistrationLifecycle = async (
  request: RegistrationLifecycleRequest,
): Promise<RegistrationReport> => {
  // Checked once, before any target is resolved and before any document is
  // opened. The marker decides what `uninstall` deletes, so an unsafe one is
  // refused for every target rather than per target — a partial run that
  // mangled the first provider's file and then refused the second would be the
  // worst of both outcomes.
  const markerRejection = checkManagedMarker(
    request.managedMarker ?? DEFAULT_MANAGED_COMMAND_MARKER,
  );
  if (markerRejection !== undefined) {
    const reason = `refusing to run ${request.action}: ${MANAGED_MARKER_REJECTION_DETAIL[markerRejection]}`;
    return {
      action: request.action,
      dryRun: request.dryRun,
      ok: false,
      hookCommand: request.command ?? defaultHookCommand("<provider>"),
      outcomes: request.providerIds.flatMap((providerId) =>
        request.scopes.map((scope) => ({
          ...unsupportedOutcome(providerId, scope, reason),
          status: "blocked" as const,
        })),
      ),
    };
  }

  const outcomes: RegistrationOutcome[] = [];
  for (const providerId of request.providerIds) {
    const command = request.command ?? defaultHookCommand(providerId);
    for (const scope of request.scopes) {
      outcomes.push(await runOneTarget(providerId, scope, request, command));
    }
  }

  return {
    action: request.action,
    dryRun: request.dryRun,
    ok: outcomes.every((outcome) => outcome.problems.length === 0),
    hookCommand: request.command ?? defaultHookCommand("<provider>"),
    outcomes,
  };
};
