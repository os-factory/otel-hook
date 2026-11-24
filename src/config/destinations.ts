import { z } from "zod";

import { isUnsafeHeaderValue } from "./header-value.js";
import { MAX_OTLP_HEADERS } from "./otlp-headers.js";
import type { ExporterPolicy } from "./schema.js";

/**
 * Export destinations: one batch, several OTLP endpoints.
 *
 * otel-hook is not a long-running process, so it cannot sit behind a proxy that
 * fans out for it. Instead every enabled destination is sent the same batch by the
 * same short-lived process, and what a destination could not take is kept in that
 * destination's own spool for the next invocation.
 *
 * ## The `default` destination
 *
 * The single-endpoint settings that predate this list — `exporter.endpoint`,
 * `exporter.logs.endpoint`, `exporter.protocol`, `--header`, and the standard
 * `OTEL_EXPORTER_OTLP_*` variables that feed them — describe one destination
 * named `default`. The name is therefore reserved: a `destinations[]` entry may
 * not take it, so there is exactly one place that destination is configured.
 *
 * A configuration with no `destinations` resolves to that one destination and
 * nothing else, exactly as before the list existed.
 */

export const DEFAULT_DESTINATION_NAME = "default";

/**
 * Destination names become directory names (each destination spools on its own),
 * so they are held to a lowercase, filesystem-safe vocabulary rather than being
 * sanitized into something an operator would not recognize.
 */
export const DESTINATION_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export const MAX_EXPORT_DESTINATIONS = 16;
/** The same bound `OTEL_EXPORTER_OTLP_*HEADERS` and `exporter.headerNames` have. */
export const MAX_DESTINATION_HEADERS = MAX_OTLP_HEADERS;

/** Prefix of a header value that names an environment variable instead of holding a value. */
export const HEADER_ENV_REFERENCE_PREFIX = "env:";

/** RFC 9110 `token`: the characters a header field name may use. */
const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
const ENV_VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_HEADER_VALUE_LENGTH = 8_192;

export const exportSignalSchema = z.enum(["traces", "logs"]);
export type ExportSignal = z.infer<typeof exportSignalSchema>;

const headerValueSchema = z
  .string()
  .min(1)
  .max(MAX_HEADER_VALUE_LENGTH)
  // The rule `OTEL_EXPORTER_OTLP_*HEADERS` values are held to: a line break is a
  // request-splitting vector, and other controls or non-Latin-1 characters would
  // only make Node's HTTP client throw at send time.
  .refine(
    (value) => !isUnsafeHeaderValue(value),
    "header values may not contain line breaks, control characters, or characters beyond Latin-1",
  )
  .refine(
    (value) =>
      !value.startsWith(HEADER_ENV_REFERENCE_PREFIX) ||
      ENV_VARIABLE_NAME_PATTERN.test(value.slice(HEADER_ENV_REFERENCE_PREFIX.length)),
    "an env: header reference must name an environment variable, e.g. env:COLLECTOR_TOKEN",
  );

const endpointSchema = z.string().url().max(2048);

export const exportDestinationSchema = z
  .strictObject({
    /** Unique, lowercase, filesystem-safe. `default` is reserved for the single-endpoint settings. */
    name: z
      .string()
      .regex(DESTINATION_NAME_PATTERN, "destination names are lowercase letters, digits, _ and -"),
    /** Default true. A disabled destination is neither sent to nor drained. */
    enabled: z.boolean().optional(),
    /**
     * Traces URL, with the same meaning as `exporter.endpoint`: the logs URL is
     * derived from it (`/v1/traces` becomes `/v1/logs`) unless `logsEndpoint` is set.
     */
    endpoint: endpointSchema.optional(),
    /** Per-signal override of `endpoint` for traces. */
    tracesEndpoint: endpointSchema.optional(),
    /** Per-signal override of the derived logs URL. */
    logsEndpoint: endpointSchema.optional(),
    /** Defaults to `exporter.protocol`. */
    protocol: z.enum(["http/protobuf", "http/json", "none"]).optional(),
    /**
     * Header name to value. A value of the form `env:NAME` is read from that
     * environment variable at send time, so a credential never has to be written
     * into the file. Values never appear in a snapshot, a diagnostic, or `doctor`.
     */
    headers: z
      .record(z.string().regex(HEADER_NAME_PATTERN, "not a valid header name"), headerValueSchema)
      .refine(
        (headers) => Object.keys(headers).length <= MAX_DESTINATION_HEADERS,
        `at most ${String(MAX_DESTINATION_HEADERS)} headers per destination`,
      )
      .optional(),
    /**
     * Which signals this destination receives. Default: both. The logs signal is
     * still governed by `exporter.logs.enabled`, which stays the one opt-in for a
     * second stream leaving the host.
     */
    signals: z.array(exportSignalSchema).min(1).max(2).readonly().optional(),
  })
  .refine(
    (destination) =>
      destination.endpoint !== undefined ||
      destination.tracesEndpoint !== undefined ||
      destination.logsEndpoint !== undefined,
    "a destination needs an endpoint, or a tracesEndpoint / logsEndpoint",
  );
