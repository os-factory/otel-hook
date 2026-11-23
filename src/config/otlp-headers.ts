/**
 * The standard OTLP exporter header variables.
 *
 * `OTEL_EXPORTER_OTLP_HEADERS` applies to every signal;
 * `OTEL_EXPORTER_OTLP_TRACES_HEADERS` and `OTEL_EXPORTER_OTLP_LOGS_HEADERS`
 * apply to one signal each. They exist so a credential (`authorization=Basic …`)
 * can reach the exporter without being written on a command line, where `ps` and
 * `/proc/<pid>/cmdline` would show it to every local user.
 *
 * Header *values* never enter configuration. Parsing returns them to the caller,
 * which hands them straight to the sink at construction; configuration carries
 * header *names* only (`exporter.headerNames`), because a resolved-config
 * snapshot is logged and exported. Every diagnostic here names an entry by its
 * position and the variable by its name — never a key, never a value — because a
 * malformed entry may be the secret itself (`Basic abc` with no `=`).
 */

/** Upper bound on headers per variable, matching `exporter.headerNames`. */
export const MAX_OTLP_HEADERS = 32;

export const OTLP_HEADER_VARIABLES = Object.freeze({
  generic: "OTEL_EXPORTER_OTLP_HEADERS",
  traces: "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
  logs: "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
});

/** RFC 9110 `token`: the characters an HTTP field name may contain. */
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * Characters an HTTP field value must not contain once decoded. CR and LF would
 * split the request; the other controls and anything beyond Latin-1 are refused
 * by Node's HTTP client anyway, and refusing them here turns a failed export into
 * a reported, skipped entry.
 */
const isUnsafeHeaderValue = (value: string): boolean =>
  [...value].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return (code < 0x20 && code !== 0x09) || code === 0x7f || code > 0xff;
  });

export type ParsedOtlpHeaders = {
  readonly headers: Readonly<Record<string, string>>;
  /** Position-only explanations; never a key or a value. */
  readonly warnings: readonly string[];
};

const decode = (raw: string): string | undefined => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
};

/**
 * Parse one `OTEL_EXPORTER_OTLP_*HEADERS` value.
 *
 * The OpenTelemetry exporter specification defines the format as W3C
 * Baggage-like: comma-separated `key=value` pairs, surrounding whitespace
 * trimmed, keys and values percent-decoded. So `authorization=Basic%20abc` is
 * the header `authorization: Basic abc`, and a `,` inside a value must be
 * written `%2C`. A malformed entry is skipped and reported; the rest of the
 * variable still applies. A repeated key takes its last value.
 */
export const parseOtlpHeadersValue = (raw: string): ParsedOtlpHeaders => {
  const headers: Record<string, string> = {};
  const warnings: string[] = [];
  let overflowed = false;

  for (const [index, rawEntry] of raw.split(",").entries()) {
    const position = String(index + 1);
    const entry = rawEntry.trim();
    if (entry === "") {
      continue;
    }
    const equals = entry.indexOf("=");
    if (equals <= 0) {
      warnings.push(`entry ${position} is not a key=value pair; ignored`);
      continue;
    }
    const key = decode(entry.slice(0, equals).trim());
    // Split on the first `=` only: a base64 credential ends in `=` padding.
    const value = decode(entry.slice(equals + 1).trim());
    if (key === undefined || value === undefined) {
      warnings.push(`entry ${position} has malformed percent-encoding; ignored`);
      continue;
    }
    const name = key.trim();
    const trimmedValue = value.trim();
    if (!HEADER_NAME_PATTERN.test(name)) {
      warnings.push(`entry ${position} does not name a valid HTTP header; ignored`);
      continue;
    }
    if (trimmedValue === "") {
      warnings.push(`entry ${position} has an empty value; ignored`);
      continue;
    }
    if (isUnsafeHeaderValue(trimmedValue)) {
      warnings.push(`entry ${position} has a character not allowed in an HTTP header value; ignored`);
      continue;
    }
    const existing = findHeaderName(headers, name);
    if (existing === undefined && Object.keys(headers).length >= MAX_OTLP_HEADERS) {
      overflowed = true;
      continue;
    }
    if (existing !== undefined) {
      delete headers[existing];
    }
    headers[name] = trimmedValue;
  }

  if (overflowed) {
    warnings.push(`more than ${String(MAX_OTLP_HEADERS)} headers were supplied; the excess was ignored`);
  }
  return { headers, warnings };
};

