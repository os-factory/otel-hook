import { z } from "zod";

import { nonEmptyStringSchema } from "./primitives.js";

/** What kind of conversational or tool content a fact describes. */
export const contentKindSchema = z.enum([
  "prompt",
  "response",
  "reasoning",
  "tool-input",
  "tool-output",
  "error-message",
  "system-instruction",
  "attachment",
]);
export type ContentKind = z.infer<typeof contentKindSchema>;

export const contentRoleSchema = z.enum(["user", "assistant", "system", "tool", "unknown"]);
export type ContentRole = z.infer<typeof contentRoleSchema>;

/**
 * How much of the original content this fact discloses.
 *
 * - `omitted`: no text at all (the default posture).
 * - `masked`: a shape-preserving mask; non-whitespace characters replaced.
 * - `redacted`: text with secret-looking spans replaced by a placeholder.
 * - `raw`: verbatim text. Only reachable through explicit opt-in.
 */
export const contentDisclosureSchema = z.enum(["omitted", "masked", "redacted", "raw"]);
export type ContentDisclosure = z.infer<typeof contentDisclosureSchema>;

export const CONTENT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * A privacy-safe description of content.
 *
 * Lengths and a stable hash are always present so consumers can measure and
 * correlate volume without receiving the content itself. `text` is present only
 * when the resolved privacy policy allows disclosure, and is produced solely by
 * the central privacy service.
 */
export const contentFactSchema = z.strictObject({
  kind: contentKindSchema,
  role: contentRoleSchema.optional(),
  /** Unicode code point count of the original content. */
  characterLength: z.number().int().min(0),
  /** UTF-8 byte length of the original content. */
  byteLength: z.number().int().min(0),
  /** Stable salted digest of the original content. */
  contentHash: z.string().regex(CONTENT_HASH_PATTERN),
  disclosure: contentDisclosureSchema,
  /** Disclosed text, bounded by the privacy policy. Absent when omitted. */
  text: z.string().optional(),
  /** True when `text` was cut short by the configured string bound. */
  truncated: z.boolean(),
  /** Number of secret-looking spans replaced while producing `text`. */
  secretsRedacted: z.number().int().min(0),
  /** Optional non-sensitive label, e.g. a MIME type or tool name. */
  label: nonEmptyStringSchema.optional(),
});
export type ContentFact = z.infer<typeof contentFactSchema>;

export const contentFactsSchema = z.array(contentFactSchema).max(64);

/**
 * Guard used in tests and at the sink boundary: an omitted fact must not carry
 * text, and a disclosing fact must carry it.
 */
export const isContentFactConsistent = (fact: ContentFact): boolean =>
  fact.disclosure === "omitted" ? fact.text === undefined : fact.text !== undefined;
