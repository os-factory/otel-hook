import { createServer, type IncomingHttpHeaders, type Server } from "node:http";

/**
 * A real (ephemeral, local-only) HTTP server standing in for a collector, so a
 * test exercises the sink's actual OTLP HTTP/protobuf delivery path instead of
 * only an in-memory double. Not a daemon: created and torn down within a test.
 */
export type CapturedRequest = { readonly headers: IncomingHttpHeaders; readonly body: Buffer };

export type CapturingCollector = {
  readonly url: string;
  readonly requests: readonly CapturedRequest[];
  bodies(): readonly Buffer[];
  close(): Promise<void>;
};

export const startCapturingCollector = async (
  respond: (request: CapturedRequest) => { readonly status: number } = () => ({ status: 200 }),
): Promise<CapturingCollector> => {
  const requests: CapturedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const request = { headers: req.headers, body: Buffer.concat(chunks) };
      requests.push(request);
      const { status } = respond(request);
      res.writeHead(status);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("failed to bind the capturing collector");
  }
  return {
    url: `http://127.0.0.1:${String(address.port)}/v1/traces`,
    requests,
    bodies: (): readonly Buffer[] => requests.map((request) => request.body),
    close: (): Promise<void> => new Promise((resolve) => server.close(() => resolve())),
  };
};
