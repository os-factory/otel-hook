import {
  workspaceIdentitySchema,
  type WorkspaceIdentity,
  type WorkspaceKeySource,
} from "../model/identity.js";
import { DEFAULT_SECRET_VALUE_PATTERNS } from "./policy.js";
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

const SECRET_VALUE_PATTERNS: readonly RegExp[] = Object.freeze(
  DEFAULT_SECRET_VALUE_PATTERNS.flatMap((source) => {
    try {
      return [new RegExp(source, "i")];
    } catch {
      return [];
    }
  }),
);

const containsSecret = (value: string): boolean =>
  SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));

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

/** Drop query strings and fragments before any other URL handling. */
const stripUrlDecorations = (value: string): string => {
  const hash = value.indexOf("#");
  const withoutFragment = hash === -1 ? value : value.slice(0, hash);
  const query = withoutFragment.indexOf("?");
  return query === -1 ? withoutFragment : withoutFragment.slice(0, query);
};

/**
 * Host and path with scheme, userinfo, and port removed.
 *
 * Returns an empty string when the input is malformed or a credential would
 * still be part of the result. Callers must hash or export only this string,
 * never the original URL.
 */
const strippedRemoteHostPath = (remoteUrl: string): string => {
  const trimmed = stripUrlDecorations(remoteUrl.trim());
  if (trimmed === "" || hasUnsafeWhitespace(trimmed)) {
    return "";
  }

  let hostAndPath: string;
  if (trimmed.includes("://")) {
    hostAndPath = trimmed
      .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "")
      .replace(/^[^@/]+@/, "");
  } else {
    const scpLike = /^([^@/]+)@([^:]+):(.+)$/.exec(trimmed);
    hostAndPath =
      scpLike === null
        ? trimmed.replace(/^[^@/]+@/, "")
        : `${scpLike[2] ?? ""}/${scpLike[3] ?? ""}`;
  }

  return hostAndPath
    .replace(/:\d+(?=\/|$)/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
};

const isSafeCanonicalRemote = (canonical: string): boolean => {
  if (
    canonical === "" ||
    canonical.includes("@") ||
    canonical.includes("?") ||
    canonical.includes("#") ||
    hasUnsafeWhitespace(canonical) ||
    containsSecret(canonical)
  ) {
    return false;
  }
  const slash = canonical.indexOf("/");
  const colon = canonical.indexOf(":");
  // A colon before the path is leftover userinfo (`user:secret/host`) or an
  // unstripped port. A single-letter drive prefix is the one local-path form
  // that legitimately has one.
  if (colon !== -1 && (slash === -1 || colon < slash) && !/^[a-z]:/.test(canonical)) {
    return false;
  }
  return true;
};

/**
 * Canonicalize a git remote so equivalent spellings hash identically.
 *
 * Scheme, userinfo, query, fragment, port, trailing `.git`, and case are
 * removed before the result is returned. The result is empty when stripping
 * cannot produce a credential-free host/path — callers then hash nothing.
 */
export const canonicalizeGitRemote = (remoteUrl: string): string => {
  const canonical = strippedRemoteHostPath(remoteUrl);
  return isSafeCanonicalRemote(canonical) ? canonical : "";
};

/**
 * Credential-free URL suitable for an explicit raw-remote opt-in.
 *
 * This is not the original string. Userinfo, query, and fragment are removed
 * first; a local path or a URL that cannot be stripped returns `undefined`
 * so a secret cannot be disclosed by opting in.
 */
export const sanitizeGitRemoteUrl = (remoteUrl: string): string | undefined => {
  const canonical = canonicalizeGitRemote(remoteUrl);
  if (canonical === "" || canonical.startsWith("/") || canonical.includes(":") || canonical.includes("@")) {
    return undefined;
  }
  const trimmed = stripUrlDecorations(remoteUrl.trim());
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(trimmed)?.[1]?.toLowerCase();
  const scpLike = !trimmed.includes("://") && /^[^@/\s]+@[^:\s]+:.+$/.test(trimmed);
  const safeScheme =
    scheme === "http" || scheme === "https" || scheme === "ssh" || scheme === "git"
      ? scheme
      : scpLike
        ? "ssh"
        : "https";
  const disclosed = `${safeScheme}://${canonical}`;
  return containsSecret(disclosed) ? undefined : disclosed;
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
