/**
 * Attribute names otel-hook writes on its logs and spans, for consumers that
 * read the records. Has no runtime dependencies, so importing it does not
 * require the OpenTelemetry SDK.
 */
export * from "../telemetry/attribute-names.js";
