# ADR 0008: The core resolves which git worktree a tool event targeted

- Status: accepted, amended 2026-11-14 ([repository and worktree kind](#amendment-repository-and-worktree-kind))
- Date: 2026-11-12
- Milestone: M3 (attribution evidence)

## Context

An invocation's `workspace` is the directory the agent session was started in.
Agents routinely work somewhere else: they start in a repository's main
checkout and then edit files in a linked git worktree beside it. A consumer
that wants to attribute work (and the LLM usage that paid for it) to the
worktree it happened in cannot see that switch, because every hook payload
keeps reporting the session's directory.

The evidence exists, per tool event: the file an edit named, the directory a
shell command ran in. Two rules stood in the way of using it:

- ADR 0003: adapters get no filesystem handle, and payload data may leave an
  adapter only as canonical values. Mapping a path to a worktree needs the
  filesystem.
- ADR 0005: identifiers are hashes, not paths. A file path must never reach an
  exporter.

## Decision

1. **Adapters observe, the core resolves.** An adapter attaches a `TargetHint`
   to a `tool.start`/`tool.end` draft: a source (`tool-path`, `shell-cwd`, or
   `session-cwd`, strongest first), one to eight local paths, and an optional
   base directory for relative ones. Each adapter emits the strongest single
   hint its payload supports; it never falls back past stronger evidence that
   failed to resolve.
2. **`TargetHint` is the one canonical value that carries a local path, and it
   is in-process only.** The event factory keeps hints in a side table keyed by
   event id; they reach the core through `ProviderParseResult.targetHints` and
   are never part of a `CanonicalEvent`, never written to state, the spool, or
   a log, and never exported. The factory strips any `target` a draft tries to
   set itself.
3. **Resolution is a port.** `WorktreeLocator.locate(absolutePath)` returns the
   worktree root and branch, or `undefined`. The filesystem implementation
   (`createFilesystemWorktreeLocator`) walks up to the nearest `.git` — a
   directory is a main worktree, a file is a linked worktree whose `gitdir:` it
   follows — and reads `HEAD`. It never spawns `git`, bounds walk depth and
   bytes read, caches per instance with a short TTL, and answers `undefined` to
   anything broken rather than skipping to an enclosing repository. It is wired
   by `createHookRuntime` (the CLI); `createOtelHook` and the test harness have
   none unless injected, so the library stays filesystem-free by default.
4. **The core exports only a salted handle and a branch.** `resolveEventTargets`
   runs after the session lock is released and before export, under a time
   budget (50 ms by default). A hint resolves to a `WorkspaceTarget` —
   `workspaceId` derived exactly like a `git-root` workspace identity, the
   branch name (the same label `WorkspaceIdentity.vcsBranchName` already
   allows), and the source — only when every path lands in the same worktree.
   Disagreement, a relative path with no base, a timeout, or any failure leaves
   the event without a target. The event is never dropped or delayed past the
   budget.
5. **Export.** A tool span carries `otelhook.target.workspace.id`,
   `otelhook.target.source`, and `vcs.ref.head.name`, chosen as one unit from
   the strongest of the recovered start, live start, and live end edges (a tie
   goes to the later edge). The start edge's target is persisted with its other
   start-only attributes, so a cross-process end still carries it. Tool log
   records carry the same attributes.
6. **Subagent identity rides on events, not identity.** The factory stamps a
   provider-reported subagent id (`subagentId`) on every event an adapter builds
   for a subagent, exported as `otelhook.subagent.id`. It is the same class of
   value as the session id already exported — a provider-minted opaque
   identifier — so it is exported verbatim, but only when it is
   identifier-shaped; anything else is dropped.

## Consequences

- A consumer can tell, per tool event, which worktree was touched and how
  strong the evidence is, without receiving a path. Matching a target to its own
  notion of a worktree requires the same hash salt, or the branch name.
- Session-level workspace identity is unchanged: a session started in the main
  checkout still reports that checkout.
- The hook now performs a few small reads per tool event when wired through the
  runtime. That cost is bounded by the budget and the cache.
- Evidence is only as good as the provider's payload. Claude Code reports no
  working directory for `Bash`; Codex (0.163.0) forwards no `workdir`; Cursor
  reports a shell `cwd` only on `beforeShellExecution`, which is not registered
  by default. Those calls get `session-cwd` or nothing.
- Branch names are exported. They were already an allowed label; operators who
  consider branch names sensitive should not wire a locator.

## Amendment: repository and worktree kind

- Date: 2026-11-14

### Context

`otelhook.target.workspace.id` names the worktree a tool event touched, but not
the repository that worktree belongs to. A consumer that attributes work to a
repository had to map a linked worktree back to it by reading `.git` itself —
impossible for a consumer that is not on the machine (a collector, a container),
and a second, divergent reading of git's layout where it is possible. The
locator already follows a linked worktree's `gitdir:` file, one read away from
the answer.

### Decision

1. **The locator reports the worktree's kind and its repository's main
   worktree.** `LocatedWorktree` gains `kind` (`main` | `linked`) and `mainRoot`,
   read the way git reads them, without spawning `git`:
   - A `.git` directory is a main worktree; `mainRoot` is its own root.
   - A `.git` file whose git dir holds a `commondir` file is a linked worktree.
     `commondir` names the common git dir; when that is an existing directory
     named `.git`, its parent is `mainRoot` — the path `git worktree list`
     prints first. A common dir with any other name (a bare repository, a
     `--separate-git-dir` repository, a submodule's `.git/modules/<name>`) or
     one that no longer exists yields no `mainRoot`; the kind is still `linked`.
     An unreadable `commondir` is not a missing one: still `linked`, no
     `mainRoot`.
   - A `.git` file whose git dir has no `commondir` is a main worktree. That
     covers a submodule (`gitdir: <super>/.git/modules/<name>`): a submodule is
     its own repository, never a linked worktree of its superproject.
   - Nested repositories are unchanged: the innermost `.git` wins.

   The extra reads are one bounded `commondir` read (plus one `stat`) per `.git`
   file, inside the cached probe; a `.git` directory costs nothing more.
2. **The repository is named the way its main worktree names itself.**
   `WorkspaceTarget` gains `repositoryId` — the main worktree root through the
   same `git-root` derivation as `workspaceId` — and `worktreeKind`. A main
   worktree's `repositoryId` therefore equals its `workspaceId`, every linked
   worktree of the repository carries that same value, and a consumer that
   hashes a repository path it knows with the same salt gets the same id.
3. **Export.** Tool spans and tool log records carry
   `otelhook.target.repository.id` and `otelhook.target.worktree.kind` beside
   the existing target attributes, chosen with them as one unit (decision 5), and
   persisted with them across processes. Either is omitted when not known; a
   failure to read the repository costs only these attributes, never the target
   or the event, and stays inside the existing time budget.
4. **Session-level workspace identity is not extended.** Adapters derive it from
   the payload's directory as a `working-directory` key, with no filesystem
   handle (ADR 0003), so it is never a `git-root` identity to extend. A tool
   event's `session-cwd` target already reports the session directory's
   repository and kind.

### Consequences

- A consumer maps any worktree to its repository from exported attributes alone,
  with no filesystem access and no list of worktrees pushed from elsewhere.
- Paths are hashed as spelled. git records a linked worktree's common dir as a
  resolved path, so a main checkout reached through a symlink has a
  `workspaceId` that differs from the `repositoryId` its linked worktrees carry.
- A worktree of a bare repository, or of a repository whose `.git` lives
  elsewhere, has a kind but no repository id: there is no main worktree to name,
  and the alternative — hashing the git dir — would be an id nothing else
  derives.
- No new path leaves the process: `mainRoot` is a `LocatedWorktree` field, as
  `root` is, and only its salted handle is exported.

## Alternatives considered

- **Give adapters a filesystem handle.** Rejected: it reopens ADR 0003's
  transcript-scanning door for every adapter.
- **Put paths on the canonical event and hash them in the sink.** Rejected: the
  event is persisted, spooled, and handed to custom sinks; a path on it is a
  path on disk and on the wire the first time a sink forgets to hash.
- **Run `git rev-parse`.** Rejected: a process spawn per tool event, an
  unbounded wait on a large repository, and a dependency on `git` being on the
  hook's `PATH`.
- **Fall back to weaker evidence when the strong one does not resolve.**
  Rejected: an edit of a file outside any repository did not target the
  session's directory, and saying so with `session-cwd` would be a guess.
