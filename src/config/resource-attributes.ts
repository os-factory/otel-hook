import { z } from "zod";

import { MAX_IDENTIFIER_LENGTH } from "../model/primitives.js";
import { DEFAULT_SECRET_KEY_PATTERNS } from "../privacy/policy.js";

/**
 * Custom OTLP **resource** attributes: facts about the emitting deployment
 * (`deployment.environment`, `service.instance.id`, a tenant label) that belong
 * on every span this installation exports.
 *
 * These are deliberately *not* {@link ConsumerAttributes}. Consumer attributes
 * are opaque per-invocation metadata that travels with one observation's
 * identity and is sanitized by the privacy service; resource attributes are
 * per-process exporter policy, resolved from configuration layers, and describe
 * the producer rather than the observation. The two never share a field name, a
 * flag, or a code path — see ADR 0001 on keeping identity out of configuration.
 */

/** Upper bound on how many custom resource attributes one installation may set. */
export const MAX_RESOURCE_ATTRIBUTES = 64;
/** Upper bound on a resource attribute key, matching the OpenTelemetry guidance. */
export const MAX_RESOURCE_ATTRIBUTE_KEY_LENGTH = 255;
/** Upper bound on a resource attribute value; values are repeated on every export. */
export const MAX_RESOURCE_ATTRIBUTE_VALUE_LENGTH = 2048;

/**
 * Accepted shape of a resource attribute key.
 *
 * Deliberately narrower than "any string": a key becomes an attribute name on
 * the wire, so restricting it to the OpenTelemetry naming vocabulary keeps
 * newlines, control characters, and arbitrary binary out of the exported
 * resource by construction.
 */
export const RESOURCE_ATTRIBUTE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_./-]*$/;

/**
 * Keys that resource attributes may never set directly.
 *
 * `service.name` and `service.namespace` are typed exporter policy with their
 * own precedence chain and their own diagnostics. If a resource-attribute map
 * could also write them, the winner would depend on merge order inside the
 * exporter rather than on the documented configuration precedence — which is
 * exactly the silent override this reservation prevents. Supplying either one
 * through `OTEL_RESOURCE_ATTRIBUTES` still works: the environment parser routes
 * it to the policy field at a defined precedence instead of smuggling it into
 * the resource map.
 */
export const RESERVED_RESOURCE_ATTRIBUTE_KEYS: readonly string[] = Object.freeze([
  "service.name",
  "service.namespace",
]);

/** Case-insensitive: `Service.Name` is the same reservation, spelled differently. */
export const isReservedResourceAttributeKey = (key: string): boolean =>
  RESERVED_RESOURCE_ATTRIBUTE_KEYS.includes(key.toLowerCase());

const SECRET_KEY_MATCHERS: readonly RegExp[] = Object.freeze(
  DEFAULT_SECRET_KEY_PATTERNS.flatMap((source) => {
    try {
      return [new RegExp(source, "i")];
    } catch {
      return [];
    }
  }),
);

/**
 * Whether a key names something that should never be exported.
 *
 * A resource attribute is attached to *every* span, so `api_key=...` in a
 * config file or a shell profile would be the most durable possible leak. The
 * central privacy policy's key patterns are reused rather than re-invented, so
 * one list governs both content sanitization and this boundary.
 */
export const isSecretResourceAttributeKey = (key: string): boolean =>
  SECRET_KEY_MATCHERS.some((pattern) => pattern.test(key));

export type ResourceAttributeKeyRejection =
  | "empty"
  | "too-long"
  | "malformed"
  | "reserved"
  | "secret-like";

/** Non-sensitive explanations. None of these ever quotes an attribute *value*. */
export const RESOURCE_ATTRIBUTE_KEY_REJECTION_DETAIL: Readonly<
  Record<ResourceAttributeKeyRejection, string>
