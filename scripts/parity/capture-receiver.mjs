#!/usr/bin/env node
// A local OTLP/HTTP receiver that appends every request it accepts to a capture
// file (see otlp-capture.mjs for the format). It is the durable counterpart of
// the agent-lab collector: point a provider's native exporter at one receiver
// and otel-hook at another, run one session, and compare the two files with
// native-telemetry-parity.mjs.
//
// Usage:
//   node scripts/parity/capture-receiver.mjs --out native.otlp.jsonl [--port 4318] [--host 127.0.0.1]
//     [--side native|otel-hook] [--provider <id>] [--provider-version <v>]
//
// Accepts POST /v1/traces, /v1/logs and /v1/metrics in http/protobuf or
// http/json, gzip or not. gRPC is not supported: configure exporters for HTTP.
// Binds to loopback by default and never forwards anything. A capture of a real
// session holds real identifiers and possibly content: review and sanitize it
// before it goes anywhere near the repository (docs/native-telemetry-parity.md).

import { appendFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { parseArgs } from "node:util";

import { captureLine, signalOfPath } from "./otlp-capture.mjs";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    port: { type: "string", default: "4318" },
    host: { type: "string", default: "127.0.0.1" },
    side: { type: "string" },
    provider: { type: "string" },
    "provider-version": { type: "string" },
  },
});

if (values.out === undefined) {
  process.stderr.write("usage: capture-receiver.mjs --out <file.otlp.jsonl> [--port 4318] [--side native|otel-hook] [--provider <id>]\n");
  process.exit(2);
}

const out = values.out;
const meta = {
  capturedAt: new Date().toISOString(),
  synthetic: false,
  ...(values.side === undefined ? {} : { side: values.side }),
  ...(values.provider === undefined ? {} : { provider: values.provider }),
  ...(values["provider-version"] === undefined ? {} : { providerVersion: values["provider-version"] }),
};
await writeFile(out, `${JSON.stringify({ meta })}\n`, "utf8");

let pending = Promise.resolve();
let count = 0;

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const path = (req.url ?? "").split("?")[0];
    if (req.method !== "POST" || signalOfPath(path) === undefined) {
      res.writeHead(404);
      res.end();
      return;
    }
    const line = captureLine({
      receivedAt: new Date().toISOString(),
      path,
      contentType: req.headers["content-type"],
      contentEncoding: req.headers["content-encoding"],
      body: Buffer.concat(chunks),
    });
    pending = pending.then(() => appendFile(out, `${line}\n`, "utf8"));
    count += 1;
    // An empty success body is valid for both OTLP encodings.
    res.writeHead(200, { "content-type": req.headers["content-type"] ?? "application/x-protobuf" });
    res.end();
  });
});

server.listen(Number(values.port), values.host, () => {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : values.port;
  process.stdout.write(`capture-receiver listening on http://${values.host}:${String(port)} -> ${out}\n`);
});

const stop = () => {
  server.close(() => {
    void pending.then(() => {
      process.stdout.write(`capture-receiver wrote ${String(count)} request(s) to ${out}\n`);
      process.exit(0);
    });
  });
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
