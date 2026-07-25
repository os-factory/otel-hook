import { createHash } from "node:crypto";

/**
 * Segments derived from arbitrary strings must be safe path components on any
 * filesystem: no separators, no traversal, no reserved characters. Anything
 * that already looks safe is kept as-is (for readable directory names);
 * anything else is replaced by a stable hash so no input can escape its
 * namespace directory or collide with a sibling by accident.
 */
const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export const isSafeSegment = (segment: string): boolean => SAFE_SEGMENT_PATTERN.test(segment);

export const sanitizeSegment = (segment: string): string => {
  if (isSafeSegment(segment)) {
    return segment;
  }
  return `h_${createHash("sha256").update(segment, "utf8").digest("hex").slice(0, 32)}`;
};

/** Scopes a state store to one provider deployed under one installation. */
export type StoreNamespace = {
  readonly providerId: string;
  readonly installationId: string;
};

export const namespaceSegments = (namespace: StoreNamespace): readonly [string, string] => [
  sanitizeSegment(namespace.providerId),
  sanitizeSegment(namespace.installationId),
];

/** Stable, collision-resistant digest of a logical state key. */
export const keyDigest = (key: string): string =>
  createHash("sha256").update(key, "utf8").digest("hex");
