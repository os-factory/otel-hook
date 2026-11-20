import { execFile } from "node:child_process";
import { devNull } from "node:os";
import path from "node:path";

import { z } from "zod";

import { unknownWorkspaceIdentity, type WorkspaceIdentity } from "../model/identity.js";
import type { PrivacyService } from "./service.js";
import {
  canonicalizeGitRemote,
  deriveWorkspaceIdentity,
  sanitizeGitRemoteUrl,
  type WorkspaceLabels,
} from "./workspace.js";

/**
 * How a repository fact is allowed to leave the process.
 *
 * `public-label` values are bounded names (owner, repository, branch).
 * `opaque-identity` values are salted hashes of a root or a remote, stable
 * enough to correlate the same repository and useless as a path or URL.
 * `sensitive-locator` values are absolute paths and remote URLs; they are
 * omitted unless the caller opts in, and even then credentials are already
 * gone. `secret` is userinfo, query tokens, and fragments: stripped before
 * hashing or disclosure, and never stored on the result.
 */
export const repositoryPrivacyClassSchema = z.enum([
  "public-label",
  "opaque-identity",
  "sensitive-locator",
  "secret",
]);
export type RepositoryPrivacyClass = z.infer<typeof repositoryPrivacyClassSchema>;

/**
 * Explicit classification of every repository fact this module can produce.
 *
 * The map is the contract: a new field is not exportable until it has an
 * entry here, and `credentials` has a class with no value slot so a secret
 * cannot be attached later by adding a property.
 */
export const REPOSITORY_FIELD_PRIVACY = Object.freeze({
  owner: "public-label",
  name: "public-label",
  branch: "public-label",
  rootIdentity: "opaque-identity",
  remoteIdentity: "opaque-identity",
  revisionIdentity: "opaque-identity",
  rootPath: "sensitive-locator",
  remoteUrl: "sensitive-locator",
  credentials: "secret",
} as const satisfies Record<string, RepositoryPrivacyClass>);

export type RepositoryField = keyof typeof REPOSITORY_FIELD_PRIVACY;

export type ClassifiedValue<C extends RepositoryPrivacyClass, T> = {
  readonly classification: C;
  readonly value: T;
};

export type ClassifiedRemote = {
  readonly name: string;
  /** Opaque identity of the credential-free remote. Same URL, same identity. */
  readonly identity: ClassifiedValue<"opaque-identity", string>;
  /** Present only when raw remotes were explicitly opted in, and never with userinfo. */
  readonly url?: ClassifiedValue<"sensitive-locator", string>;
};

export type RepositoryUnavailableReason = "missing-git" | "not-a-repository" | "failed";

export type RepositoryEnrichment = {
  readonly status: "enriched" | "unavailable";
  readonly reason?: RepositoryUnavailableReason;
  readonly classifications: typeof REPOSITORY_FIELD_PRIVACY;
  readonly detachedHead: boolean;
  readonly owner?: ClassifiedValue<"public-label", string>;
  readonly name?: ClassifiedValue<"public-label", string>;
  readonly branch?: ClassifiedValue<"public-label", string>;
  readonly rootIdentity?: ClassifiedValue<"opaque-identity", string>;
  readonly revision?: ClassifiedValue<"opaque-identity", string>;
  readonly remotes: readonly ClassifiedRemote[];
  /**
   * Remote whose URL keys {@link RepositoryEnrichment.workspace}. Set only
   * when that choice is unambiguous: the sole usable remote, or `origin`
   * when several exist. Several remotes and no `origin` leave this unset
   * and key the workspace from the git common directory instead.
   */
  readonly primaryRemoteName?: string;
  readonly workspace: WorkspaceIdentity;
  /** Absolute checkout path. Present only when raw paths were explicitly opted in. */
  readonly rootPath?: ClassifiedValue<"sensitive-locator", string>;
};

/**
 * A snapshot of one checkout. Implementations must not interpret privacy;
 * they only report what the version-control tool returned.
 */
export type RepositorySnapshot = {
  readonly toplevel: string;
  readonly commonDir: string;
  readonly branch: string | undefined;
  readonly detached: boolean;
  readonly revision: string | undefined;
  readonly remotes: readonly { readonly name: string; readonly url: string }[];
};

export type RepositoryInspection =
  | { readonly status: "ready"; readonly snapshot: RepositorySnapshot }
  | { readonly status: RepositoryUnavailableReason };

/**
 * Source of repository facts.
 *
 * Injected so a caller can supply repository facts without this module
 * shelling out, and so enrichment keeps no process-wide workspace cache.
 */
export type RepositoryInspector = {
  inspect(cwd: string): Promise<RepositoryInspection>;
};

