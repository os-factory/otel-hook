import { describe, expect, it } from "vitest";

import {
  canonicalizeGitRemote,
  deriveWorkspaceIdentity,
  invocationIdentitySchema,
  resolveInvocationIdentity,
  unknownWorkspaceIdentity,
  workspaceIdentitySchema,
  type IdentityClaim,
} from "../src/index.js";
import { createTestPrivacyService, createTestProvenance } from "../src/testing/index.js";

const provenance = createTestProvenance();

const claim = (
  source: string,
  confidence: IdentityClaim["confidence"],
  fields: Record<string, unknown>,
): IdentityClaim => ({ source, confidence, fields });

describe("invocation identity resolution", () => {
  it("resolves from a single complete claim", () => {
    const resolution = resolveInvocationIdentity({
      claims: [
        claim("adapter:fixture", "exact", {
          invocationId: "inv_1",
          sessionId: "ses_1",
          startedAt: 1_700_000_000_000,
        }),
      ],
      provenance,
    });

    expect(resolution.status).toBe("resolved");
    if (resolution.status === "resolved") {
      expect(resolution.identity.sessionId).toBe("ses_1");
      expect(resolution.identity.workspace.keySource).toBe("unknown");
    }
  });

  it("prefers the highest-confidence claim per field", () => {
    const resolution = resolveInvocationIdentity({
      claims: [
        claim("env", "weak", { sessionId: "ses_weak", invocationId: "inv_1" }),
        claim("adapter:fixture", "exact", { sessionId: "ses_strong" }),
      ],
      provenance,
      fallback: { startedAt: 1_700_000_000_000 },
    });

    expect(resolution.status).toBe("resolved");
    if (resolution.status === "resolved") {
      expect(resolution.identity.sessionId).toBe("ses_strong");
      // The weak claim still supplies a field nobody else claimed.
      expect(resolution.identity.invocationId).toBe("inv_1");
    }
  });

  it("declines when peers of equal confidence disagree", () => {
    const resolution = resolveInvocationIdentity({
      claims: [
        claim("adapter:a", "exact", { sessionId: "ses_a", invocationId: "inv_1" }),
        claim("adapter:b", "exact", { sessionId: "ses_b" }),
      ],
      provenance,
      fallback: { startedAt: 1 },
    });

    expect(resolution.status).toBe("conflict");
    if (resolution.status === "conflict") {
      expect(resolution.conflicts).toHaveLength(1);
      expect(resolution.conflicts[0]?.field).toBe("sessionId");
      expect([...(resolution.conflicts[0]?.values ?? [])].sort()).toEqual(["ses_a", "ses_b"]);
      expect([...(resolution.conflicts[0]?.sources ?? [])].sort()).toEqual([
        "adapter:a",
        "adapter:b",
      ]);
    }
  });

  it("does not treat identical values from different sources as a conflict", () => {
    const resolution = resolveInvocationIdentity({
      claims: [
        claim("adapter:a", "exact", { sessionId: "ses_same", invocationId: "inv_1" }),
        claim("adapter:b", "exact", { sessionId: "ses_same" }),
      ],
      provenance,
      fallback: { startedAt: 1 },
    });
    expect(resolution.status).toBe("resolved");
  });

  it("reports missing mandatory fields instead of inventing them", () => {
    const resolution = resolveInvocationIdentity({
      claims: [claim("adapter:a", "exact", { sessionId: "ses_1" })],
      provenance,
      fallback: { startedAt: 1 },
    });

    expect(resolution.status).toBe("incomplete");
    if (resolution.status === "incomplete") {
      expect(resolution.missing).toEqual(["invocationId"]);
    }
  });

  it("reports an absent start time as incomplete when no fallback is offered", () => {
    const resolution = resolveInvocationIdentity({
      claims: [claim("adapter:a", "exact", { sessionId: "ses_1", invocationId: "inv_1" })],
      provenance,
    });
    expect(resolution.status).toBe("incomplete");
    if (resolution.status === "incomplete") {
      expect(resolution.missing).toEqual(["startedAt"]);
    }
  });

  it("rejects malformed claims rather than silently skipping them", () => {
    const resolution = resolveInvocationIdentity({
      claims: [claim("adapter:a", "exact", { sessionId: "", invocationId: "inv_1" })],
      provenance,
      fallback: { startedAt: 1 },
    });
    expect(resolution.status).toBe("invalid");
  });

  it("rejects a claim carrying an unknown field", () => {
    const resolution = resolveInvocationIdentity({
      claims: [claim("adapter:a", "exact", { sessionId: "s", invocationId: "i", cwd: "/home/x" })],
      provenance,
      fallback: { startedAt: 1 },
    });
    expect(resolution.status).toBe("invalid");
  });

  it("carries consumer attributes through untouched but sanitized", () => {
    const resolution = resolveInvocationIdentity({
      claims: [claim("a", "exact", { sessionId: "s", invocationId: "i", startedAt: 1 })],
      provenance,
      consumerAttributes: { "consumer.tenant": "acme", "consumer.rank": 3 },
    });
    expect(resolution.status).toBe("resolved");
    if (resolution.status === "resolved") {
      expect(resolution.identity.consumerAttributes).toEqual({
        "consumer.tenant": "acme",
        "consumer.rank": 3,
      });
    }
  });
});

