import { createServer, type IncomingHttpHeaders, type Server } from "node:http";

/**
 * A real (ephemeral, local-only) HTTP server standing in for a collector, so a
 * test exercises the sink's actual OTLP HTTP/protobuf delivery path instead of
 * only an in-memory double. Not a daemon: created and torn down within a test.
 *
 * The request path is captured alongside the body because the two signals are
 * separated by nothing else: an `ExportLogsServiceRequest` posted to `/v1/traces`
 * would be a configuration bug this fixture is one of the few places that can
 * actually observe.
 */
export type CapturedRequest = {
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
  /** Request path, e.g. `/v1/traces` or `/v1/logs`. */
  readonly path: string;
};

export type CapturingCollector = {
  /** Origin with no signal path, for deriving per-signal endpoints. */
  readonly baseUrl: string;
  /** Conventional traces endpoint. `url` is its alias, for existing callers. */
  readonly url: string;
  readonly logsUrl: string;
  readonly requests: readonly CapturedRequest[];
  bodies(): readonly Buffer[];
  /** Bodies posted to one signal path only. */
  bodiesFor(path: string): readonly Buffer[];
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
      const request = {
        headers: req.headers,
        body: Buffer.concat(chunks),
        path: req.url ?? "",
      };
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
  const baseUrl = `http://127.0.0.1:${String(address.port)}`;
  return {
    baseUrl,
    url: `${baseUrl}/v1/traces`,
    logsUrl: `${baseUrl}/v1/logs`,
    requests,
    bodies: (): readonly Buffer[] => requests.map((request) => request.body),
    bodiesFor: (path: string): readonly Buffer[] =>
      requests.filter((request) => request.path === path).map((request) => request.body),
    close: (): Promise<void> => new Promise((resolve) => server.close(() => resolve())),
  };
};
