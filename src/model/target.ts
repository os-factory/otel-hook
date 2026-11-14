import { z } from "zod";

import { nonEmptyStringSchema, workspaceIdSchema } from "./primitives.js";

/**
 * Per-event workspace targeting (ADR 0008).
 *
 * A session's `workspace` is where the agent was *started*. An agent routinely
 * works somewhere else — in a linked git worktree beside the checkout it was
 * launched from — and the session-level identity cannot show that. A tool event
 * can: the file it edited, or the directory its shell command ran in, names the
 * worktree it actually touched.
 *
 * Two values model that, and the split between them is the privacy boundary:
 *
 * - {@link TargetHint} is what an adapter observed — local paths. It is an
 *   in-process value only: it is never part of a {@link CanonicalEvent}, never
 *   persisted, never exported. The core resolves it and drops it.
 * - {@link WorkspaceTarget} is what the core resolved — salted handles of the
 *   worktree and its repository, the worktree's kind, the checked-out branch, and
 *   what the evidence was. It travels on the event.
 */

/**
 * What a target was derived from, strongest evidence first.
 *
 * - `tool-path` — a path the tool call itself named (an edited or read file, a
 *   patch header).
 * - `shell-cwd` — the working directory the provider reports a shell command ran in.
 * - `session-cwd` — only the session's own directory was known; the event may
 *   have reached elsewhere (e.g. a shell `cd`) without the provider saying so.
 */
export const targetSourceSchema = z.enum(["tool-path", "shell-cwd", "session-cwd"]);
export type TargetSource = z.infer<typeof targetSourceSchema>;

/** Most paths one hint may name; a bound, not a sampling rule (all must agree). */
export const MAX_TARGET_HINT_PATHS = 8;

/** Longest local path a hint may carry. Longer input is dropped, never truncated. */
export const MAX_TARGET_PATH_LENGTH = 4096;

const localPathSchema = z
  .string()
  .min(1)
  .max(MAX_TARGET_PATH_LENGTH)
  .refine((value) => !value.includes("\u0000"), "path must not contain NUL");

/**
 * An adapter's observation of where a tool event pointed. **Carries local paths**
 * — in-process only, see the module note.
 *
 * Every path in one hint must resolve to the same worktree, or the event gets no
 * target at all: a patch touching two worktrees did not target either of them.
 */
export const targetHintSchema = z
  .strictObject({
    source: targetSourceSchema,
    paths: z.array(localPathSchema).min(1).max(MAX_TARGET_HINT_PATHS).readonly(),
    /** Absolute directory that relative `paths` resolve against. */
    baseDirectory: localPathSchema.optional(),
  })
  .readonly();
export type TargetHint = z.infer<typeof targetHintSchema>;

/**
 * Whether a worktree is its repository's main checkout (`main`) or one added
 * beside it with `git worktree add` (`linked`).
 */
export const worktreeKindSchema = z.enum(["main", "linked"]);
export type WorktreeKind = z.infer<typeof worktreeKindSchema>;

/**
 * The git worktree a tool event targeted. Exported; carries no path.
 *
 * `workspaceId` is derived exactly like a `git-root` workspace identity, so a
 * consumer holding the same salt can match it against one it derived itself.
 * `repositoryId` is the same derivation applied to the repository's main
 * worktree, so every worktree of one repository shares it — and for a main
 * worktree it equals `workspaceId`.
 */
export const workspaceTargetSchema = z
  .strictObject({
    workspaceId: workspaceIdSchema,
    /** Branch checked out in that worktree; absent on a detached HEAD. */
    vcsBranchName: nonEmptyStringSchema.optional(),
    source: targetSourceSchema,
    /** `git-root` handle of the repository's main worktree; absent when there is none to name. */
    repositoryId: workspaceIdSchema.optional(),
    worktreeKind: worktreeKindSchema.optional(),
  })
  .readonly();
export type WorkspaceTarget = z.infer<typeof workspaceTargetSchema>;

/**
 * Shape a provider's own subagent identifier must have to be exported.
 *
 * Identifier-shaped on purpose — no whitespace, no path separators — so a
 * malformed payload field cannot carry prose or a path onto the wire under an id
 * attribute. A value that does not fit is dropped, not repaired.
 */
export const SUBAGENT_ID_PATTERN = /^[A-Za-z0-9_.:@+=-]{1,256}$/;
export const subagentIdSchema = z.string().regex(SUBAGENT_ID_PATTERN);
export type SubagentId = z.infer<typeof subagentIdSchema>;
