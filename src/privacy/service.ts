import { createHash } from "node:crypto";

import type { ContentFact, ContentKind, ContentRole } from "../model/content.js";
import { isValidExtensionKey } from "../model/extensions.js";
import {
  attributeValueSchema,
  MAX_ATTRIBUTE_ARRAY_LENGTH,
  MAX_ATTRIBUTE_STRING_LENGTH,
  type AttributePrimitive,
  type Attributes,
  type AttributeValue,
} from "../model/primitives.js";
import {
  CONTENT_MODE_DISCLOSURE,
  resolvePrivacyPolicy,
  type PrivacyLimits,
  type PrivacyPolicy,
} from "./policy.js";

export type SanitizedValue =
  | string
  | number
  | boolean
  | null
  | readonly SanitizedValue[]
  | { readonly [key: string]: SanitizedValue };

export type SanitizeStats = {
  readonly truncatedStrings: number;
  readonly truncatedArrays: number;
  readonly truncatedObjects: number;
  readonly redactedKeys: number;
  readonly depthExceeded: number;
  readonly droppedValues: number;
  readonly circularReferences: number;
};

export type SanitizeResult = {
  readonly value: SanitizedValue;
  readonly stats: SanitizeStats;
};

export type DescribeContentInput = {
  readonly kind: ContentKind;
  readonly text: string;
  readonly role?: ContentRole;
  readonly label?: string;
};

export type DescribeStructuredInput = {
  readonly kind: ContentKind;
  readonly value: unknown;
  readonly role?: ContentRole;
  readonly label?: string;
};

export type SanitizeExtensionsResult = {
  readonly extensions: Record<string, AttributeValue>;
  readonly droppedKeys: readonly string[];
};

/**
 * Single point through which every piece of potentially sensitive data passes.
 *
 * Provider adapters receive this service and are expected to describe content
 * with it rather than copying text into events themselves. That keeps the
 * disclosure decision in one auditable place.
 */
export interface PrivacyService {
  readonly policy: PrivacyPolicy;
  /** Notes about deterministic policy downgrades applied at construction. */
  readonly policyNotes: readonly string[];
  /** Stable salted digest, formatted `sha256:<hex>`. */
  hash(value: string): string;
  /** Opaque namespaced handle suitable for a workspace or resource id. */
  deriveOpaqueId(namespace: string, value: string): string;
  describeContent(input: DescribeContentInput): ContentFact;
  /**
   * A content fact for a kind the event can carry when the provider sent no
   * text. Distinct from describing an empty string: there is nothing to
   * disclose under any content mode, so the fact is always omitted.
   */
  describeUnavailableContent(input: Omit<DescribeContentInput, "text">): ContentFact;
  describeStructured(input: DescribeStructuredInput): ContentFact;
  isSecretKey(key: string): boolean;
  sanitizeStructured(value: unknown): SanitizeResult;
  /** Attribute-safe projection of a sanitized value, with dotted paths. */
  flattenToAttributes(value: SanitizedValue, prefix: string): Attributes;
  sanitizeAttributes(value: Readonly<Record<string, unknown>>): Attributes;
  sanitizeExtensions(value: Readonly<Record<string, unknown>>): SanitizeExtensionsResult;
  /** Bound a string to the policy limit, reporting whether it was cut. */
  boundString(value: string): { readonly text: string; readonly truncated: boolean };
}

const compilePatterns = (sources: readonly string[], flags: string): readonly RegExp[] => {
  const compiled: RegExp[] = [];
  for (const source of sources) {
    try {
      compiled.push(new RegExp(source, flags));
    } catch {
      // An unusable pattern must not disable the whole privacy service; the
      // remaining patterns still apply. Skipping is the conservative choice for
      // key patterns only because a bad pattern would otherwise match nothing
      // anyway.
      continue;
    }
  }
  return compiled;
};

const codePointLength = (value: string): number => [...value].length;

const isSanitizedArray = (value: SanitizedValue): value is readonly SanitizedValue[] =>
  Array.isArray(value);

const sliceCodePoints = (value: string, max: number): string => {
  if (max <= 0) {
    return "";
  }
  let result = "";
  let count = 0;
  for (const char of value) {
    if (count >= max) {
      break;
    }
    result += char;
    count += 1;
  }
  return result;
};

const stableStringify = (value: unknown): string => {
  const seen = new WeakSet<object>();
  const walk = (input: unknown): string => {
    if (input === null) {
      return "null";
    }
    if (typeof input === "string") {
      return JSON.stringify(input);
    }
    if (typeof input === "number") {
      return Number.isFinite(input) ? JSON.stringify(input) : "null";
    }
    if (typeof input === "boolean") {
      return input ? "true" : "false";
    }
    if (typeof input === "bigint") {
      return JSON.stringify(input.toString());
    }
    if (typeof input !== "object") {
      return "null";
    }
    if (seen.has(input)) {
      return '"<circular>"';
    }
    seen.add(input);
    if (Array.isArray(input)) {
      return `[${input.map((entry) => walk(entry)).join(",")}]`;
    }
    const record = input as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${walk(record[key])}`)
      .join(",")}}`;
  };
  return walk(value);
};

