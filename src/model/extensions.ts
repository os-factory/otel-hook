import { z } from "zod";

import { attributeValueSchema, type AttributeValue } from "./primitives.js";

/**
 * Extension keys must be namespaced: at least one dot-separated segment before
 * the leaf, e.g. `acme.deployment-tier`. Namespacing keeps provider- and
 * consumer-specific fields from colliding with core fields or each other.
 */
export const EXTENSION_KEY_PATTERN =
  /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*)+$/;

/** Namespaces owned by the core model; extensions may not use them. */
export const RESERVED_EXTENSION_NAMESPACES: readonly string[] = Object.freeze([
  "otelhook",
  "otel",
  "telemetry",
]);

export const MAX_EXTENSION_ENTRIES = 64;

export const extensionKeyNamespace = (key: string): string => key.slice(0, key.indexOf("."));

export const isReservedExtensionNamespace = (key: string): boolean =>
  RESERVED_EXTENSION_NAMESPACES.includes(extensionKeyNamespace(key));

export const isValidExtensionKey = (key: string): boolean =>
  EXTENSION_KEY_PATTERN.test(key) && !isReservedExtensionNamespace(key);

/**
 * Namespaced extension bag.
 *
 * Values are restricted to attribute primitives, so extensions cannot carry
 * nested provider payloads.
 */
export const extensionsSchema = z
  .record(z.string(), attributeValueSchema)
  .check((ctx) => {
    const keys = Object.keys(ctx.value);
    if (keys.length > MAX_EXTENSION_ENTRIES) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        message: `extensions may contain at most ${MAX_EXTENSION_ENTRIES} entries`,
      });
    }
    for (const key of keys) {
      if (!EXTENSION_KEY_PATTERN.test(key)) {
        ctx.issues.push({
          code: "custom",
          input: ctx.value,
          path: [key],
          message: `extension key ${JSON.stringify(key)} must be namespaced, e.g. "acme.tier"`,
        });
        continue;
      }
      if (isReservedExtensionNamespace(key)) {
        ctx.issues.push({
          code: "custom",
          input: ctx.value,
          path: [key],
          message: `extension namespace ${JSON.stringify(extensionKeyNamespace(key))} is reserved`,
        });
      }
    }
  });

export type Extensions = Record<string, AttributeValue>;

export const EMPTY_EXTENSIONS: Extensions = Object.freeze({});

export const emptyExtensions = (): Extensions => ({});
