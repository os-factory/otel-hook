import { z } from "zod";

/**
 * Version of the canonical event model.
 *
 * Every emitted event carries this value. Consumers must treat an unknown
 * version as unreadable rather than guessing field semantics.
 *
 * Compatibility rules:
 * - Additive optional fields do not change the version.
 * - Renaming, removing, or re-interpreting a field increments the version.
 */
export const CANONICAL_SCHEMA_VERSION = 1 as const;

export type CanonicalSchemaVersion = typeof CANONICAL_SCHEMA_VERSION;

export const canonicalSchemaVersionSchema = z.literal(CANONICAL_SCHEMA_VERSION);
