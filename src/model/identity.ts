import { z } from "zod";

import {
  attributesSchema,
  detectionConfidenceSchema,
  DETECTION_CONFIDENCE_RANK,
  epochMillisSchema,
  invocationIdSchema,
  nonEmptyStringSchema,
  resolvedProviderIdSchema,
  sessionIdSchema,
  sourceTransportSchema,
  workspaceIdSchema,
  type DetectionConfidence,
  type InvocationId,
  type SessionId,
  type WorkspaceId,
} from "./primitives.js";

/**
 * Where a workspace identifier came from.
 *
 * Ordered from most to least stable. The source is recorded so consumers can
 * tell a repository-scoped identity from a directory-scoped one instead of
 * assuming they are comparable.
 */
export const workspaceKeySourceSchema = z.enum([
  "git-remote",
  "git-root",
  "working-directory",
  "explicit",
  "unknown",
]);
export type WorkspaceKeySource = z.infer<typeof workspaceKeySourceSchema>;

/**
 * Privacy-safe workspace identity.
 *
 * Only opaque handles and explicitly allowed labels are modelled. There is no
 * field for a filesystem path, so paths cannot be exported through this type.
 */
export const workspaceIdentitySchema = z
  .strictObject({
    workspaceId: workspaceIdSchema,
    keySource: workspaceKeySourceSchema,
    /** Repository name only; never an owner path or URL with credentials. */
    repositoryName: nonEmptyStringSchema.optional(),
    vcsBranchName: nonEmptyStringSchema.optional(),
    /** Opaque handle for the checked-out revision. */
    vcsRevisionId: nonEmptyStringSchema.optional(),
  })
  .readonly();
export type WorkspaceIdentity = z.infer<typeof workspaceIdentitySchema>;

export const UNKNOWN_WORKSPACE_ID = "unknown:0000000000000000" as WorkspaceId;

export const unknownWorkspaceIdentity = (): WorkspaceIdentity =>
  workspaceIdentitySchema.parse({
    workspaceId: UNKNOWN_WORKSPACE_ID,
    keySource: "unknown",
  });

/**
 * Provenance of an observation: which provider produced it and which adapter
 * interpreted it, with the confidence of that attribution.
 */
export const sourceProvenanceSchema = z
  .strictObject({
    providerId: resolvedProviderIdSchema,
    providerVersion: nonEmptyStringSchema.optional(),
    adapterId: nonEmptyStringSchema,
    adapterVersion: nonEmptyStringSchema,
    detectionConfidence: detectionConfidenceSchema,
    /** The provider's own name for the source event, e.g. a hook event name. */
    sourceEventName: nonEmptyStringSchema.optional(),
    transport: sourceTransportSchema,
  })
  .readonly();
export type SourceProvenance = z.infer<typeof sourceProvenanceSchema>;

/**
 * Opaque, immutable metadata supplied by the embedding consumer.
 *
 * The library never interprets these values; it only carries and exports them.
 */
export const consumerAttributesSchema = attributesSchema.readonly();
export type ConsumerAttributes = z.infer<typeof consumerAttributesSchema>;

/**
 * Immutable identity of a single hook invocation.
 *
 * Frozen on parse. There is deliberately no setter, no builder that mutates in
 * place, and no module-level instance: identity is passed explicitly so two
 * concurrent invocations can never observe each other's fields.
 */
export const invocationIdentitySchema = z
  .strictObject({
    invocationId: invocationIdSchema,
    sessionId: sessionIdSchema,
    /** Set when this invocation runs beneath another agent invocation. */
    parentInvocationId: invocationIdSchema.optional(),
    /** Root of the session tree when the provider exposes one. */
    rootSessionId: sessionIdSchema.optional(),
    /** Stable handle for the agent process/instance, when available. */
    agentInstanceId: nonEmptyStringSchema.optional(),
    provenance: sourceProvenanceSchema,
    workspace: workspaceIdentitySchema,
    startedAt: epochMillisSchema,
    consumerAttributes: consumerAttributesSchema,
  })
  .readonly();
export type InvocationIdentity = z.infer<typeof invocationIdentitySchema>;

/** Fields an identity claim may contribute. */
export const identityClaimFieldsSchema = z.strictObject({
  invocationId: invocationIdSchema.optional(),
  sessionId: sessionIdSchema.optional(),
  parentInvocationId: invocationIdSchema.optional(),
  rootSessionId: sessionIdSchema.optional(),
  agentInstanceId: nonEmptyStringSchema.optional(),
  workspace: workspaceIdentitySchema.optional(),
  startedAt: epochMillisSchema.optional(),
});
export type IdentityClaimFields = z.infer<typeof identityClaimFieldsSchema>;

/**
 * A claim about invocation identity from one source.
 *
 * Claims are evidence, not truth. Resolution keeps the highest-confidence claim
 * per field and refuses to merge disagreeing peers.
 */
export const identityClaimSchema = z.strictObject({
  /** Non-sensitive label, e.g. `adapter:acme-cli` or `env:OTEL_HOOK_SESSION_ID`. */
  source: nonEmptyStringSchema,
  confidence: detectionConfidenceSchema,
  fields: identityClaimFieldsSchema,
});
export type IdentityClaim = z.infer<typeof identityClaimSchema>;

export type IdentityConflict = {
  readonly field: keyof IdentityClaimFields;
  readonly confidence: DetectionConfidence;
  /** Rendered, non-sensitive representations of the disagreeing values. */
  readonly values: readonly string[];
  readonly sources: readonly string[];
};

