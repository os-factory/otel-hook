import { z } from "zod";

import type { ContentDisclosure } from "../model/content.js";

/**
 * How much content the library is permitted to disclose.
 *
 * `omit` is the default and the only mode that requires no trust in the
 * downstream collector.
 */
export const contentModeSchema = z.enum(["omit", "mask", "redact", "raw"]);
export type ContentMode = z.infer<typeof contentModeSchema>;

export const CONTENT_MODE_DISCLOSURE: Readonly<Record<ContentMode, ContentDisclosure>> =
  Object.freeze({
    omit: "omitted",
    mask: "masked",
    redact: "redacted",
    raw: "raw",
  });

/**
 * Default secret-key patterns, matched case-insensitively against object keys at
 * every depth. A key matching any of these has its value replaced before the
 * value itself is ever inspected.
 */
export const DEFAULT_SECRET_KEY_PATTERNS: readonly string[] = Object.freeze([
  "(^|[._-])(secret|secrets)([._-]|$)",
  "(^|[._-])(token|tokens)([._-]|$)",
  "(^|[._-])(password|passwd|pwd)([._-]|$)",
  "(^|[._-])(credential|credentials)([._-]|$)",
  "(^|[._-])(api[._-]?key|apikey|access[._-]?key|secret[._-]?key|private[._-]?key)([._-]|$)",
  "(^|[._-])(authorization|auth[._-]?header|bearer)([._-]|$)",
  "(^|[._-])(cookie|set[._-]?cookie)([._-]|$)",
  "(^|[._-])(signature|sig)([._-]|$)",
]);

/**
 * Default secret-value patterns applied to disclosed text in `redact` mode.
 * These are heuristics; they reduce accidental disclosure but are not a
 * substitute for `omit`.
 */
export const DEFAULT_SECRET_VALUE_PATTERNS: readonly string[] = Object.freeze([
  "AKIA[0-9A-Z]{16}",
  "sk-[A-Za-z0-9_-]{16,}",
  "gh[pousr]_[A-Za-z0-9]{16,}",
  "xox[abprs]-[A-Za-z0-9-]{10,}",
  "-----BEGIN[A-Z ]*PRIVATE KEY-----",
  "eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}",
  "(?:Bearer|Basic)\\s+[A-Za-z0-9._~+/=-]{12,}",
]);

export const privacyLimitsSchema = z.strictObject({
  /** Maximum characters of disclosed text per content fact or string value. */
  maxStringLength: z.number().int().min(0).max(65_536),
  /** Maximum nesting depth walked when sanitizing structured values. */
  maxDepth: z.number().int().min(1).max(32),
  /** Maximum array entries retained when sanitizing structured values. */
  maxArrayLength: z.number().int().min(1).max(4096),
  /** Maximum canonical events emitted per invocation. */
  maxEventsPerInvocation: z.number().int().min(1).max(10_000),
  /** Maximum object keys retained per level when sanitizing. */
  maxObjectKeys: z.number().int().min(1).max(1024),
});
export type PrivacyLimits = z.infer<typeof privacyLimitsSchema>;

export const privacyPolicySchema = z.strictObject({
  contentMode: contentModeSchema,
  /**
   * `raw` mode is refused unless this is also true, so a single mistyped
   * environment variable cannot start exporting prompts.
   */
  allowRawContent: z.boolean(),
  /**
   * Salt mixed into every hash. A per-deployment salt makes hashes
   * non-correlatable across deployments; an empty salt makes them globally
   * comparable. Both are legitimate; the choice is explicit.
   */
  hashSalt: z.string().max(256),
  maskCharacter: z.string().length(1),
  redactionPlaceholder: z.string().min(1).max(64),
  secretKeyPatterns: z.array(z.string().min(1)).max(128).readonly(),
  secretValuePatterns: z.array(z.string().min(1)).max(128).readonly(),
  limits: privacyLimitsSchema,
});
export type PrivacyPolicy = z.infer<typeof privacyPolicySchema>;

export const DEFAULT_PRIVACY_LIMITS: PrivacyLimits = Object.freeze({
  maxStringLength: 1024,
  maxDepth: 6,
  maxArrayLength: 64,
  maxEventsPerInvocation: 512,
  maxObjectKeys: 128,
});

export const DEFAULT_PRIVACY_POLICY: PrivacyPolicy = Object.freeze({
  contentMode: "omit",
  allowRawContent: false,
  hashSalt: "",
  maskCharacter: "*",
  redactionPlaceholder: "[redacted]",
  secretKeyPatterns: DEFAULT_SECRET_KEY_PATTERNS,
  secretValuePatterns: DEFAULT_SECRET_VALUE_PATTERNS,
  limits: DEFAULT_PRIVACY_LIMITS,
});

export type PolicyResolution = {
  readonly policy: PrivacyPolicy;
  /** Non-sensitive notes about deterministic downgrades that were applied. */
  readonly notes: readonly string[];
};

/**
 * Validate a policy and apply the one deterministic downgrade the library
 * enforces: `raw` without `allowRawContent` becomes `omit`.
 */
export const resolvePrivacyPolicy = (policy: PrivacyPolicy): PolicyResolution => {
  const parsed = privacyPolicySchema.parse(policy);
  if (parsed.contentMode === "raw" && !parsed.allowRawContent) {
    return {
      policy: { ...parsed, contentMode: "omit" },
      notes: ["contentMode=raw downgraded to omit because allowRawContent is false"],
    };
  }
  return { policy: parsed, notes: [] };
};