> = Object.freeze({
  empty: "resource attribute key is empty",
  "too-long": `resource attribute key exceeds ${String(MAX_RESOURCE_ATTRIBUTE_KEY_LENGTH)} characters`,
  malformed:
    "resource attribute key must start with a letter and use only letters, digits, and `_`, `.`, `-`, `/`",
  reserved:
    "service.name and service.namespace are exporter policy (--service-name / OTEL_HOOK_SERVICE_NAME), not resource attributes",
  "secret-like":
    "resource attribute key matches a secret-name pattern, so it is never exported",
});

/** Returns why a key is unusable, or `undefined` when it is acceptable. */
export const checkResourceAttributeKey = (
  key: string,
): ResourceAttributeKeyRejection | undefined => {
  if (key.length === 0) {
    return "empty";
  }
  if (key.length > MAX_RESOURCE_ATTRIBUTE_KEY_LENGTH) {
    return "too-long";
  }
  if (!RESOURCE_ATTRIBUTE_KEY_PATTERN.test(key)) {
    return "malformed";
  }
  if (isReservedResourceAttributeKey(key)) {
    return "reserved";
  }
  if (isSecretResourceAttributeKey(key)) {
    return "secret-like";
  }
  return undefined;
};

/**
 * Resource attribute values are single primitives, never arrays.
 *
 * `OTEL_RESOURCE_ATTRIBUTES` cannot express an array, and allowing one only in
 * the file layer would make per-key precedence depend on which layer supplied a
 * key. A single primitive keeps the merge total and order-independent.
 */
export const resourceAttributeValueSchema = z.union([
  z.string().max(MAX_RESOURCE_ATTRIBUTE_VALUE_LENGTH),
  z.number().finite(),
  z.boolean(),
]);
export type ResourceAttributeValue = z.infer<typeof resourceAttributeValueSchema>;

export const resourceAttributesSchema = z
  .record(z.string(), resourceAttributeValueSchema)
  .superRefine((value, ctx) => {
    const keys = Object.keys(value);
    if (keys.length > MAX_RESOURCE_ATTRIBUTES) {
      ctx.addIssue({
        code: "custom",
        message: `at most ${String(MAX_RESOURCE_ATTRIBUTES)} resource attributes are accepted`,
      });
    }
    for (const key of keys) {
      const rejection = checkResourceAttributeKey(key);
      if (rejection !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: RESOURCE_ATTRIBUTE_KEY_REJECTION_DETAIL[rejection],
        });
      }
    }
  })
  .readonly();
export type ResourceAttributes = z.infer<typeof resourceAttributesSchema>;

export const EMPTY_RESOURCE_ATTRIBUTES: ResourceAttributes = Object.freeze({});

export type ParsedResourceAttributes = {
  readonly attributes: Readonly<Record<string, string>>;
  /** `service.name`, routed to exporter policy rather than into `attributes`. */
  readonly serviceName?: string;
  /** `service.namespace`, routed the same way. */
  readonly serviceNamespace?: string;
  /**
   * Why entries were skipped. Every message identifies an entry by its
   * *position*, never by quoting the entry — an ambient environment variable
   * may hold anything, and a diagnostic that echoes it would publish it.
   */
  readonly warnings: readonly string[];
};

const stripSurroundingQuotes = (value: string): string =>
  value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;

/**
 * Parse the standard `OTEL_RESOURCE_ATTRIBUTES` variable.
 *
 * The OpenTelemetry specification defines this as W3C Baggage: comma-separated
 * `key=value` pairs, optional whitespace around each part, an optional
 * `;`-delimited metadata suffix that carries no attribute meaning, and
 * **percent-encoded values**. Escaping is the part naive parsers get wrong, and
 * it is load-bearing here: without it `deployment.note=a%2Cb` silently becomes
 * two malformed entries, and `region=eu%2Dwest` keeps a literal `%2D`.
 *
 * Every rejection is reported and skipped rather than failing the whole
 * variable: a stale entry in a shell profile must not cost an operator the
 * attributes they got right, and must never disable telemetry (ADR 0004).
 */
