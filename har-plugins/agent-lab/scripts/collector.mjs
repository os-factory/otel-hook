import { createServer } from "node:http";

/**
 * Local OTLP HTTP collector for the agent lab.
 *
 * Same shape as the e2e harness collector: capture raw protobuf bodies so
 * privacy assertions can search the bytes that left otel-hook.
 */
export const startLabCollector = async () => {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({
        path: req.url ?? "",
        body: Buffer.concat(chunks),
      });
      res.writeHead(200);
      res.end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("lab collector bound to an unexpected address");
  }
  const origin = `http://127.0.0.1:${String(address.port)}`;
  return {
    tracesUrl: `${origin}/v1/traces`,
    logsUrl: `${origin}/v1/logs`,
    requests,
    bodiesFor: (path) => requests.filter((request) => request.path === path).map((request) => request.body),
    latin1: () => Buffer.concat(requests.map((request) => request.body)).toString("latin1"),
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
};
