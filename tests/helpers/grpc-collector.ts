import * as grpc from "@grpc/grpc-js";

/**
 * In-process OTLP/gRPC `TraceService/Export` receiver.
 *
 * The same idea as the HTTP capturing collector: the official exporter speaks
 * its real client to a real server on localhost. This is not the OpenTelemetry
 * Collector distribution — that path lives next to the test that starts it.
 */

const TRACE_EXPORT_PATH = "/opentelemetry.proto.collector.trace.v1.TraceService/Export";

export type GrpcCapturedRequest = {
  readonly body: Buffer;
  readonly metadata: Readonly<Record<string, string>>;
};

export type GrpcExportDecision =
  | { readonly action: "ok" }
  | { readonly action: "status"; readonly code: number }
  /** Never answer, so the client's deadline is what ends the call. */
  | { readonly action: "hold" };

type ExportCall = {
  request: Buffer;
  metadata: grpc.Metadata;
};

export type GrpcTraceReceiver = {
  /** Plaintext base URL (`http://127.0.0.1:<port>`). The path is not part of it. */
  readonly url: string;
  readonly requests: readonly GrpcCapturedRequest[];
  close(): Promise<void>;
};

export const startGrpcTraceReceiver = async (
  decide: (request: GrpcCapturedRequest) => GrpcExportDecision = () => ({ action: "ok" }),
): Promise<GrpcTraceReceiver> => {
  const requests: GrpcCapturedRequest[] = [];
  const server = new grpc.Server();
  const service = {
    export: {
      path: TRACE_EXPORT_PATH,
      requestStream: false,
      responseStream: false,
      requestSerialize: (value: Buffer): Buffer => value,
      requestDeserialize: (value: Buffer): Buffer => value,
      responseSerialize: (value: Buffer): Buffer => value,
      responseDeserialize: (value: Buffer): Buffer => value,
    },
  };
  server.addService(service, {
    export: (call: ExportCall, callback: grpc.sendUnaryData<Buffer>): void => {
      const metadata: Record<string, string> = {};
      for (const [key, value] of Object.entries(call.metadata.getMap())) {
        metadata[key] = typeof value === "string" ? value : value.toString("utf8");
      }
      const request: GrpcCapturedRequest = { body: Buffer.from(call.request), metadata };
      requests.push(request);
      const decision = decide(request);
      if (decision.action === "hold") {
        return;
      }
      if (decision.action === "status") {
        callback({
          name: "Error",
          message: "export rejected",
          code: decision.code,
          details: "export rejected",
        });
        return;
      }
      callback(null, Buffer.alloc(0));
    },
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (error, bound) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(bound);
    });
  });

  return {
    url: `http://127.0.0.1:${String(port)}`,
    requests,
    close: (): Promise<void> => {
      server.forceShutdown();
      return Promise.resolve();
    },
  };
};