export type RepositoryDisclosure = {
  /** Include the absolute checkout path. Default false. */
  readonly allowRawPaths?: boolean;
  /** Include credential-stripped remote URLs. Default false. */
  readonly allowRawRemotes?: boolean;
};

export type EnrichRepositoryOptions = {
  readonly inspector?: RepositoryInspector;
  readonly disclosure?: RepositoryDisclosure;
};

const MAX_REPOSITORY_REMOTES = 32;

/** Control characters and whitespace, without putting controls in a regex literal. */
const hasUnsafeWhitespace = (value: string): boolean => {
  if (/\s/.test(value)) {
    return true;
  }
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) {
      return true;
    }
  }
  return false;
};

const hasControlCharacter = (value: string): boolean => {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) {
      return true;
    }
  }
  return false;
};
const MAX_LABEL_LENGTH = 128;
const SAFE_NAME = /^[a-z0-9._-]{1,128}$/;
const SAFE_OWNER = /^[a-z0-9._-]{1,64}(?:\/[a-z0-9._-]{1,64}){0,4}$/;
const SAFE_BRANCH = /^[A-Za-z0-9._/-]{1,128}$/;
const SAFE_REMOTE_NAME = /^[A-Za-z0-9._/-]{1,64}$/;
const SAFE_REVISION = /^[0-9a-f]{7,64}$/;

const label = (value: string | undefined, pattern: RegExp): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (
    trimmed === "" ||
    trimmed.length > MAX_LABEL_LENGTH ||
    trimmed.includes("..") ||
    trimmed.startsWith("/") ||
    trimmed.includes("@") ||
    trimmed.includes(":") ||
    hasUnsafeWhitespace(trimmed) ||
    !pattern.test(trimmed)
  ) {
    return undefined;
  }
  return trimmed;
};

/**
 * Owner and name parsed from a canonical `host/owner/name` remote.
 *
 * The host is not an owner. A path-shaped canonical form (a local remote)
 * contributes neither, so a filesystem path cannot be published as a label.
 */
export const parseRepositoryOwnerName = (
  canonicalRemote: string,
): { readonly owner?: string; readonly name?: string } => {
  if (
    canonicalRemote === "" ||
    canonicalRemote.startsWith("/") ||
    canonicalRemote.includes("\\") ||
    canonicalRemote.includes("..")
  ) {
    return {};
  }
  const segments = canonicalRemote.split("/").filter((segment) => segment.length > 0);
  if (segments.length < 2) {
    return {};
  }
  const first = segments[0];
  if (first === undefined) {
    return {};
  }
  const hostLike = first.includes(".") || first === "localhost";
  const nameParts = hostLike ? segments.slice(1) : segments;
  if (nameParts.length < 2) {
    return {};
  }
  const name = label(nameParts[nameParts.length - 1], SAFE_NAME);
  const owner = label(nameParts.slice(0, -1).join("/"), SAFE_OWNER);
  if (name === undefined || owner === undefined) {
    return {};
  }
  return { owner, name };
};

const classified = <C extends RepositoryPrivacyClass, T>(
  classification: C,
  value: T,
): ClassifiedValue<C, T> => Object.freeze({ classification, value });

const normalizeAbsolute = (input: string, base: string): string | undefined => {
  const trimmed = input.trim();
  if (trimmed === "" || hasControlCharacter(trimmed)) {
    return undefined;
  }
  const absolute = path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(base, trimmed);
  const stripped = absolute.replace(/[/\\]+$/, "");
  return path.isAbsolute(stripped) ? stripped : undefined;
};

const unavailable = (reason: RepositoryUnavailableReason): RepositoryEnrichment =>
  Object.freeze({
    status: "unavailable",
    reason,
    classifications: REPOSITORY_FIELD_PRIVACY,
    detachedHead: false,
    remotes: Object.freeze([]),
    workspace: unknownWorkspaceIdentity(),
  });

type IdentifiedRemote = {
  readonly name: string;
  readonly canonical: string;
  readonly identity: string;
  readonly url?: string;
};

const identifyRemotes = (
  privacy: PrivacyService,
  remotes: readonly { readonly name: string; readonly url: string }[],
  allowRawRemotes: boolean,
): readonly IdentifiedRemote[] => {
  const identified: IdentifiedRemote[] = [];
  for (const remote of remotes) {
    if (identified.length >= MAX_REPOSITORY_REMOTES) {
      break;
    }
    const name = label(remote.name, SAFE_REMOTE_NAME);
    if (name === undefined || name.startsWith("-")) {
      continue;
    }
    const canonical = canonicalizeGitRemote(remote.url);
    if (canonical === "") {
      continue;
    }
    const url = allowRawRemotes ? sanitizeGitRemoteUrl(remote.url) : undefined;
    identified.push({
      name,
      canonical,
      identity: privacy.deriveOpaqueId("repository/remote", canonical),
      ...(url === undefined ? {} : { url }),
    });
  }
  return identified;
};

