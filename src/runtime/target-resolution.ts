import * as path from "node:path";

import type { CanonicalEvent } from "../model/events.js";
import type { EventId } from "../model/primitives.js";
import { workspaceTargetSchema, type TargetHint, type WorkspaceTarget } from "../model/target.js";
import type { PrivacyService } from "../privacy/service.js";
import { deriveWorkspaceIdentity } from "../privacy/workspace.js";
import type { LocatedWorktree, WorktreeLocator } from "./ports.js";

/**
 * Turns adapters' target hints into exported worktree targets (ADR 0008).
 *
 * This is where local paths stop. A hint's paths are resolved to a worktree
 * root, branch, and repository through the injected {@link WorktreeLocator};
 * only salted `git-root` handles of the root and of its repository's main
 * worktree, the worktree's kind, and the branch name survive onto the event.
 *
 * Fail-open in both directions that matter: a slow or failing filesystem costs
 * the event its target, never the event — and never the host more than the
 * time budget. Fail-closed on meaning: a hint whose paths land in two different
 * worktrees, or that names a relative path with nothing to resolve it against,
 * yields no target rather than a guess.
 */

/** Default ceiling on target resolution per callback. */
export const DEFAULT_TARGET_RESOLUTION_BUDGET_MILLIS = 50;

const absolutePathsOf = (hint: TargetHint): readonly string[] | undefined => {
  const base =
    hint.baseDirectory !== undefined && path.isAbsolute(hint.baseDirectory)
      ? hint.baseDirectory
      : undefined;
  const resolved: string[] = [];
  for (const candidate of hint.paths) {
    if (path.isAbsolute(candidate)) {
      resolved.push(path.resolve(candidate));
    } else if (base !== undefined) {
      resolved.push(path.resolve(base, candidate));
    } else {
      return undefined;
    }
  }
  return resolved;
};

const resolveHint = async (
  hint: TargetHint,
  locator: WorktreeLocator,
  privacy: PrivacyService,
): Promise<WorkspaceTarget | undefined> => {
  const paths = absolutePathsOf(hint);
  if (paths === undefined) {
    return undefined;
  }
  const located: (LocatedWorktree | undefined)[] = await Promise.all(
    [...new Set(paths)].map((candidate) => locator.locate(candidate)),
  );
  const [first] = located;
  if (first === undefined || located.some((entry) => entry?.root !== first.root)) {
    return undefined;
  }
  const identity = deriveWorkspaceIdentity(
    privacy,
    { kind: "git-root", absolutePath: first.root },
    first.branch === undefined ? {} : { vcsBranchName: first.branch },
  );
  if (identity.keySource !== "git-root") {
    return undefined;
  }
  // The repository is named by its main worktree, as that worktree would name
  // itself — so a main worktree's repository id is its own workspace id.
  const repository =
    first.mainRoot === undefined
      ? undefined
      : deriveWorkspaceIdentity(privacy, { kind: "git-root", absolutePath: first.mainRoot });
  const parsed = workspaceTargetSchema.safeParse({
    workspaceId: identity.workspaceId,
    ...(identity.vcsBranchName === undefined ? {} : { vcsBranchName: identity.vcsBranchName }),
    source: hint.source,
    ...(repository?.keySource === "git-root" ? { repositoryId: repository.workspaceId } : {}),
    ...(first.kind === undefined ? {} : { worktreeKind: first.kind }),
  });
  return parsed.success ? parsed.data : undefined;
};

export type ResolveEventTargetsInput = {
  readonly events: readonly CanonicalEvent[];
  readonly hints: ReadonlyMap<EventId, TargetHint>;
  readonly locator: WorktreeLocator;
  readonly privacy: PrivacyService;
  readonly budgetMillis: number;
};

export type ResolveEventTargetsResult = {
  readonly events: readonly CanonicalEvent[];
  /** Hints that produced a target. */
  readonly resolved: number;
  /** True when the time budget expired before every hint was answered. */
  readonly timedOut: boolean;
};

/**
 * Attach a `target` to each tool event that has a resolvable hint. Never
 * throws or rejects; events without a hint, or whose hint does not resolve,
 * are returned unchanged.
 */
export const resolveEventTargets = async (
  input: ResolveEventTargetsInput,
): Promise<ResolveEventTargetsResult> => {
  const pending = input.events.filter(
    (event) =>
      (event.type === "tool.start" || event.type === "tool.end") && input.hints.has(event.eventId),
  );
  if (pending.length === 0) {
    return { events: input.events, resolved: 0, timedOut: false };
  }

  const targets = new Map<EventId, WorkspaceTarget>();
  const work = Promise.all(
    pending.map(async (event) => {
      const hint = input.hints.get(event.eventId);
      if (hint === undefined) {
        return;
      }
      try {
        const target = await resolveHint(hint, input.locator, input.privacy);
        if (target !== undefined) {
          targets.set(event.eventId, target);
        }
      } catch {
        // A locator that broke its no-throw contract costs this event its target.
      }
    }),
  ).then(() => "done" as const);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), Math.max(0, input.budgetMillis));
    timer.unref?.();
  });
  const finished = await Promise.race([work, deadline]);
  if (timer !== undefined) {
    clearTimeout(timer);
  }

  // Snapshot: a resolution landing after the deadline must not mutate a batch
  // that is already on its way out.
  const settled = new Map(targets);
  const events = input.events.map((event): CanonicalEvent => {
    const target = settled.get(event.eventId);
    if (target === undefined || (event.type !== "tool.start" && event.type !== "tool.end")) {
      return event;
    }
    return { ...event, target };
  });
  return { events, resolved: settled.size, timedOut: finished === "timeout" };
};