export type IdentityResolution =
  | { readonly status: "resolved"; readonly identity: InvocationIdentity }
  | {
      readonly status: "conflict";
      readonly conflicts: readonly IdentityConflict[];
    }
  | {
      readonly status: "incomplete";
      readonly missing: readonly (keyof IdentityClaimFields)[];
    }
  | { readonly status: "invalid"; readonly issues: readonly string[] };

const CLAIM_FIELDS = [
  "invocationId",
  "sessionId",
  "parentInvocationId",
  "rootSessionId",
  "agentInstanceId",
  "workspace",
  "startedAt",
] as const satisfies readonly (keyof IdentityClaimFields)[];

const renderClaimValue = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value !== null && typeof value === "object" && "workspaceId" in value) {
    const { workspaceId } = value;
    return typeof workspaceId === "string" ? workspaceId : "<workspace>";
  }
  return "<opaque>";
};

export type ResolveIdentityInput = {
  readonly claims: readonly IdentityClaim[];
  readonly provenance: SourceProvenance;
  /** Used only for fields no claim provides and that have a safe default. */
  readonly fallback?: {
    readonly startedAt?: number;
    readonly workspace?: WorkspaceIdentity;
  };
  readonly consumerAttributes?: Readonly<Record<string, unknown>>;
};

/**
 * Resolve identity from claims, failing closed.
 *
 * Rules:
 * 1. For each field, only claims at the highest confidence that provided it are
 *    considered. Lower-confidence claims never fill in or override.
 * 2. Two distinct values at that highest confidence produce a `conflict`. The
 *    invocation is then not attributed at all — a mislabelled session is worse
 *    than a missing one.
 * 3. `invocationId` and `sessionId` are mandatory. Missing either yields
 *    `incomplete`; neither is invented here.
 * 4. `startedAt` and `workspace` may come from an explicit fallback, because a
 *    clock reading and an `unknown` workspace handle assert nothing false.
 */
export const resolveInvocationIdentity = (input: ResolveIdentityInput): IdentityResolution => {
  const parsedClaims: IdentityClaim[] = [];
  const issues: string[] = [];
  for (const [index, claim] of input.claims.entries()) {
    const parsed = identityClaimSchema.safeParse(claim);
    if (parsed.success) {
      parsedClaims.push(parsed.data);
    } else {
      issues.push(
        `claim[${index}]: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"} ${issue.message}`).join(", ")}`,
      );
    }
  }
  if (issues.length > 0) {
    return { status: "invalid", issues };
  }

  const conflicts: IdentityConflict[] = [];
  const selected: Record<string, unknown> = {};

  for (const field of CLAIM_FIELDS) {
    const contributors = parsedClaims.filter((claim) => claim.fields[field] !== undefined);
    if (contributors.length === 0) {
      continue;
    }
    const bestRank = Math.max(
      ...contributors.map((claim) => DETECTION_CONFIDENCE_RANK[claim.confidence]),
    );
    const best = contributors.filter(
      (claim) => DETECTION_CONFIDENCE_RANK[claim.confidence] === bestRank,
    );
    const rendered = new Map<string, string[]>();
    for (const claim of best) {
      const key = JSON.stringify(claim.fields[field]);
      const sources = rendered.get(key) ?? [];
      sources.push(claim.source);
      rendered.set(key, sources);
    }
    if (rendered.size > 1) {
      const [firstBest] = best;
      conflicts.push({
        field,
        confidence: firstBest?.confidence ?? "none",
        values: best.map((claim) => renderClaimValue(claim.fields[field])),
        sources: best.map((claim) => claim.source),
      });
      continue;
    }
    const [winner] = best;
    if (winner !== undefined) {
      selected[field] = winner.fields[field];
    }
  }

  if (conflicts.length > 0) {
    return { status: "conflict", conflicts };
  }

  const missing: (keyof IdentityClaimFields)[] = [];
  if (selected.invocationId === undefined) {
    missing.push("invocationId");
  }
  if (selected.sessionId === undefined) {
    missing.push("sessionId");
  }
  if (missing.length > 0) {
    return { status: "incomplete", missing };
  }

  const startedAt = (selected.startedAt as number | undefined) ?? input.fallback?.startedAt;
  if (startedAt === undefined) {
    return { status: "incomplete", missing: ["startedAt"] };
  }
  const workspace =
    (selected.workspace as WorkspaceIdentity | undefined) ??
    input.fallback?.workspace ??
    unknownWorkspaceIdentity();

  const candidate = {
    invocationId: selected.invocationId as InvocationId,
    sessionId: selected.sessionId as SessionId,
    ...(selected.parentInvocationId === undefined
      ? {}
      : { parentInvocationId: selected.parentInvocationId as InvocationId }),
    ...(selected.rootSessionId === undefined
      ? {}
      : { rootSessionId: selected.rootSessionId as SessionId }),
    ...(selected.agentInstanceId === undefined
      ? {}
      : { agentInstanceId: selected.agentInstanceId as string }),
    provenance: input.provenance,
    workspace,
    startedAt,
    consumerAttributes: input.consumerAttributes ?? {},
  };

  const parsed = invocationIdentitySchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      status: "invalid",
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`,
      ),
    };
  }
  return { status: "resolved", identity: parsed.data };
};
