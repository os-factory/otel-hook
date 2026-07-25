import {
  workspaceIdentitySchema,
  type WorkspaceIdentity,
  type WorkspaceKeySource,
} from "../model/identity.js";
import type { PrivacyService } from "./service.js";

/**
 * Raw material a caller can offer for workspace identification.
 *
 * Paths and remote URLs are accepted here and immediately hashed. Neither is
 * retained, so a home directory cannot reach an exporter through this path.
 */
export type WorkspaceKeyInput =
  | { readonly kind: "git-remote"; readonly remoteUrl: string }
  | { readonly kind: "git-root"; readonly absolutePath: string }
  | { readonly kind: "working-directory"; readonly absolutePath: string }
  | { readonly kind: "explicit"; readonly value: string }
  | { readonly kind: "unknown" };

export type WorkspaceLabels = {
  /** Bare repository name, e.g. `otel-hook`. Never an owner path or URL. */
  readonly repositoryName?: string;
  readonly vcsBranchName?: string;
  /** Revision identifier; hashed before it is stored. */
  readonly vcsRevisionId?: string;
};

/**
 * Canonicalize a git remote so equivalent spellings hash identically:
 * scheme, credentials, port, trailing `.git`, and case are removed.
 */
export const canonicalizeGitRemote = (remoteUrl: string): string => {
  const trimmed = remoteUrl.trim();
  const scpLike = /^([^@/]+)@([^:]+):(.+)$/.exec(trimmed);
  const withoutScheme = scpLike
    ? `${scpLike[2] ?? ""}/${scpLike[3] ?? ""}`
    : trimmed.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "").replace(/^[^@/]+@/, "");
  return withoutScheme
    .replace(/:\d+\//, "/")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
};

const keySourceOf = (input: WorkspaceKeyInput): WorkspaceKeySource => {
  switch (input.kind) {
    case "git-remote":
      return "git-remote";
    case "git-root":
      return "git-root";
    case "working-directory":
      return "working-directory";
    case "explicit":
      return "explicit";
    case "unknown":
      return "unknown";
  }
};

const keyMaterialOf = (input: WorkspaceKeyInput): string | undefined => {
  switch (input.kind) {
    case "git-remote":
      return canonicalizeGitRemote(input.remoteUrl);
    case "git-root":
    case "working-directory":
      return input.absolutePath.replace(/[/\\]+$/, "");
    case "explicit":
      return input.value;
    case "unknown":
      return undefined;
  }
};

/**
 * Derive privacy-safe workspace identity.
 *
 * The identifier is a salted hash namespaced by key source, so a directory-keyed
 * workspace and a remote-keyed workspace never collide even if the underlying
 * strings match.
 */
export const deriveWorkspaceIdentity = (
  privacy: PrivacyService,
  input: WorkspaceKeyInput,
  labels: WorkspaceLabels = {},
): WorkspaceIdentity => {
  const keySource = keySourceOf(input);
  const material = keyMaterialOf(input);
  const workspaceId =
    material === undefined || material === ""
      ? "unknown:0000000000000000"
      : privacy.deriveOpaqueId(`workspace/${keySource}`, material);

  return workspaceIdentitySchema.parse({
    workspaceId,
    keySource: material === undefined || material === "" ? "unknown" : keySource,
    ...(labels.repositoryName === undefined
      ? {}
      : { repositoryName: labels.repositoryName.slice(0, 128) }),
    ...(labels.vcsBranchName === undefined
      ? {}
      : { vcsBranchName: labels.vcsBranchName.slice(0, 128) }),
    ...(labels.vcsRevisionId === undefined
      ? {}
      : { vcsRevisionId: privacy.deriveOpaqueId("workspace/revision", labels.vcsRevisionId) }),
  });
};
