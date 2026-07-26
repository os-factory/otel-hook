import { z } from "zod";

import { createErrorInfo, type OtelHookErrorInfo } from "../errors/index.js";
import type { Attributes } from "../model/primitives.js";
import { describeResourceAttributeNames } from "./resource-attributes.js";
import {
  DEFAULT_CONFIG,
  otelHookConfigPatchSchema,
  otelHookConfigSchema,
  type OtelHookConfig,
  type OtelHookConfigPatch,
} from "./schema.js";

/**
 * Configuration layers, lowest precedence first.
 *
 * Precedence is fixed and total: `inline-override` beats `environment`, which
 * beats `file`, which beats `defaults`. There is no partial-merge surprise —
 * merging happens per leaf field, so a file may set an endpoint while the
 * environment sets only a content mode.
 *
 * `exporter.resourceAttributes` follows the same rule one level deeper: each
 * *attribute key* is its own leaf. A file may set `deployment.environment`
 * while `OTEL_RESOURCE_ATTRIBUTES` adds `service.instance.id` and
 * `--resource-attr` overrides just one of them; the result is the union, with
 * the highest-precedence layer winning per key and provenance recorded per key.
 * A layer cannot *remove* a key a lower layer set — precedence is an override
 * relation, not a replacement one.
 */
export const CONFIG_SOURCE_PRECEDENCE = ["defaults", "file", "environment", "inline-override"] as const;
export type ConfigSource = (typeof CONFIG_SOURCE_PRECEDENCE)[number];

export const configSourceSchema = z.enum(CONFIG_SOURCE_PRECEDENCE);

export type ConfigLayer = {
  readonly source: Exclude<ConfigSource, "defaults">;
  readonly patch: OtelHookConfigPatch;
  /** Non-sensitive origin label, e.g. a file name without its directory. */
  readonly origin?: string;
};

/** Which layer supplied each resolved leaf, keyed by `section.field` path. */
export type ConfigProvenance = Readonly<Record<string, ConfigSource>>;

export type ConfigResolution =
  | {
      readonly status: "ok";
      readonly config: OtelHookConfig;
      readonly provenance: ConfigProvenance;
      readonly notes: readonly string[];
    }
  | { readonly status: "invalid"; readonly errors: readonly OtelHookErrorInfo[] };

type PlainRecord = Record<string, unknown>;

const isPlainObject = (value: unknown): value is PlainRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const mergeLeaf = (
  target: PlainRecord,
  patch: PlainRecord,
  source: ConfigSource,
  provenance: Record<string, ConfigSource>,
  path: string,
): void => {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      continue;
    }
    const childPath = path === "" ? key : `${path}.${key}`;
    const existing = target[key];
    if (isPlainObject(value) && isPlainObject(existing)) {
      const child: PlainRecord = { ...existing };
      mergeLeaf(child, value, source, provenance, childPath);
      target[key] = child;
      continue;
    }
    target[key] = value;
    provenance[childPath] = source;
  }
};

const initialProvenance = (config: OtelHookConfig): Record<string, ConfigSource> => {
  const provenance: Record<string, ConfigSource> = {};
  const walk = (value: unknown, path: string): void => {
    if (isPlainObject(value)) {
      for (const [key, child] of Object.entries(value)) {
        walk(child, path === "" ? key : `${path}.${key}`);
      }
      return;
    }
    provenance[path] = "defaults";
  };
  walk(config, "");
  return provenance;
};

/**
 * Resolve configuration from layered patches.
 *
 * Invalid layers are rejected rather than partially applied: a half-applied
 * privacy policy is exactly the failure mode this contract exists to prevent.
 * Callers that must not fail hard should fall back to {@link DEFAULT_CONFIG},
 * which is always valid.
 */