/**
 * Select the remote that may key workspace identity.
 *
 * One usable remote is explicit. `origin` among several is the remote's own
 * name, not a guess. Any other tie is refused: the workspace falls back to
 * the checkout's common directory so two repositories cannot be merged by
 * picking an arbitrary remote.
 */
const selectPrimaryRemote = (
  remotes: readonly IdentifiedRemote[],
): IdentifiedRemote | undefined => {
  if (remotes.length === 1) {
    return remotes[0];
  }
  return remotes.find((remote) => remote.name === "origin");
};

/**
 * Enrich a checkout with privacy-classified repository metadata.
 *
 * The function fails open: missing git, a directory that is not a repository,
 * and a throwing inspector all return an `unavailable` result with the unknown
 * workspace. It never throws, and it keeps no module-level identity.
 *
 * Workspace correlation uses the primary remote when that choice is
 * unambiguous, otherwise the absolute git common directory (shared by linked
 * worktrees, distinct per repository). Repository name alone is never the key,
 * so two checkouts that happen to share a folder name stay distinct.
 */
export const enrichRepositoryMetadata = async (
  privacy: PrivacyService,
  cwd: string,
  options: EnrichRepositoryOptions = {},
): Promise<RepositoryEnrichment> => {
  const allowRawPaths = options.disclosure?.allowRawPaths === true;
  const allowRawRemotes = options.disclosure?.allowRawRemotes === true;
  const inspector = options.inspector ?? createProcessRepositoryInspector();

  let inspection: RepositoryInspection;
  try {
    inspection = await inspector.inspect(cwd);
  } catch {
    return unavailable("failed");
  }

  if (inspection.status !== "ready") {
    return unavailable(inspection.status);
  }

  try {
    return classifySnapshot(privacy, cwd, inspection.snapshot, allowRawPaths, allowRawRemotes);
  } catch {
    return unavailable("failed");
  }
};

const classifySnapshot = (
  privacy: PrivacyService,
  cwd: string,
  snapshot: RepositorySnapshot,
  allowRawPaths: boolean,
  allowRawRemotes: boolean,
): RepositoryEnrichment => {
  const toplevel = normalizeAbsolute(snapshot.toplevel, cwd);
  const commonDir = normalizeAbsolute(snapshot.commonDir, toplevel ?? cwd);
  if (toplevel === undefined || commonDir === undefined) {
    return unavailable("failed");
  }

  const identified = identifyRemotes(privacy, snapshot.remotes, allowRawRemotes);
  const primary = selectPrimaryRemote(identified);
  const parsed = primary === undefined ? {} : parseRepositoryOwnerName(primary.canonical);
  const detached = snapshot.detached || snapshot.branch?.trim() === "HEAD";
  const branch = detached ? undefined : label(snapshot.branch, SAFE_BRANCH);
  const revision =
    snapshot.revision === undefined
      ? undefined
      : SAFE_REVISION.test(snapshot.revision.trim().toLowerCase())
        ? snapshot.revision.trim().toLowerCase()
        : undefined;

  const labels: WorkspaceLabels = {
    ...(parsed.name === undefined ? {} : { repositoryName: parsed.name }),
    ...(branch === undefined ? {} : { vcsBranchName: branch }),
    ...(revision === undefined ? {} : { vcsRevisionId: revision }),
  };
  const workspace =
    primary !== undefined
      ? deriveWorkspaceIdentity(privacy, { kind: "git-remote", remoteUrl: primary.canonical }, labels)
      : deriveWorkspaceIdentity(privacy, { kind: "git-root", absolutePath: commonDir }, labels);

  const remotes = Object.freeze(
    identified.map((remote) =>
      Object.freeze({
        name: remote.name,
        identity: classified("opaque-identity" as const, remote.identity),
        ...(remote.url === undefined
          ? {}
          : { url: classified("sensitive-locator" as const, remote.url) }),
      }),
    ),
  );

  return Object.freeze({
    status: "enriched" as const,
    classifications: REPOSITORY_FIELD_PRIVACY,
    detachedHead: detached,
    ...(parsed.owner === undefined
      ? {}
      : { owner: classified("public-label" as const, parsed.owner) }),
    ...(parsed.name === undefined
      ? {}
      : { name: classified("public-label" as const, parsed.name) }),
    ...(branch === undefined
      ? {}
      : { branch: classified("public-label" as const, branch) }),
    rootIdentity: classified("opaque-identity" as const, privacy.deriveOpaqueId("repository/root", commonDir)),
    ...(workspace.vcsRevisionId === undefined
      ? {}
      : { revision: classified("opaque-identity" as const, workspace.vcsRevisionId) }),
    remotes,
    ...(primary === undefined ? {} : { primaryRemoteName: primary.name }),
    workspace,
    ...(allowRawPaths ? { rootPath: classified("sensitive-locator" as const, toplevel) } : {}),
  });
};

