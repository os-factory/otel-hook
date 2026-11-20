import { createRequire } from "node:module";

import type { ExportResult } from "@opentelemetry/core";
import { OTLPTraceExporter as OTLPHttpTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";

import type { ExporterPolicy } from "../config/schema.js";

const require = createRequire(import.meta.url);

/**
 * The slice of an OTLP trace exporter the sink actually calls.
 *
 * Kept structural so the HTTP and gRPC clients — different classes, same
 * contract — can sit behind one spool. The spool never sees which one it is.
 */
export type TraceBatchExporter = {
  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
};

type GrpcTraceExporterConstructor = new (config?: {
  readonly url?: string;
  readonly metadata?: { set(key: string, value: string): void };
  readonly timeoutMillis?: number;
}) => TraceBatchExporter;

type GrpcMetadataConstructor = new () => { set(key: string, value: string): void };

/**
 * Build the trace exporter for the selected protocol.
 *
 * `@grpc/grpc-js` is loaded only when the protocol is `grpc`, and only from
 * inside this function. A top-level import would initialize gRPC before a
 * host's HTTP instrumentation can wrap it, and an HTTP-only installation
 * would pay for a client it never opens.
 *
 * Header values become gRPC metadata. The URL scheme selects the channel:
 * `http://` is plaintext and `https://` is TLS. The gRPC client ignores the
 * URL path; signal routing is the RPC name, not `/v1/traces`.
 */
export const createTraceBatchExporter = (
  exporter: ExporterPolicy,
  headers: Readonly<Record<string, string>> | undefined,
): TraceBatchExporter => {
  if (exporter.endpoint === undefined) {
    throw new Error("trace exporter requires an endpoint");
  }
  if (exporter.protocol === "grpc") {
    const grpcExporter = require("@opentelemetry/exporter-trace-otlp-grpc") as {
      OTLPTraceExporter: GrpcTraceExporterConstructor;
    };
    const grpc = require("@grpc/grpc-js") as { Metadata: GrpcMetadataConstructor };
    const metadata = new grpc.Metadata();
    for (const [key, value] of Object.entries(headers ?? {})) {
      metadata.set(key, value);
    }
    return new grpcExporter.OTLPTraceExporter({
      url: exporter.endpoint,
      metadata,
      timeoutMillis: exporter.timeoutMillis,
    });
  }
  return new OTLPHttpTraceExporter({
    url: exporter.endpoint,
    headers: { ...(headers ?? {}) },
    timeoutMillis: exporter.timeoutMillis,
  });
};
