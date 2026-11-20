/**
 * Whether a failed OTLP export should be written to the durable spool.
 *
 * The table is the OTLP exporter retry specification, and it is applied the
 * same way to HTTP/protobuf and gRPC. The spool stores canonical spans, not a
 * transport frame, so a batch refused by one protocol is replayable on the
 * other — which is only safe if both protocols agree about which failures are
 * worth replaying.
 *
 * Retryable:
 *
 * - gRPC status codes CANCELLED (1), DEADLINE_EXCEEDED (4), RESOURCE_EXHAUSTED
 *   (8), ABORTED (10), OUT_OF_RANGE (11), UNAVAILABLE (14), DATA_LOSS (15)
 * - HTTP 429, 502, 503, 504
 * - a transport that already reported the failure as retryable
 * - a failure with no status code (connection refused, an unclassified
 *   timeout). Dropping it would lose a batch the collector never accepted.
 *
 * A classified terminal status — HTTP 400, gRPC INVALID_ARGUMENT, and the
 * rest of each table — is not spooled. Replaying it fails the same way until
 * the spool fills.
 */

export type ExportFailureClass = "retryable" | "terminal";

const GRPC_RETRYABLE_STATUS_CODES: ReadonlySet<number> = new Set([1, 4, 8, 10, 11, 14, 15]);
const HTTP_RETRYABLE_STATUS_CODES: ReadonlySet<number> = new Set([429, 502, 503, 504]);

const numericCode = (error: unknown): number | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "number" && Number.isInteger(code) ? code : undefined;
};

export const classifyExportFailure = (error: unknown): ExportFailureClass => {
  if (error instanceof Error && error.message.includes("retryable status")) {
    return "retryable";
  }
  const code = numericCode(error);
  if (code === undefined) {
    return "retryable";
  }
  // HTTP status codes and gRPC status codes share the small integers only on
  // paper: every HTTP status this exporter can observe is >= 100.
  if (code >= 100) {
    return HTTP_RETRYABLE_STATUS_CODES.has(code) ? "retryable" : "terminal";
  }
  return GRPC_RETRYABLE_STATUS_CODES.has(code) ? "retryable" : "terminal";
};