export const resolveConfig = (layers: readonly ConfigLayer[] = []): ConfigResolution => {
  const errors: OtelHookErrorInfo[] = [];
  const ordered = [...layers].sort(
    (a, b) =>
      CONFIG_SOURCE_PRECEDENCE.indexOf(a.source) - CONFIG_SOURCE_PRECEDENCE.indexOf(b.source),
  );

  const validated: { source: ConfigSource; patch: PlainRecord }[] = [];
  for (const layer of ordered) {
    const parsed = otelHookConfigPatchSchema.safeParse(layer.patch);
    if (!parsed.success) {
      errors.push(
        createErrorInfo({
          code: "configuration-invalid",
          phase: "configuration",
          detail: `layer ${layer.source} rejected: ${parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "<root>"} ${issue.message}`)
            .join("; ")}`.slice(0, 480),
          details: {
            "config.layer": layer.source,
            ...(layer.origin === undefined ? {} : { "config.origin": layer.origin }),
          },
        }),
      );
      continue;
    }
    validated.push({ source: layer.source, patch: parsed.data });
  }

  if (errors.length > 0) {
    return { status: "invalid", errors };
  }

  const merged: PlainRecord = structuredClone(DEFAULT_CONFIG);
  const provenance = initialProvenance(DEFAULT_CONFIG);
  for (const layer of validated) {
    mergeLeaf(merged, layer.patch, layer.source, provenance, "");
  }

  const parsed = otelHookConfigSchema.safeParse(merged);
  if (!parsed.success) {
    return {
      status: "invalid",
      errors: [
        createErrorInfo({
          code: "configuration-invalid",
          phase: "configuration",
          detail: `merged configuration rejected: ${parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "<root>"} ${issue.message}`)
            .join("; ")}`.slice(0, 480),
        }),
      ],
    };
  }

  const notes: string[] = [];
  if (parsed.data.privacy.contentMode === "raw" && !parsed.data.privacy.allowRawContent) {
    notes.push("privacy.contentMode=raw will be downgraded to omit: allowRawContent is false");
  }
  if (parsed.data.exporter.enabled && parsed.data.exporter.protocol !== "none" && parsed.data.exporter.endpoint === undefined) {
    notes.push("exporter.enabled is true but no endpoint is configured");
  }

  return { status: "ok", config: parsed.data, provenance, notes };
};

/**
 * Attribute-safe snapshot of resolved configuration, for logging and telemetry.
 *
 * Endpoints are reduced to origin form and header values never appear, because a
 * snapshot is exported to the very system whose credentials it would leak.
 */
export const describeResolvedConfig = (config: OtelHookConfig): Attributes => {
  let endpointOrigin: string | undefined;
  if (config.exporter.endpoint !== undefined) {
    try {
      endpointOrigin = new URL(config.exporter.endpoint).origin;
    } catch {
      endpointOrigin = "<unparsable>";
    }
  }
  return {
    "exporter.enabled": config.exporter.enabled,
    "exporter.protocol": config.exporter.protocol,
    ...(endpointOrigin === undefined ? {} : { "exporter.endpoint_origin": endpointOrigin }),
    "exporter.header_names": [...config.exporter.headerNames],
    // Names only. A resource attribute *name* is already on the wire in every
    // exported resource, so disclosing it here adds nothing; a *value* may hold
    // whatever an operator put in a shell profile, so it never appears.
    "exporter.resource_attribute_names": [
      ...describeResourceAttributeNames(config.exporter.resourceAttributes),
    ],
    "exporter.timeout_millis": config.exporter.timeoutMillis,
    "exporter.max_batch_size": config.exporter.maxBatchSize,
    "exporter.service_name": config.exporter.serviceName,
    "privacy.content_mode": config.privacy.contentMode,
    "privacy.allow_raw_content": config.privacy.allowRawContent,
    "privacy.hash_salted": config.privacy.hashSalt.length > 0,
    "privacy.max_string_length": config.privacy.limits.maxStringLength,
    "privacy.max_depth": config.privacy.limits.maxDepth,
    "privacy.max_array_length": config.privacy.limits.maxArrayLength,
    "privacy.max_events_per_invocation": config.privacy.limits.maxEventsPerInvocation,
    "detection.minimum_confidence": config.detection.minimumConfidence,
    "detection.allow_ambiguous_fallback": config.detection.allowAmbiguousFallback,
    "diagnostics.log_level": config.diagnostics.logLevel,
    "diagnostics.emit_error_events": config.diagnostics.emitErrorEvents,
  };
};
