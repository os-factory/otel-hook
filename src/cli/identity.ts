import { createErrorInfo, type OtelHookErrorInfo } from "../errors/index.js";
import { identityClaimFieldsSchema, identityClaimSchema, type IdentityClaim } from "../model/identity.js";
import type { CliIdentityFlags } from "./args.js";

/**
 * Turn caller-asserted identity into claims.
 *
 * Flags and an identity file are *separate* claims at the same confidence, not a
 * merged record. That is deliberate: if they disagree about a field, the core's
 * arbitration reports an identity conflict and declines attribution, which is
 * the documented posture (ADR 0001). Merging them by precedence would silently
 * pick a winner between two assertions that are equally explicit.
 *
 * Claims are contributed at `exact` confidence because they are assertions, not
 * inferences. A caller-asserted session id that disagrees with the one in the
 * provider payload is therefore also a conflict — the invocation is not
 * attributed rather than attributed to a guess.
 */
export type CliIdentityResolution = {
  readonly claims: readonly IdentityClaim[];
  readonly errors: readonly OtelHookErrorInfo[];
};

const invalid = (detail: string): OtelHookErrorInfo =>
  createErrorInfo({ code: "identity-incomplete", phase: "identity", detail });

export const claimFromIdentityFlags = (flags: CliIdentityFlags): CliIdentityResolution => {
  const fields = {
    ...(flags.sessionId === undefined ? {} : { sessionId: flags.sessionId }),
    ...(flags.invocationId === undefined ? {} : { invocationId: flags.invocationId }),
    ...(flags.parentInvocationId === undefined
      ? {}
      : { parentInvocationId: flags.parentInvocationId }),
    ...(flags.rootSessionId === undefined ? {} : { rootSessionId: flags.rootSessionId }),
    ...(flags.agentInstanceId === undefined ? {} : { agentInstanceId: flags.agentInstanceId }),
  };
  if (Object.keys(fields).length === 0) {
    return { claims: [], errors: [] };
  }
  const parsed = identityClaimFieldsSchema.safeParse(fields);
  if (!parsed.success) {
    return {
      claims: [],
      errors: [
        invalid(
          `identity flags rejected: ${parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "<root>"} ${issue.message}`)
            .join("; ")}`,
        ),
      ],
    };
  }
  return {
    claims: [
      identityClaimSchema.parse({ source: "cli:flags", confidence: "exact", fields: parsed.data }),
    ],
    errors: [],
  };
};

/**
 * Build a claim from the parsed contents of an identity file.
 *
 * The file is validated against `identityClaimFieldsSchema`, which is strict: an
 * unknown key is an error rather than being ignored, so a typo cannot silently
 * drop the session id it was meant to set.
 */
export const claimFromIdentityFile = (contents: unknown, origin: string): CliIdentityResolution => {
  const parsed = identityClaimFieldsSchema.safeParse(contents);
  if (!parsed.success) {
    return {
      claims: [],
      errors: [
        invalid(
          `identity file rejected: ${parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "<root>"} ${issue.message}`)
            .join("; ")}`,
        ),
      ],
    };
  }
  if (Object.keys(parsed.data).length === 0) {
    return { claims: [], errors: [invalid("identity file contained no identity fields")] };
  }
  return {
    claims: [
      identityClaimSchema.parse({
        // The label names the source kind, never the path: a path in a claim
        // source would end up in a diagnostic.
        source: `cli:identity-file:${origin}`,
        confidence: "exact",
        fields: parsed.data,
      }),
    ],
    errors: [],
  };
};
