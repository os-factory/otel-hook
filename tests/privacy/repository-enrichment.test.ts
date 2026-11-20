import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createProcessRepositoryInspector,
  deriveWorkspaceIdentity,
  enrichRepositoryMetadata,
  parseRepositoryOwnerName,
  REPOSITORY_FIELD_PRIVACY,
  sanitizeGitRemoteUrl,
  type RepositoryInspector,
  type RepositorySnapshot,
} from "../../src/index.js";
import { createTestPrivacyService } from "../../src/testing/index.js";

const SECRET = "s3cret-pass";
const TOKEN = "sekret-token";
const CREDENTIALED_ORIGIN =
  `https://user:${SECRET}@github.com/example-org/widget.git?access_token=${TOKEN}#frag`;
const CLEAN_ORIGIN = "https://github.com/example-org/widget.git";

const privacy = createTestPrivacyService();

const gitEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: devNull,
  GIT_AUTHOR_NAME: "Example",
  GIT_AUTHOR_EMAIL: "dev@example.com",
  GIT_COMMITTER_NAME: "Example",
  GIT_COMMITTER_EMAIL: "dev@example.com",
};

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const scratch = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), "otel-hook-synthetic-repo-"));
  roots.push(root);
  return root;
};

const git = (cwd: string, args: readonly string[]): string =>
  execFileSync("git", args, {
    cwd,
    env: gitEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

const initRepo = (dir: string): void => {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-b", "main"]);
  git(dir, ["commit", "--allow-empty", "-m", "init"]);
};

const commonDirOf = (cwd: string): string =>
  path.normalize(git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim());

const headOf = (cwd: string): string => git(cwd, ["rev-parse", "HEAD"]).trim().toLowerCase();

const snapshot = (overrides: Partial<RepositorySnapshot> = {}): RepositorySnapshot => ({
  toplevel: "/synthetic/checkout",
  commonDir: "/synthetic/checkout/.git",
  branch: "main",
  detached: false,
  revision: "0123456789abcdef0123456789abcdef01234567",
  remotes: [],
  ...overrides,
});

const inspectorFor = (body: RepositorySnapshot): RepositoryInspector => ({
  inspect: () => Promise.resolve({ status: "ready", snapshot: body }),
});

const assertNoLeak = (value: unknown, needles: readonly string[]): void => {
  const serialized = JSON.stringify(value);
  for (const needle of needles) {
    expect(serialized, needle).not.toContain(needle);
  }
};

describe("repository URL canonicalization", () => {
  it("classifies owner, name, branch, and both identities explicitly", () => {
    expect(REPOSITORY_FIELD_PRIVACY).toEqual({
      owner: "public-label",
      name: "public-label",
      branch: "public-label",
      rootIdentity: "opaque-identity",
      remoteIdentity: "opaque-identity",
      revisionIdentity: "opaque-identity",
      rootPath: "sensitive-locator",
      remoteUrl: "sensitive-locator",
      credentials: "secret",
    });
    expect(Object.isFrozen(REPOSITORY_FIELD_PRIVACY)).toBe(true);
  });

  it("parses owner and name from a canonical remote and refuses paths", () => {
    expect(parseRepositoryOwnerName("github.com/example-org/widget")).toEqual({
      owner: "example-org",
      name: "widget",
    });
    expect(parseRepositoryOwnerName("gitlab.com/group/sub/widget")).toEqual({
      owner: "group/sub",
      name: "widget",
    });
    expect(parseRepositoryOwnerName("/tmp/synthetic/widget")).toEqual({});
    expect(parseRepositoryOwnerName("github.com/widget")).toEqual({});
  });

  it("discloses a credential-free URL and nothing when stripping fails", () => {
    expect(sanitizeGitRemoteUrl(CREDENTIALED_ORIGIN)).toBe("https://github.com/example-org/widget");
    expect(sanitizeGitRemoteUrl("git@github.com:example-org/widget.git")).toBe(
      "ssh://github.com/example-org/widget",
    );
    expect(sanitizeGitRemoteUrl("https://user:s3cret-pass@")).toBeUndefined();
    expect(sanitizeGitRemoteUrl("file:///tmp/synthetic/widget")).toBeUndefined();
    expect(sanitizeGitRemoteUrl("http://[::1")).toBeUndefined();
  });
});

describe("enrichRepositoryMetadata", () => {
  it("strips credentials before hashing and omits raw paths and remotes by default", async () => {
    const root = scratch();
    const checkout = path.join(root, "widget");
    initRepo(checkout);
    git(checkout, ["remote", "add", "origin", CREDENTIALED_ORIGIN]);

    const enrichment = await enrichRepositoryMetadata(privacy, checkout);
    const clean = deriveWorkspaceIdentity(privacy, { kind: "git-remote", remoteUrl: CLEAN_ORIGIN });

    expect(enrichment.status).toBe("enriched");
    expect(enrichment.owner).toEqual({ classification: "public-label", value: "example-org" });
    expect(enrichment.name).toEqual({ classification: "public-label", value: "widget" });
    expect(enrichment.branch).toEqual({ classification: "public-label", value: "main" });
    expect(enrichment.rootIdentity?.classification).toBe("opaque-identity");
    expect(enrichment.rootIdentity?.value).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(enrichment.remotes).toHaveLength(1);
    expect(enrichment.remotes[0]?.identity).toEqual({
      classification: "opaque-identity",
      value: privacy.deriveOpaqueId("repository/remote", "github.com/example-org/widget"),
    });
    expect(enrichment.remotes[0]).not.toHaveProperty("url");
    expect(enrichment.primaryRemoteName).toBe("origin");
    expect(enrichment.workspace.workspaceId).toBe(clean.workspaceId);
    expect(enrichment.workspace.keySource).toBe("git-remote");
    expect(enrichment.workspace.repositoryName).toBe("widget");
    expect(enrichment.workspace.vcsBranchName).toBe("main");
    expect(enrichment.revision?.classification).toBe("opaque-identity");
    expect(enrichment.revision?.value).toBe(enrichment.workspace.vcsRevisionId);
    expect(enrichment).not.toHaveProperty("rootPath");
    expect(enrichment).not.toHaveProperty("credentials");
    assertNoLeak(enrichment, [SECRET, TOKEN, "access_token", root, headOf(checkout), "user:"]);
  });

  it("includes a checkout path and a stripped remote only after an explicit opt-in", async () => {
    const root = scratch();
    const checkout = path.join(root, "widget");
    initRepo(checkout);
    git(checkout, ["remote", "add", "origin", CREDENTIALED_ORIGIN]);

    const enrichment = await enrichRepositoryMetadata(privacy, checkout, {
      disclosure: { allowRawPaths: true, allowRawRemotes: true },
    });

    expect(enrichment.rootPath).toEqual({
      classification: "sensitive-locator",
      value: path.normalize(checkout),
    });
    expect(enrichment.remotes[0]?.url).toEqual({
      classification: "sensitive-locator",
      value: "https://github.com/example-org/widget",
    });
    assertNoLeak(enrichment, [SECRET, TOKEN, "access_token", "user:"]);
  });

  it("keeps a detached HEAD correlated without inventing a branch", async () => {
    const root = scratch();
    const checkout = path.join(root, "widget");
    initRepo(checkout);
    git(checkout, ["remote", "add", "origin", CLEAN_ORIGIN]);
    git(checkout, ["checkout", "--detach"]);

    const enrichment = await enrichRepositoryMetadata(privacy, checkout);

    expect(enrichment.detachedHead).toBe(true);
    expect(enrichment.branch).toBeUndefined();
    expect(enrichment.workspace.vcsBranchName).toBeUndefined();
    expect(enrichment.workspace.keySource).toBe("git-remote");
    expect(enrichment.rootIdentity?.value).toMatch(/^sha256:/);
    expect(enrichment.remotes[0]?.identity.value).toMatch(/^sha256:/);
    expect(enrichment.revision?.value).toBe(enrichment.workspace.vcsRevisionId);
    assertNoLeak(enrichment, [root, headOf(checkout)]);
  });

  it("correlates linked worktrees and still separates them from another repository", async () => {
    const root = scratch();
    const main = path.join(root, "widget");
    const feature = path.join(root, "widget-feature");
    const otherRoot = scratch();
    const other = path.join(otherRoot, "widget");
    initRepo(main);
    git(main, ["remote", "add", "origin", CREDENTIALED_ORIGIN]);
    git(main, ["worktree", "add", "-b", "feature", feature]);
    initRepo(other);
    git(other, ["remote", "add", "origin", "https://github.com/beta-org/widget.git"]);

    const mainEnrichment = await enrichRepositoryMetadata(privacy, main);
    const featureEnrichment = await enrichRepositoryMetadata(privacy, feature);
    const otherEnrichment = await enrichRepositoryMetadata(privacy, other);
    const nameOnly = deriveWorkspaceIdentity(privacy, { kind: "explicit", value: "widget" });

    expect(featureEnrichment.workspace.workspaceId).toBe(mainEnrichment.workspace.workspaceId);
    expect(featureEnrichment.rootIdentity?.value).toBe(mainEnrichment.rootIdentity?.value);
    expect(featureEnrichment.remotes[0]?.identity.value).toBe(mainEnrichment.remotes[0]?.identity.value);
    expect(featureEnrichment.branch?.value).toBe("feature");
    expect(mainEnrichment.branch?.value).toBe("main");
    expect(otherEnrichment.name?.value).toBe("widget");
    expect(otherEnrichment.workspace.workspaceId).not.toBe(mainEnrichment.workspace.workspaceId);
    expect(otherEnrichment.rootIdentity?.value).not.toBe(mainEnrichment.rootIdentity?.value);
    expect(mainEnrichment.workspace.workspaceId).not.toBe(nameOnly.workspaceId);
    expect(mainEnrichment.workspace.workspaceId).not.toBe(
      deriveWorkspaceIdentity(privacy, { kind: "working-directory", absolutePath: main }).workspaceId,
    );
    assertNoLeak(mainEnrichment, [SECRET, TOKEN, root, otherRoot]);
    assertNoLeak(featureEnrichment, [SECRET, TOKEN, root, otherRoot]);
  });

  it("records every remote and refuses to guess a primary when origin is absent", async () => {
    const root = scratch();
    const checkout = path.join(root, "widget");
    initRepo(checkout);
    git(checkout, ["remote", "add", "upstream", "https://gitlab.com/other-org/widget.git"]);
    git(checkout, ["remote", "add", "fork", "git@github.com:fork-org/widget.git"]);

    const enrichment = await enrichRepositoryMetadata(privacy, checkout);
    const common = commonDirOf(checkout);
    const byRoot = deriveWorkspaceIdentity(privacy, { kind: "git-root", absolutePath: common });

    expect(enrichment.primaryRemoteName).toBeUndefined();
    expect(enrichment.owner).toBeUndefined();
    expect(enrichment.name).toBeUndefined();
    expect(enrichment.workspace.workspaceId).toBe(byRoot.workspaceId);
    expect(enrichment.workspace.keySource).toBe("git-root");
    expect(enrichment.remotes.map((remote) => remote.name).sort()).toEqual(["fork", "upstream"]);
    expect(enrichment.remotes[0]?.identity.value).not.toBe(enrichment.remotes[1]?.identity.value);
    expect(enrichment.remotes.every((remote) => remote.url === undefined)).toBe(true);
    assertNoLeak(enrichment, [
      "gitlab.com/other-org/widget",
      "github.com/fork-org/widget",
      root,
    ]);
  });

  it("uses origin as the workspace key when several remotes exist", async () => {
    const root = scratch();
    const checkout = path.join(root, "widget");
    initRepo(checkout);
    git(checkout, ["remote", "add", "upstream", "https://gitlab.com/other-org/widget.git"]);
    git(checkout, ["remote", "add", "origin", CLEAN_ORIGIN]);

    const enrichment = await enrichRepositoryMetadata(privacy, checkout);
    const originWorkspace = deriveWorkspaceIdentity(privacy, {
      kind: "git-remote",
      remoteUrl: CLEAN_ORIGIN,
    });
    const upstreamIdentity = privacy.deriveOpaqueId(
      "repository/remote",
      "gitlab.com/other-org/widget",
    );

    expect(enrichment.primaryRemoteName).toBe("origin");
    expect(enrichment.workspace.workspaceId).toBe(originWorkspace.workspaceId);
    expect(enrichment.owner?.value).toBe("example-org");
    expect(enrichment.remotes.map((remote) => remote.identity.value)).toContain(upstreamIdentity);
    expect(enrichment.remotes.map((remote) => remote.identity.value)).toContain(
      privacy.deriveOpaqueId("repository/remote", "github.com/example-org/widget"),
    );
  });

  it("reports missing git and a non-repository without throwing", async () => {
    const root = scratch();
    const missing = await enrichRepositoryMetadata(privacy, root, {
      inspector: createProcessRepositoryInspector({ command: "otel-hook-git-missing" }),
    });
    const notRepo = await enrichRepositoryMetadata(privacy, root);

    expect(missing).toMatchObject({
      status: "unavailable",
      reason: "missing-git",
      detachedHead: false,
      remotes: [],
    });
    expect(missing.workspace.keySource).toBe("unknown");
    expect(notRepo).toMatchObject({ status: "unavailable", reason: "not-a-repository" });
    expect(notRepo.workspace).toEqual(missing.workspace);
    assertNoLeak(missing, [root]);
    assertNoLeak(notRepo, [root]);
  });

  it("drops malformed remotes and never echoes their secrets", async () => {
    const thrown = await enrichRepositoryMetadata(privacy, "/synthetic/checkout", {
      inspector: {
        inspect: () => Promise.reject(new Error(`${SECRET} exploded at /synthetic/checkout`)),
      },
    });
    const enrichment = await enrichRepositoryMetadata(privacy, "/synthetic/checkout", {
      disclosure: { allowRawPaths: true, allowRawRemotes: true },
      inspector: inspectorFor(
        snapshot({
          remotes: [
            { name: "origin", url: `https://user:${SECRET}@` },
            { name: "broken", url: "http://[::1" },
            { name: "weird", url: "::::" },
            { name: "-flag", url: CLEAN_ORIGIN },
            {
              name: "query",
              url: `https://github.com/example-org/widget.git?token=${TOKEN}#${TOKEN}`,
            },
          ],
        }),
      ),
    });

    expect(thrown.status).toBe("unavailable");
    expect(thrown.reason).toBe("failed");
    expect(enrichment.status).toBe("enriched");
    expect(enrichment.remotes.map((remote) => remote.name)).toEqual(["query"]);
    expect(enrichment.primaryRemoteName).toBe("query");
    expect(enrichment.remotes[0]?.url?.value).toBe("https://github.com/example-org/widget");
    expect(enrichment.rootPath?.classification).toBe("sensitive-locator");
    assertNoLeak(thrown, [SECRET, "/synthetic/checkout"]);
    assertNoLeak(enrichment, [SECRET, TOKEN, "token="]);
  });

  it("hashes the same remote once, and a different salt cannot be correlated", async () => {
    const body = snapshot({
      remotes: [
        { name: "origin", url: CREDENTIALED_ORIGIN },
        { name: "mirror", url: "git@github.com:example-org/widget.git" },
      ],
    });
    const enrichment = await enrichRepositoryMetadata(privacy, "/synthetic/checkout", {
      inspector: inspectorFor(body),
    });
    const salted = await enrichRepositoryMetadata(
      createTestPrivacyService({ hashSalt: "tenant-a" }),
      "/synthetic/checkout",
      { inspector: inspectorFor(body) },
    );

    expect(enrichment.remotes[0]?.identity.value).toBe(enrichment.remotes[1]?.identity.value);
    expect(salted.rootIdentity?.value).not.toBe(enrichment.rootIdentity?.value);
    expect(salted.workspace.workspaceId).not.toBe(enrichment.workspace.workspaceId);
    assertNoLeak(enrichment, [SECRET, TOKEN, "/synthetic/checkout"]);
  });

  it("fails open when the checkout paths are unusable", async () => {
    const enrichment = await enrichRepositoryMetadata(privacy, "/synthetic/checkout", {
      inspector: inspectorFor(
        snapshot({
          toplevel: "relative/not-absolute",
          commonDir: "",
        }),
      ),
    });
    expect(enrichment.status).toBe("unavailable");
    expect(enrichment.reason).toBe("failed");
  });
});
