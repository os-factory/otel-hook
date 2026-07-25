import { z } from "zod";

/** Maximum length accepted for short identifier-like strings. */
export const MAX_IDENTIFIER_LENGTH = 256;

/** Maximum length accepted for a single string attribute value. */
export const MAX_ATTRIBUTE_STRING_LENGTH = 4096;

/** Maximum number of entries accepted in an attribute array value. */
export const MAX_ATTRIBUTE_ARRAY_LENGTH = 128;

export const nonEmptyStringSchema = z.string().min(1).max(MAX_IDENTIFIER_LENGTH);

/** Wall-clock time as whole milliseconds since the Unix epoch. */
export const epochMillisSchema = z.number().int().min(0).max(8_640_000_000_000_000);
export type EpochMillis = z.infer<typeof epochMillisSchema>;

/** Non-negative duration in milliseconds; may be fractional. */
export const durationMillisSchema = z.number().min(0).finite();

/** Token counts are always non-negative integers. */
export const tokenCountSchema = z.number().int().min(0);

/** Monotonically increasing per-invocation ordering key. */
export const sequenceNumberSchema = z.number().int().min(0);

const brandedIdSchema = (): z.ZodString => z.string().min(1).max(MAX_IDENTIFIER_LENGTH);

export const invocationIdSchema = brandedIdSchema().brand<"InvocationId">();
export type InvocationId = z.infer<typeof invocationIdSchema>;

export const sessionIdSchema = brandedIdSchema().brand<"SessionId">();
export type SessionId = z.infer<typeof sessionIdSchema>;

export const eventIdSchema = brandedIdSchema().brand<"EventId">();
export type EventId = z.infer<typeof eventIdSchema>;

/**
 * Workspace identifiers are opaque, privacy-safe handles of the form
 * `<scheme>:<token>`. Filesystem paths cannot satisfy this pattern, which keeps
 * home directories and repository paths out of telemetry by construction.
 */
export const WORKSPACE_ID_PATTERN = /^[a-z][a-z0-9]{0,15}:[A-Za-z0-9_-]{8,128}$/;
export const workspaceIdSchema = z
  .string()
  .regex(WORKSPACE_ID_PATTERN, "workspace id must be an opaque `<scheme>:<token>` handle")
  .brand<"WorkspaceId">();
export type WorkspaceId = z.infer<typeof workspaceIdSchema>;

/** Provider ids are lowercase, hyphenated, and stable across releases. */
export const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const providerIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(PROVIDER_ID_PATTERN, "provider id must be lowercase and hyphenated")
  .brand<"ProviderId">();
export type ProviderId = z.infer<typeof providerIdSchema>;

/** Sentinel used whenever the source provider could not be established. */
export const UNKNOWN_PROVIDER_ID = "unknown" as const;
export type UnknownProviderId = typeof UNKNOWN_PROVIDER_ID;

export const resolvedProviderIdSchema = z.union([
  providerIdSchema,
  z.literal(UNKNOWN_PROVIDER_ID),
]);
export type ResolvedProviderId = z.infer<typeof resolvedProviderIdSchema>;

export const isUnknownProvider = (value: ResolvedProviderId): value is UnknownProviderId =>
  value === UNKNOWN_PROVIDER_ID;

/**
 * Attribute values are restricted to OpenTelemetry-compatible primitives.
 *
 * This restriction is a containment boundary, not a convenience: because no
 * nested object can be represented, a raw provider payload cannot be smuggled
 * out of an adapter through attributes or extensions.
 */
export const attributePrimitiveSchema = z.union([
  z.string().max(MAX_ATTRIBUTE_STRING_LENGTH),
  z.number().finite(),
  z.boolean(),
]);
export type AttributePrimitive = z.infer<typeof attributePrimitiveSchema>;

export const attributeValueSchema = z.union([
  attributePrimitiveSchema,
  z.array(attributePrimitiveSchema).max(MAX_ATTRIBUTE_ARRAY_LENGTH),
]);
export type AttributeValue = z.infer<typeof attributeValueSchema>;

export const attributesSchema = z.record(z.string().min(1).max(MAX_IDENTIFIER_LENGTH), attributeValueSchema);
export type Attributes = z.infer<typeof attributesSchema>;

/** Ordered confidence ladder for provider detection. */
export const detectionConfidenceSchema = z.enum(["none", "weak", "strong", "exact"]);
export type DetectionConfidence = z.infer<typeof detectionConfidenceSchema>;

export const DETECTION_CONFIDENCE_RANK: Readonly<Record<DetectionConfidence, number>> =
  Object.freeze({
    none: 0,
    weak: 1,
    strong: 2,
    exact: 3,
  });

export const compareDetectionConfidence = (a: DetectionConfidence, b: DetectionConfidence): number =>
  DETECTION_CONFIDENCE_RANK[a] - DETECTION_CONFIDENCE_RANK[b];

/** How the observed data reached this process. */
export const sourceTransportSchema = z.enum([
  "hook-stdin",
  "cli-argument",
  "library-call",
  "test-fixture",
]);
export type SourceTransport = z.infer<typeof sourceTransportSchema>;
