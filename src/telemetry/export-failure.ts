import type { ExportResult } from "@opentelemetry/core";

/**
 * HTTP statuses that mean "try again later" rather than "never send this".
 *
 * The OTLP specification's retryable set (429, 502, 503, 504), plus:
 *
 * - 408, which is a timeout by another name;
 * - 500, by decision for this project: a backend that is restarting, overloaded,
 *   or briefly broken commonly answers 500, and losing those batches costs more
 *   than retrying them. A backend that answers 500 *forever* cannot pin a batch
 *   in the spool: every spooled batch is still subject to the spool's age,
 *   size, and count bounds (`exporter.spool`), and is dropped and counted when
 *   it exceeds them.
 *
 * Anything else the server answered with a status for is a refusal of *this
 * batch*: replaying it can only fail the same way, and a spool that kept it would
 * retry it on every invocation and stop behind it.
 */
export const RETRYABLE_HTTP_STATUSES: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Whether a failed export was a permanent refusal.
 *
 * With `@opentelemetry/otlp-exporter-base` (OpenTelemetry JS 3.x), the HTTP
 * transport reports a status outside its own retryable set (429, 502, 503, 504)
 * as an `OTLPExporterError` whose numeric `code` is the HTTP status — so 400,
 * 401, 408, 413, and 500 all arrive with a `code`, and 408 and 500 are then held
 * retryable here. Its retryable statuses are retried inside the exporter and,
 * once retries or the timeout run out, arrive without a `code`, as do a refused
 * connection, a timeout, and an oversized response. Those are exactly the "never
 * reached it, or asked us to come back" failures a spool is for.
 */
export const isPermanentExportFailure = (result: ExportResult): boolean => {
  const code = (result.error as { readonly code?: unknown } | undefined)?.code;
  return (
    typeof code === "number" &&
    Number.isInteger(code) &&
    code >= 400 &&
    code < 600 &&
    !RETRYABLE_HTTP_STATUSES.has(code)
  );
};