export type ExportDestinationConfig = z.infer<typeof exportDestinationSchema>;

export const exportDestinationsSchema = z
  .array(exportDestinationSchema)
  .max(MAX_EXPORT_DESTINATIONS)
  .readonly()
  .superRefine((destinations, context) => {
    const seen = new Set<string>();
    destinations.forEach((destination, index) => {
      if (destination.name === DEFAULT_DESTINATION_NAME) {
        context.addIssue({
          code: "custom",
          path: [index, "name"],
          message:
            'the name "default" is reserved for exporter.endpoint and the OTEL_EXPORTER_OTLP_* variables',
        });
      }
      if (seen.has(destination.name)) {
        context.addIssue({
          code: "custom",
          path: [index, "name"],
          message: `duplicate destination name "${destination.name}"`,
        });
      }
      seen.add(destination.name);
    });
  });

/**
 * Bounds on each destination's retry spool, per signal.
 *
 * Every destination spools independently, so one long outage can only ever cost
 * its own budget. When a bound is reached the *oldest* batches are dropped first —
 * a recent batch is the one a reader is still likely to look for — and every drop
 * is counted on disk so `doctor` can report it.
 */
export const spoolPolicySchema = z.strictObject({
  /** Total bytes of queued batches. Default 16 MiB. */
  maxBytes: z.number().int().min(1_024).max(1_073_741_824),
  /** A batch older than this is dropped instead of sent. Default 72 hours. */
  maxAgeMillis: z.number().int().min(1_000).max(30 * 24 * 60 * 60 * 1000),
  /** Number of queued batches. Default 500. */
  maxBatches: z.number().int().min(1).max(65_536),
});
export type SpoolPolicy = z.infer<typeof spoolPolicySchema>;

export const DEFAULT_SPOOL_POLICY: SpoolPolicy = Object.freeze({
  maxBytes: 16 * 1024 * 1024,
  maxAgeMillis: 72 * 60 * 60 * 1000,
  maxBatches: 500,
});

/** The spool policy in force, with defaults filled in for any bound left unset. */
export const effectiveSpoolPolicy = (exporter: ExporterPolicy): SpoolPolicy => ({
  maxBytes: exporter.spool?.maxBytes ?? DEFAULT_SPOOL_POLICY.maxBytes,
  maxAgeMillis: exporter.spool?.maxAgeMillis ?? DEFAULT_SPOOL_POLICY.maxAgeMillis,
  maxBatches: exporter.spool?.maxBatches ?? DEFAULT_SPOOL_POLICY.maxBatches,
});

/**
 * One destination as the runtime sends to it.
 *
 * `headers` holds what the configuration holds — literal values and `env:`
 * references, unresolved. Resolution against an environment happens only at the
 * point of sending ({@link resolveDestinationHeaders}), and the `default`
 * destination's header values never pass through configuration at all: they are
 * handed to the runtime separately, as they always have been.
 */
export type ExportDestination = {
  readonly name: string;
  /** `exporter` for the `default` destination, `destinations` for a list entry. */
  readonly source: "exporter" | "destinations";
  readonly protocol: ExporterPolicy["protocol"];
  /** Traces URL as configured; for `default` this is `exporter.endpoint`. */
  readonly endpoint?: string;
  readonly tracesEndpoint?: string;
  readonly logsEndpoint?: string;
  readonly signals: { readonly traces: boolean; readonly logs: boolean };
  readonly headers: Readonly<Record<string, string>>;
};

const legacyDestination = (exporter: ExporterPolicy): ExportDestination => ({
  name: DEFAULT_DESTINATION_NAME,
  source: "exporter",
  protocol: exporter.protocol,
  ...(exporter.endpoint === undefined ? {} : { endpoint: exporter.endpoint }),
  ...(exporter.logs.endpoint === undefined ? {} : { logsEndpoint: exporter.logs.endpoint }),
  signals: { traces: true, logs: exporter.logs.enabled },
  headers: {},
});

/** Whether a configuration uses the destination list at all. */
export const hasConfiguredDestinations = (exporter: ExporterPolicy): boolean =>
  exporter.destinations !== undefined && exporter.destinations.length > 0;

/**
 * The destinations an exporter policy sends to, in a stable order: `default`
 * first when present, then the list in file order.
 *
 * - No `destinations`: exactly one `default` destination, even when it has no
 *   endpoint — the sink then reports itself unconfigured, as it always has.
 * - With `destinations`: `default` is included only when a single-endpoint setting
 *   actually names an endpoint, and disabled entries are left out.
 */