describe("invocation identity immutability", () => {
  it("freezes the identity and its nested objects", () => {
    const identity = invocationIdentitySchema.parse({
      invocationId: "inv_1",
      sessionId: "ses_1",
      provenance,
      workspace: unknownWorkspaceIdentity(),
      startedAt: 1,
      consumerAttributes: {},
    });

    expect(Object.isFrozen(identity)).toBe(true);
    expect(Object.isFrozen(identity.provenance)).toBe(true);
    expect(Object.isFrozen(identity.workspace)).toBe(true);
    expect(() => {
      (identity as unknown as { sessionId: string }).sessionId = "other";
    }).toThrow();
  });

  it("rejects unknown identity fields", () => {
    expect(
      invocationIdentitySchema.safeParse({
        invocationId: "inv_1",
        sessionId: "ses_1",
        provenance,
        workspace: unknownWorkspaceIdentity(),
        startedAt: 1,
        consumerAttributes: {},
        transcriptPath: "/home/someone/.agent/session.jsonl",
      }).success,
    ).toBe(false);
  });
});

describe("workspace identity", () => {
  const privacy = createTestPrivacyService();

  it("hashes a path into an opaque handle", () => {
    const workspace = deriveWorkspaceIdentity(privacy, {
      kind: "git-root",
      absolutePath: "/home/someone/projects/app",
    });

    expect(workspace.workspaceId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(workspace)).not.toContain("someone");
    expect(workspace.keySource).toBe("git-root");
  });

  it("is stable for the same key and distinct across key sources", () => {
    const a = deriveWorkspaceIdentity(privacy, { kind: "explicit", value: "team/app" });
    const b = deriveWorkspaceIdentity(privacy, { kind: "explicit", value: "team/app" });
    const c = deriveWorkspaceIdentity(privacy, { kind: "working-directory", absolutePath: "team/app" });

    expect(a.workspaceId).toBe(b.workspaceId);
    expect(a.workspaceId).not.toBe(c.workspaceId);
  });

  it("canonicalizes equivalent git remotes to the same identity", () => {
    const ssh = deriveWorkspaceIdentity(privacy, {
      kind: "git-remote",
      remoteUrl: "git@github.com:os-factory/otel-hook.git",
    });
    const https = deriveWorkspaceIdentity(privacy, {
      kind: "git-remote",
      remoteUrl: "https://github.com/os-factory/otel-hook",
    });
    const withCredentials = deriveWorkspaceIdentity(privacy, {
      kind: "git-remote",
      remoteUrl: "https://user:token@github.com/os-factory/otel-hook.git/",
    });

    expect(canonicalizeGitRemote("git@github.com:os-factory/otel-hook.git")).toBe(
      "github.com/os-factory/otel-hook",
    );
    expect(ssh.workspaceId).toBe(https.workspaceId);
    expect(withCredentials.workspaceId).toBe(https.workspaceId);
  });

  it("hashes the revision id and never stores it verbatim", () => {
    const workspace = deriveWorkspaceIdentity(
      privacy,
      { kind: "explicit", value: "app" },
      { vcsRevisionId: "0123456789abcdef", vcsBranchName: "main", repositoryName: "app" },
    );
    expect(workspace.vcsRevisionId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(workspace.vcsBranchName).toBe("main");
    expect(workspace.repositoryName).toBe("app");
  });

  it("falls back to the unknown workspace when no key material exists", () => {
    const workspace = deriveWorkspaceIdentity(privacy, { kind: "unknown" });
    expect(workspace.keySource).toBe("unknown");
    expect(workspace).toEqual(unknownWorkspaceIdentity());
  });

  it("rejects a raw path supplied directly as a workspace id", () => {
    expect(
      workspaceIdentitySchema.safeParse({
        workspaceId: "/home/someone/projects/app",
        keySource: "git-root",
      }).success,
    ).toBe(false);
    expect(
      workspaceIdentitySchema.safeParse({ workspaceId: "sha256:short", keySource: "explicit" })
        .success,
    ).toBe(false);
  });
});