export const parseResourceAttributesValue = (raw: string): ParsedResourceAttributes => {
  const attributes: Record<string, string> = {};
  const warnings: string[] = [];
  let serviceName: string | undefined;
  let serviceNamespace: string | undefined;
  let overflowed = false;

  const entries = raw.split(",");
  for (const [index, rawEntry] of entries.entries()) {
    const position = index + 1;
    // Baggage metadata (`key=value;prop=1`) carries no attribute meaning.
    const entry = (rawEntry.split(";")[0] ?? "").trim();
    if (entry === "") {
      continue;
    }

    const equals = entry.indexOf("=");
    if (equals <= 0) {
      warnings.push(`entry ${String(position)} is not a key=value pair`);
      continue;
    }
    const key = entry.slice(0, equals).trim();
    // Split on the *first* `=` only: a percent-decoded value may legitimately
    // contain one, and re-joining would be lossy.
    const encoded = stripSurroundingQuotes(entry.slice(equals + 1).trim());
    let value: string;
    try {
      value = decodeURIComponent(encoded);
    } catch {
      warnings.push(`entry ${String(position)} has a malformed percent-encoded value`);
      continue;
    }

    if (isReservedResourceAttributeKey(key)) {
      if (value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH) {
        warnings.push(
          `entry ${String(position)} sets ${key.toLowerCase()} to an empty or over-long value`,
        );
        continue;
      }
      if (key.toLowerCase() === "service.name") {
        serviceName = value;
      } else {
        serviceNamespace = value;
      }
      continue;
    }

    const rejection = checkResourceAttributeKey(key);
    if (rejection !== undefined) {
      warnings.push(
        `entry ${String(position)} was skipped: ${RESOURCE_ATTRIBUTE_KEY_REJECTION_DETAIL[rejection]}`,
      );
      continue;
    }
    if (value.length > MAX_RESOURCE_ATTRIBUTE_VALUE_LENGTH) {
      // Dropped rather than truncated: a silently shortened attribute value is
      // a wrong fact, which is worse than a missing one.
      warnings.push(
        `entry ${String(position)} has a value longer than ${String(MAX_RESOURCE_ATTRIBUTE_VALUE_LENGTH)} characters`,
      );
      continue;
    }
    if (!(key in attributes) && Object.keys(attributes).length >= MAX_RESOURCE_ATTRIBUTES) {
      overflowed = true;
      continue;
    }
    // A repeated key takes its last value, matching every other layer here.
    attributes[key] = value;
  }

  if (overflowed) {
    warnings.push(
      `more than ${String(MAX_RESOURCE_ATTRIBUTES)} resource attributes were supplied; the excess was dropped`,
    );
  }

  return {
    attributes,
    ...(serviceName === undefined ? {} : { serviceName }),
    ...(serviceNamespace === undefined ? {} : { serviceNamespace }),
    warnings,
  };
};

/**
 * Drop anything that must not reach the exported resource.
 *
 * The schema already refuses these keys, but a {@link ExporterPolicy} can also
 * be hand-built by a library caller who never ran it through the schema. This
 * is the last gate before the wire, so it filters rather than trusts.
 */
export const sanitizeResourceAttributes = (
  attributes: ResourceAttributes,
): Readonly<Record<string, ResourceAttributeValue>> => {
  const safe: Record<string, ResourceAttributeValue> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (checkResourceAttributeKey(key) !== undefined) {
      continue;
    }
    if (Object.keys(safe).length >= MAX_RESOURCE_ATTRIBUTES) {
      break;
    }
    safe[key] = value;
  }
  return safe;
};

/**
 * Attribute *names* only, for a logged or exported configuration snapshot.
 *
 * Names are safe to disclose because they are already part of every exported
 * resource; values are not disclosed, because a value is the half an operator
 * may have filled with something they would not want in a log line.
 */
export const describeResourceAttributeNames = (
  attributes: ResourceAttributes,
): readonly string[] => Object.keys(attributes).sort();