type MutableStats = {
  truncatedStrings: number;
  truncatedArrays: number;
  truncatedObjects: number;
  redactedKeys: number;
  depthExceeded: number;
  droppedValues: number;
  circularReferences: number;
};

const emptyStats = (): MutableStats => ({
  truncatedStrings: 0,
  truncatedArrays: 0,
  truncatedObjects: 0,
  redactedKeys: 0,
  depthExceeded: 0,
  droppedValues: 0,
  circularReferences: 0,
});

export const createPrivacyService = (policyInput: PrivacyPolicy): PrivacyService => {
  const { policy, notes } = resolvePrivacyPolicy(policyInput);
  const limits: PrivacyLimits = policy.limits;
  const secretKeyPatterns = compilePatterns(policy.secretKeyPatterns, "i");
  const secretValuePatterns = compilePatterns(policy.secretValuePatterns, "g");

  const hash = (value: string): string =>
    `sha256:${createHash("sha256").update(policy.hashSalt).update("\0").update(value, "utf8").digest("hex")}`;

  const isSecretKey = (key: string): boolean =>
    secretKeyPatterns.some((pattern) => pattern.test(key));

  const boundString = (value: string): { text: string; truncated: boolean } => {
    const length = codePointLength(value);
    if (length <= limits.maxStringLength) {
      return { text: value, truncated: false };
    }
    return { text: sliceCodePoints(value, limits.maxStringLength), truncated: true };
  };

  const redactSecretSpans = (value: string): { text: string; count: number } => {
    let count = 0;
    let text = value;
    for (const pattern of secretValuePatterns) {
      text = text.replace(new RegExp(pattern.source, pattern.flags), () => {
        count += 1;
        return policy.redactionPlaceholder;
      });
    }
    return { text, count };
  };

  const maskText = (value: string): string =>
    Array.from(value, (char) => (/\s/.test(char) ? char : policy.maskCharacter)).join("");

  const disclose = (
    original: string,
  ): { text: string | undefined; truncated: boolean; secretsRedacted: number } => {
    switch (policy.contentMode) {
      case "omit":
        return { text: undefined, truncated: false, secretsRedacted: 0 };
      case "mask": {
        const bounded = boundString(original);
        return { text: maskText(bounded.text), truncated: bounded.truncated, secretsRedacted: 0 };
      }
      case "redact": {
        const redacted = redactSecretSpans(original);
        const bounded = boundString(redacted.text);
        return {
          text: bounded.text,
          truncated: bounded.truncated,
          secretsRedacted: redacted.count,
        };
      }
      case "raw": {
        const bounded = boundString(original);
        return { text: bounded.text, truncated: bounded.truncated, secretsRedacted: 0 };
      }
    }
  };

  const describeText = (input: DescribeContentInput): ContentFact => {
    const disclosed = disclose(input.text);
    return {
      kind: input.kind,
      ...(input.role === undefined ? {} : { role: input.role }),
      characterLength: codePointLength(input.text),
      byteLength: Buffer.byteLength(input.text, "utf8"),
      contentHash: hash(input.text),
      disclosure: CONTENT_MODE_DISCLOSURE[policy.contentMode],
      ...(disclosed.text === undefined ? {} : { text: disclosed.text }),
      truncated: disclosed.truncated,
      secretsRedacted: disclosed.secretsRedacted,
      ...(input.label === undefined ? {} : { label: input.label }),
    };
  };

  const sanitizeValue = (value: unknown, depth: number, stats: MutableStats, seen: WeakSet<object>): SanitizedValue => {
    if (value === null) {
      return null;
    }
    switch (typeof value) {
      case "string": {
        const bounded = boundString(value);
        if (bounded.truncated) {
          stats.truncatedStrings += 1;
        }
        return bounded.text;
      }
      case "number":
        if (!Number.isFinite(value)) {
          stats.droppedValues += 1;
          return null;
        }
        return value;
      case "boolean":
        return value;
      case "bigint":
        return value.toString();
      case "undefined":
      case "function":
      case "symbol":
        stats.droppedValues += 1;
        return null;
      default:
        break;
    }

    if (depth >= limits.maxDepth) {
      stats.depthExceeded += 1;
      return "<depth-exceeded>";
    }
    if (seen.has(value)) {
      stats.circularReferences += 1;
      return "<circular>";
    }
    seen.add(value);

    if (Array.isArray(value)) {
      const entries = value.slice(0, limits.maxArrayLength);
      if (value.length > limits.maxArrayLength) {
        stats.truncatedArrays += 1;
      }
      return entries.map((entry) => sanitizeValue(entry, depth + 1, stats, seen));
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    const retained = keys.slice(0, limits.maxObjectKeys);
    if (keys.length > limits.maxObjectKeys) {
      stats.truncatedObjects += 1;
    }
    const result: Record<string, SanitizedValue> = {};
    for (const key of retained) {
      if (isSecretKey(key)) {
        stats.redactedKeys += 1;
        result[key] = policy.redactionPlaceholder;
        continue;
      }
      result[key] = sanitizeValue(record[key], depth + 1, stats, seen);
    }
    return result;
  };

  const sanitizeStructured = (value: unknown): SanitizeResult => {
    const stats = emptyStats();
    const sanitized = sanitizeValue(value, 0, stats, new WeakSet<object>());
    return { value: sanitized, stats };
  };

  const toAttributePrimitive = (value: SanitizedValue): AttributePrimitive | undefined => {
    if (typeof value === "string") {
      return value.slice(0, MAX_ATTRIBUTE_STRING_LENGTH);
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return value;
    }
    return undefined;
  };

  const flattenToAttributes = (value: SanitizedValue, prefix: string): Attributes => {
    const attributes: Record<string, AttributeValue> = {};
    const walk = (current: SanitizedValue, path: string): void => {
      if (
        typeof current === "string" ||
        typeof current === "number" ||
        typeof current === "boolean"
      ) {
        const primitive = toAttributePrimitive(current);
        if (primitive !== undefined) {
          attributes[path] = primitive;
        }
        return;
      }
      if (current === null) {
        return;
      }
      if (isSanitizedArray(current)) {
        const primitives: AttributePrimitive[] = [];
        let uniform = true;
        for (const entry of current) {
          const entryPrimitive = toAttributePrimitive(entry);
          if (entryPrimitive === undefined) {
            uniform = false;
            break;
          }
          primitives.push(entryPrimitive);
        }
        if (uniform) {
          attributes[path] = primitives.slice(0, MAX_ATTRIBUTE_ARRAY_LENGTH);
          return;
        }
        for (const [index, entry] of current.entries()) {
          walk(entry, `${path}.${index}`);
        }
        return;
      }
      for (const [key, entry] of Object.entries(current)) {
        walk(entry, path === "" ? key : `${path}.${key}`);
      }
    };
    walk(value, prefix);
    return attributes;
  };

  const sanitizeAttributes = (value: Readonly<Record<string, unknown>>): Attributes => {
    const attributes: Record<string, AttributeValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (isSecretKey(key)) {
        attributes[key] = policy.redactionPlaceholder;
        continue;
      }
      const sanitized = sanitizeStructured(entry).value;
      const primitive = toAttributePrimitive(sanitized);
      if (primitive !== undefined) {
        attributes[key] = primitive;
        continue;
      }
      const flattened = flattenToAttributes(sanitized, key);
      Object.assign(attributes, flattened);
    }
    return attributes;
  };

  const sanitizeExtensions = (
    value: Readonly<Record<string, unknown>>,
  ): SanitizeExtensionsResult => {
    const extensions: Record<string, AttributeValue> = {};
    const droppedKeys: string[] = [];
    for (const [key, entry] of Object.entries(value)) {
      if (!isValidExtensionKey(key)) {
        droppedKeys.push(key);
        continue;
      }
      if (isSecretKey(key)) {
        extensions[key] = policy.redactionPlaceholder;
        continue;
      }
      const sanitized = sanitizeStructured(entry).value;
      const candidate = attributeValueSchema.safeParse(sanitized);
      if (candidate.success) {
        extensions[key] = candidate.data;
      } else {
        droppedKeys.push(key);
      }
    }
    return { extensions, droppedKeys };
  };

  return {
    policy,
    policyNotes: notes,
    hash,
    deriveOpaqueId: (namespace: string, value: string): string =>
      hash(`${namespace}\0${value}`),
    describeContent: describeText,
    describeUnavailableContent: (input: Omit<DescribeContentInput, "text">): ContentFact => ({
      kind: input.kind,
      ...(input.role === undefined ? {} : { role: input.role }),
      characterLength: 0,
      byteLength: 0,
      contentHash: hash(""),
      disclosure: "omitted",
      truncated: false,
      secretsRedacted: 0,
      ...(input.label === undefined ? {} : { label: input.label }),
    }),
    describeStructured: (input: DescribeStructuredInput): ContentFact => {
      const serialized = stableStringify(input.value);
      const sanitized = sanitizeStructured(input.value);
      const base = describeText({
        kind: input.kind,
        text: serialized,
        ...(input.role === undefined ? {} : { role: input.role }),
        ...(input.label === undefined ? {} : { label: input.label }),
      });
      if (base.text === undefined) {
        return base;
      }
      // Disclose the sanitized projection rather than the raw serialization, so
      // secret-keyed values never appear even in `raw` mode.
      const disclosed = disclose(stableStringify(sanitized.value));
      return {
        ...base,
        ...(disclosed.text === undefined ? {} : { text: disclosed.text }),
        truncated: base.truncated || disclosed.truncated,
        secretsRedacted: disclosed.secretsRedacted + sanitized.stats.redactedKeys,
      };
    },
    isSecretKey,
    sanitizeStructured,
    flattenToAttributes,
    sanitizeAttributes,
    sanitizeExtensions,
    boundString,
  };
};
