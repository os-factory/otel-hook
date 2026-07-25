import type { PrivacyService } from "../privacy/service.js";

/**
 * Prefixes of environment variables a provider adapter may legitimately see.
 *
 * A hook inherits the developer's whole environment, which routinely holds
 * registry tokens, cloud credentials, and CI secrets. The adapter contract hands
 * `environment` to every `detect`/`identify` call, so passing `process.env`
 * straight through would make every adapter a potential disclosure path for
 * variables that have nothing to do with telemetry. The allow-list keeps that
 * capability scoped to variables about this library or the coding agents it
 * models.
 */
export const PROVIDER_VISIBLE_ENVIRONMENT_PREFIXES: readonly string[] = Object.freeze([
  "OTEL_",
  "CLAUDE_",
  "CURSOR_",
  "CODEX_",
  "GEMINI_",
  "ANTIGRAVITY_",
]);

/**
 * Variables inside an allowed prefix that still carry credentials.
 *
 * The OTLP `*_HEADERS` variables hold an `authorization=...` value verbatim.
 * They are named explicitly rather than left to the privacy service's key
 * heuristics, which look for `auth_header`-style words and do not match the
 * plural `HEADERS` spelling the OpenTelemetry specification uses.
 */
export const PROVIDER_HIDDEN_ENVIRONMENT_NAMES: readonly string[] = Object.freeze([
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
  "OTEL_EXPORTER_OTLP_METRICS_HEADERS",
  "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
]);

/**
 * Narrow the process environment to what adapters may observe.
 *
 * Three filters apply, in order: the name must match an allowed prefix, it must
 * not be one of the credential-carrying names above, and it must not look like a
 * secret according to the central privacy policy.
 */
export const providerVisibleEnvironment = (
  env: Readonly<Record<string, string | undefined>>,
  privacy: PrivacyService,
): Readonly<Record<string, string | undefined>> => {
  const visible: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(env)) {
    if (!PROVIDER_VISIBLE_ENVIRONMENT_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      continue;
    }
    if (PROVIDER_HIDDEN_ENVIRONMENT_NAMES.includes(name) || privacy.isSecretKey(name)) {
      continue;
    }
    visible[name] = value;
  }
  return Object.freeze(visible);
};
