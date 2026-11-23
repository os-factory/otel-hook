/**
 * OTLP/HTTP endpoint URLs per signal, as the OpenTelemetry exporter
 * specification defines them.
 *
 * - `OTEL_EXPORTER_OTLP_ENDPOINT` is a **base** URL: the signal path
 *   (`/v1/traces`, `/v1/logs`) is appended to it.
 * - `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`
 *   are full URLs, used as they are.
 *
 * One compatibility rule: earlier releases read `OTEL_EXPORTER_OTLP_ENDPOINT`
 * as the full traces URL. A base URL that already ends in `/v1/traces` is
 * therefore taken to be that full URL, not a base to append to, so an existing
 * `…/v1/traces` value keeps posting where it did.
 */

/**
 * The standard endpoint variables. `generic` and `logs` also appear in
 * `ENVIRONMENT_VARIABLES`; `traces` does not, because that list is guarded
 * against identity-looking (`TRACE`) names.
 */
export const OTLP_ENDPOINT_VARIABLES = Object.freeze({
  generic: "OTEL_EXPORTER_OTLP_ENDPOINT",
  traces: "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  logs: "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
});

export const OTLP_TRACES_PATH = "/v1/traces";
export const OTLP_LOGS_PATH = "/v1/logs";

export type OtlpSignal = "traces" | "logs";

/**
 * Strip trailing slashes, by scan rather than by regex.
 *
 * `/\/+$/` is a polynomial-ReDoS on this input: an endpoint of many `/` followed by
 * anything else makes the engine retry the `+` from every position. The endpoint is
 * operator-supplied configuration bounded to 2048 characters, so the practical cost
 * is small — but a linear scan is just as short, and the bound is not the guarantee.
 */
export const withoutTrailingSlashes = (value: string): string => {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) {
    end -= 1;
  }
  return value.slice(0, end);
};

/**
 * The URL a signal posts to, given an `OTEL_EXPORTER_OTLP_ENDPOINT` base.
 *
 * Trailing slashes on the base are dropped before the signal path is appended,
 * so `https://host/otlp` and `https://host/otlp/` both give
 * `https://host/otlp/v1/traces`. A base ending in `/v1/traces` (the legacy
 * full-URL form) is used as-is for traces and has that suffix swapped for
 * `/v1/logs` for logs.
 */
export const otlpSignalEndpointFromBase = (base: string, signal: OtlpSignal): string => {
  const trimmed = withoutTrailingSlashes(base);
  if (trimmed.endsWith(OTLP_TRACES_PATH)) {
    return signal === "traces"
      ? trimmed
      : `${trimmed.slice(0, trimmed.length - OTLP_TRACES_PATH.length)}${OTLP_LOGS_PATH}`;
  }
  return `${trimmed}${signal === "traces" ? OTLP_TRACES_PATH : OTLP_LOGS_PATH}`;
};