type GitRun =
  | { readonly status: "ok"; readonly stdout: string }
  | { readonly status: RepositoryUnavailableReason };

export type ProcessRepositoryInspectorOptions = {
  /** Executable name or path. Defaults to `git` on `PATH`. */
  readonly command?: string;
};

const gitEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_SYSTEM: devNull,
    GIT_CONFIG_COUNT: "0",
    LC_ALL: "C",
  };
  if (process.env.PATH !== undefined) {
    env.PATH = process.env.PATH;
  }
  if (process.env.SystemRoot !== undefined) {
    env.SystemRoot = process.env.SystemRoot;
  }
  if (process.env.PATHEXT !== undefined) {
    env.PATHEXT = process.env.PATHEXT;
  }
  return env;
};

const runGit = (command: string, args: readonly string[], cwd: string): Promise<GitRun> =>
  new Promise((resolve) => {
    try {
      execFile(
        command,
        [...args],
        {
          cwd,
          timeout: 5_000,
          maxBuffer: 1_048_576,
          windowsHide: true,
          encoding: "utf8",
          env: gitEnv(),
        },
        (error, stdout, stderr) => {
          if (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "ENOENT") {
              resolve({ status: "missing-git" });
              return;
            }
            resolve({
              status: /not a git repository/i.test(stderr) ? "not-a-repository" : "failed",
            });
            return;
          }
          resolve({ status: "ok", stdout });
        },
      );
    } catch {
      resolve({ status: "failed" });
    }
  });

const firstLine = (stdout: string): string => stdout.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";

const readPath = async (
  command: string,
  cwd: string,
  flag: "--show-toplevel" | "--git-common-dir",
): Promise<GitRun> => {
  const absolute = await runGit(command, ["rev-parse", "--path-format=absolute", flag], cwd);
  if (absolute.status === "ok" || absolute.status === "missing-git" || absolute.status === "not-a-repository") {
    return absolute;
  }
  return runGit(command, ["rev-parse", flag], cwd);
};

/**
 * Repository inspector that shells out to git.
 *
 * The child environment does not inherit the parent config or credential
 * helpers. A missing binary, a non-repository, and a failing command become
 * statuses; they do not throw.
 */
export const createProcessRepositoryInspector = (
  options: ProcessRepositoryInspectorOptions = {},
): RepositoryInspector => {
  const command = options.command ?? "git";

  const inspect = async (cwd: string): Promise<RepositoryInspection> => {
    const toplevelRun = await readPath(command, cwd, "--show-toplevel");
    if (toplevelRun.status !== "ok") {
      return { status: toplevelRun.status };
    }
    const commonRun = await readPath(command, cwd, "--git-common-dir");
    if (commonRun.status !== "ok") {
      return { status: commonRun.status };
    }

    const branchRun = await runGit(command, ["rev-parse", "--abbrev-ref", "HEAD"], cwd);
    const branchLine = branchRun.status === "ok" ? firstLine(branchRun.stdout) : "";
    const detached = branchLine === "HEAD";
    const branch = detached || branchLine === "" ? undefined : branchLine;

    const revisionRun = await runGit(command, ["rev-parse", "HEAD"], cwd);
    const revisionLine = revisionRun.status === "ok" ? firstLine(revisionRun.stdout).toLowerCase() : "";
    const revision = SAFE_REVISION.test(revisionLine) ? revisionLine : undefined;

    const remoteRun = await runGit(command, ["remote"], cwd);
    const remoteNames =
      remoteRun.status === "ok"
        ? remoteRun.stdout
            .split(/\r?\n/)
            .map((name) => name.trim())
            .filter((name) => name.length > 0)
            .slice(0, MAX_REPOSITORY_REMOTES)
        : [];
    const remotes: { name: string; url: string }[] = [];
    for (const name of remoteNames) {
      if (name.startsWith("-") || !SAFE_REMOTE_NAME.test(name)) {
        continue;
      }
      const urlRun = await runGit(command, ["remote", "get-url", "--", name], cwd);
      if (urlRun.status !== "ok") {
        continue;
      }
      const url = firstLine(urlRun.stdout);
      if (url !== "") {
        remotes.push({ name, url });
      }
    }

    return {
      status: "ready",
      snapshot: {
        toplevel: firstLine(toplevelRun.stdout),
        commonDir: firstLine(commonRun.stdout),
        branch,
        detached,
        revision,
        remotes,
      },
    };
  };

  return { inspect };
};