/** HTTP field names are case-insensitive: `Authorization` and `authorization` are one header. */
const findHeaderName = (headers: Readonly<Record<string, string>>, name: string): string | undefined => {
  const lower = name.toLowerCase();
  return Object.keys(headers).find((candidate) => candidate.toLowerCase() === lower);
};

/**
 * Overlay header maps, lowest precedence first, per header name.
 *
 * A higher source replaces only the names it sets (case-insensitively), so a
 * signal-specific variable can override `authorization` while a generic tenant
 * header still applies — the same per-key merge the OpenTelemetry SDKs apply.
 */
export const mergeOtlpHeaders = (
  ...sources: readonly Readonly<Record<string, string>>[]
): Readonly<Record<string, string>> => {
  const merged: Record<string, string> = {};
  for (const source of sources) {
    for (const [name, value] of Object.entries(source)) {
      const existing = findHeaderName(merged, name);
      if (existing !== undefined) {
        delete merged[existing];
      }
      merged[name] = value;
    }
  }
  return merged;
};

export type ResolvedOtlpHeaders = {
  /** Headers for the traces exporter. */
  readonly traces: Readonly<Record<string, string>>;
  /** Headers for the logs exporter. */
  readonly logs: Readonly<Record<string, string>>;
  /** Variable-qualified, value-free explanations of skipped entries. */
  readonly warnings: readonly { readonly variable: string; readonly detail: string }[];
};

/**
 * Resolve exporter headers per signal.
 *
 * Precedence, per header name, highest first:
 *
 * ```
 * explicit headers (--header)  >  OTEL_EXPORTER_OTLP_{TRACES,LOGS}_HEADERS  >  OTEL_EXPORTER_OTLP_HEADERS
 * ```
 *
 * Pure: the environment is passed in, never read from `process.env`.
 */
export const resolveOtlpHeaders = (
  env: Readonly<Record<string, string | undefined>>,
  explicit: Readonly<Record<string, string>> = {},
): ResolvedOtlpHeaders => {
  const warnings: { variable: string; detail: string }[] = [];
  const read = (variable: string): Readonly<Record<string, string>> => {
    const raw = env[variable];
    if (raw === undefined || raw.trim() === "") {
      return {};
    }
    const parsed = parseOtlpHeadersValue(raw);
    for (const detail of parsed.warnings) {
      warnings.push({ variable, detail });
    }
    return parsed.headers;
  };
  const generic = read(OTLP_HEADER_VARIABLES.generic);
  const traces = read(OTLP_HEADER_VARIABLES.traces);
  const logs = read(OTLP_HEADER_VARIABLES.logs);
  return {
    traces: mergeOtlpHeaders(generic, traces, explicit),
    logs: mergeOtlpHeaders(generic, logs, explicit),
    warnings,
  };
};

/**
 * Header names, deduplicated case-insensitively (first spelling kept), sorted
 * and bounded — the only part of a header that may enter configuration or a
 * diagnostic.
 */
export const unionOtlpHeaderNames = (...lists: readonly (readonly string[])[]): readonly string[] => {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const name of lists.flat()) {
    if (!seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      names.push(name);
    }
  }
  return names.sort().slice(0, MAX_OTLP_HEADERS);
};

/** {@link unionOtlpHeaderNames} over the names of header maps. */
export const describeOtlpHeaderNames = (
  ...sources: readonly Readonly<Record<string, string>>[]
): readonly string[] => unionOtlpHeaderNames(...sources.map((source) => Object.keys(source)));