export const resolveExportDestinations = (
  exporter: ExporterPolicy,
): readonly ExportDestination[] => {
  if (!hasConfiguredDestinations(exporter)) {
    return [legacyDestination(exporter)];
  }
  const resolved: ExportDestination[] = [];
  if (exporter.endpoint !== undefined || exporter.logs.endpoint !== undefined) {
    resolved.push(legacyDestination(exporter));
  }
  for (const destination of exporter.destinations ?? []) {
    if (destination.enabled === false) {
      continue;
    }
    const signals = destination.signals ?? exportSignalSchema.options;
    resolved.push({
      name: destination.name,
      source: "destinations",
      protocol: destination.protocol ?? exporter.protocol,
      ...(destination.endpoint === undefined ? {} : { endpoint: destination.endpoint }),
      ...(destination.tracesEndpoint === undefined
        ? {}
        : { tracesEndpoint: destination.tracesEndpoint }),
      ...(destination.logsEndpoint === undefined ? {} : { logsEndpoint: destination.logsEndpoint }),
      signals: {
        traces: signals.includes("traces"),
        logs: exporter.logs.enabled && signals.includes("logs"),
      },
      headers: { ...(destination.headers ?? {}) },
    });
  }
  return resolved;
};

/** A header value's meaning, without its content. */
export type HeaderValueReference =
  | { readonly kind: "literal" }
  | { readonly kind: "env"; readonly variable: string };

export const parseHeaderValueReference = (value: string): HeaderValueReference =>
  value.startsWith(HEADER_ENV_REFERENCE_PREFIX)
    ? { kind: "env", variable: value.slice(HEADER_ENV_REFERENCE_PREFIX.length) }
    : { kind: "literal" };

export type ResolvedDestinationHeaders = {
  /** Header values ready to send. Never logged, never reported. */
  readonly values: Readonly<Record<string, string>>;
  /** Names of referenced environment variables that are unset or empty. */
  readonly missingVariables: readonly string[];
};

/**
 * Resolve `env:` references against an explicitly supplied environment.
 *
 * Pure: the process environment is never read implicitly. An unset or empty
 * variable is reported by *name* — the only part of a reference that is safe to
 * say out loud — and its header is left out of `values`.
 */
export const resolveDestinationHeaders = (
  headers: Readonly<Record<string, string>>,
  environment: Readonly<Record<string, string | undefined>> | undefined,
): ResolvedDestinationHeaders => {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const reference = parseHeaderValueReference(value);
    if (reference.kind === "literal") {
      values[name] = value;
      continue;
    }
    const resolved = environment?.[reference.variable];
    if (resolved === undefined || resolved === "") {
      missing.push(reference.variable);
      continue;
    }
    values[name] = resolved;
  }
  return { values, missingVariables: [...new Set(missing)].sort() };
};

/**
 * Attribute-safe description of one destination: names, origins, and variable
 * names. Never a header value, and never an endpoint beyond its origin.
 */
export type DestinationDescription = {
  readonly name: string;
  readonly enabled: boolean;
  readonly protocol: ExporterPolicy["protocol"];
  readonly signals: readonly ExportSignal[];
  readonly tracesEndpointOrigin?: string;
  readonly logsEndpointOrigin?: string;
  readonly headerNames: readonly string[];
  /** Environment variables this destination's headers reference. */
  readonly headerVariables: readonly string[];
};

export const endpointOrigin = (endpoint: string | undefined): string | undefined => {
  if (endpoint === undefined) {
    return undefined;
  }
  try {
    return new URL(endpoint).origin;
  } catch {
    return "<unparsable>";
  }
};

/** Every configured destination, disabled ones included, for `doctor` and snapshots. */
export const describeExportDestinations = (
  exporter: ExporterPolicy,
): readonly DestinationDescription[] => {
  const describe = (
    destination: ExportDestination,
    enabled: boolean,
  ): DestinationDescription => {
    const tracesOrigin = endpointOrigin(destination.tracesEndpoint ?? destination.endpoint);
    const logsOrigin = endpointOrigin(
      destination.logsEndpoint ?? destination.endpoint ?? destination.tracesEndpoint,
    );
    const variables = Object.values(destination.headers)
      .map(parseHeaderValueReference)
      .flatMap((reference) => (reference.kind === "env" ? [reference.variable] : []));
    return {
      name: destination.name,
      enabled,
      protocol: destination.protocol,
      signals: exportSignalSchema.options.filter((signal) => destination.signals[signal]),
      ...(tracesOrigin === undefined || !destination.signals.traces
        ? {}
        : { tracesEndpointOrigin: tracesOrigin }),
      ...(logsOrigin === undefined || !destination.signals.logs
        ? {}
        : { logsEndpointOrigin: logsOrigin }),
      headerNames:
        destination.source === "exporter"
          ? [...exporter.headerNames].sort()
          : Object.keys(destination.headers).sort(),
      headerVariables: [...new Set(variables)].sort(),
    };
  };
  const enabled = resolveExportDestinations(exporter).map((destination) =>
    describe(destination, true),
  );
  const disabled = (exporter.destinations ?? [])
    .filter((destination) => destination.enabled === false)
    .map((destination) =>
      describe(
        {
          name: destination.name,
          source: "destinations",
          protocol: destination.protocol ?? exporter.protocol,
          ...(destination.endpoint === undefined ? {} : { endpoint: destination.endpoint }),
          signals: { traces: false, logs: false },
          headers: { ...(destination.headers ?? {}) },
        },
        false,
      ),
    );
  return [...enabled, ...disabled];
};
