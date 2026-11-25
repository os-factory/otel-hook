#!/usr/bin/env node
/**
 * Local OTLP/HTTP receiver that writes every request to disk.
 *
 * Test helper for the end-to-end proof runs (issue #56, docs/e2e-proof.md) and
 * the agent live lab. It is not a collector: it accepts OTLP/HTTP traces, logs and
 * metrics in either encoding (protobuf or JSON), answers, and records what arrived. It
 * never forwards anything anywhere.
 *
 * Capture directory layout (one pair per request, numbered in arrival order):
 *
 *   0001-traces.body   the raw request body, byte for byte (0 bytes if empty)
 *   0001-traces.json   metadata + decoded records (see `requestRecord` below)
 *   0002-metrics.body  `/v1/metrics` requests; `.json` holds one decoded entry per data point
 *   ...
 *   summary.json       written on close: counts per signal, empty bodies, statuses
 *
 * An empty body is recorded explicitly (`"empty": true`), never skipped: an
 * exporter that posts nothing is exactly the kind of evidence a proof run needs
 * (see #54, where 5 hook events produced 3 requests and one had an empty body).
 *
 * Failure injection (`failFirst`) answers the first N requests with
 * `failStatus` (503 by default) so a run can prove that a spooled batch is
 * replayed later: the checker matches records from failed requests against
 * later successful ones.
 *
 * Header values are never written: only header names, plus the scheme of an
 * `Authorization` header (`Basic`, `Bearer`), so a capture can show that auth
 * reached the receiver without holding the credential.
 *
 * CLI:
 *   node scripts/e2e-proof/otlp-receiver.mjs --capture-dir <dir>
 *     [--host 127.0.0.1] [--port 4318] [--fail-first N] [--fail-status 503]
 *     [--fail-signal traces|logs|metrics|all]
 *
 * Prints one JSON line `{"event":"listening",...}` on stdout once bound, one
 * line per request on stderr, and writes summary.json on SIGINT/SIGTERM, or
 * when stdin closes if `--stop-on-stdin-close` is given (Windows has no
 * catchable SIGTERM, so tests and launchers stop it that way).
 */

import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, inflateSync } from "node:zlib";

import { decodeOtlpRequest, isJsonContentType, jsonSafe, signalOfPath } from "./otlp-decode.mjs";

export const CAPTURE_FORMAT = "otel-hook.otlp-capture/v1";

const SAFE_HEADERS = new Set([
  "content-type",
  "content-encoding",
  "content-length",
  "user-agent",
  "accept",
  "accept-encoding",
]);

/** Header names, safe values, and only the scheme of an Authorization header. */
const describeHeaders = (headers) => {
  const described = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (SAFE_HEADERS.has(lower)) {
      described[lower] = Array.isArray(value) ? value.join(", ") : String(value ?? "");
    } else if (lower === "authorization") {
      const scheme = String(Array.isArray(value) ? value[0] : value ?? "").split(/\s+/)[0] ?? "";
      described[lower] = `<redacted${scheme.length > 0 && scheme.length <= 16 ? `:${scheme}` : ""}>`;
    } else {
      described[lower] = "<redacted>";
    }
  }
  return described;
};

const decompress = (body, encoding) => {
  const value = String(encoding ?? "").toLowerCase();
  if (body.length === 0 || value === "" || value === "identity") {
    return body;
  }
  if (value === "gzip") {
    return gunzipSync(body);
  }
  if (value === "deflate") {
    return inflateSync(body);
  }
  throw new Error(`unsupported content-encoding ${value}`);
};

const pad = (seq) => String(seq).padStart(4, "0");

/**
 * Start the receiver.
 *
 * @param {object} [options]
 * @param {string} [options.captureDir] directory to write requests to; in-memory only when omitted
 * @param {string} [options.host] bind address (default 127.0.0.1)
 * @param {number} [options.port] port (default 0: ephemeral)
 * @param {number} [options.failFirst] answer the first N matching requests with `failStatus`
 * @param {number} [options.failStatus] status for injected failures (default 503)
 * @param {"traces"|"logs"|"metrics"|"all"} [options.failSignal] which requests count toward `failFirst`
 * @param {(line: string) => void} [options.log] per-request log sink
 */
export const startOtlpReceiver = async (options = {}) => {
  const captureDir = options.captureDir;
  const failFirst = Math.max(0, Number(options.failFirst ?? 0));
  const failStatus = Number(options.failStatus ?? 503);
  const failSignal = options.failSignal ?? "all";
  const log = options.log ?? (() => {});

  if (captureDir !== undefined) {
    await mkdir(captureDir, { recursive: true });
  }

  const requests = [];
  const pending = new Set();
  let sequence = 0;
  let failed = 0;

  const persist = async (record, body) => {
    if (captureDir === undefined) {
      return;
    }
    const stem = `${pad(record.seq)}-${record.signal}`;
    await writeFile(path.join(captureDir, `${stem}.body`), body);
    await writeFile(path.join(captureDir, `${stem}.json`), `${JSON.stringify(record, jsonSafe, 2)}\n`);
  };

  const server = createServer((req, res) => {
    sequence += 1;
    const seq = sequence;
    const receivedAt = new Date().toISOString();
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const requestPath = req.url ?? "";
      const signal = signalOfPath(requestPath);
      const contentType = String(req.headers["content-type"] ?? "");
      const contentEncoding = String(req.headers["content-encoding"] ?? "");

      const eligible = failSignal === "all" || failSignal === signal;
      const injected = req.method === "POST" && eligible && failed < failFirst;
      if (injected) {
        failed += 1;
      }
      const status = req.method !== "POST" ? 405 : injected ? failStatus : 200;

      let decoded;
      let decodeError;
      let payload = body;
      try {
        payload = decompress(body, contentEncoding);
        decoded = decodeOtlpRequest({ signal, contentType, body: payload });
      } catch (error) {
        decodeError = error instanceof Error ? error.message : String(error);
      }

      const record = {
        format: CAPTURE_FORMAT,
        seq,
        receivedAt,
        method: req.method ?? "",
        path: requestPath,
        signal,
        contentType,
        contentEncoding,
        encoding: isJsonContentType(contentType) ? "json" : "protobuf",
        bytes: body.length,
        empty: body.length === 0,
        responseStatus: status,
        injectedFailure: injected,
        headers: describeHeaders(req.headers),
        counts: {
          spans: decoded?.spans.length ?? 0,
          logs: decoded?.logs.length ?? 0,
          metrics: decoded?.metrics.length ?? 0,
        },
        ...(decodeError === undefined ? {} : { decodeError }),
        decoded: decoded ?? null,
      };
      requests.push({ ...record, body: payload, rawBody: body });

      const write = persist(record, body)
        .catch((error) => {
          log(`otlp-receiver: failed to write request ${String(seq)}: ${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => pending.delete(write));
      pending.add(write);

      log(
        `otlp-receiver: #${String(seq)} ${req.method ?? ""} ${requestPath} ${String(body.length)}B` +
          `${body.length === 0 ? " EMPTY" : ""} spans=${String(record.counts.spans)} logs=${String(record.counts.logs)} metrics=${String(record.counts.metrics)}` +
          ` -> ${String(status)}${injected ? " (injected)" : ""}${decodeError === undefined ? "" : ` decode-error: ${decodeError}`}`,
      );

      const json = isJsonContentType(contentType);
      res.writeHead(status, { "content-type": json ? "application/json" : "application/x-protobuf" });
      // An empty ExportTrace/Logs/MetricsServiceResponse: `{}` in JSON, zero bytes in protobuf.
      res.end(json && status === 200 ? "{}" : undefined);
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(options.port ?? 0), options.host ?? "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("otlp receiver bound to an unexpected address");
  }
  const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
  const origin = `http://${host}:${String(address.port)}`;

  const summary = () => {
    const bySignal = {};
    for (const request of requests) {
      const entry = (bySignal[request.signal] ??= { requests: 0, empty: 0, spans: 0, logs: 0, metrics: 0 });
      entry.requests += 1;
      entry.empty += request.empty ? 1 : 0;
      entry.spans += request.counts.spans;
      entry.logs += request.counts.logs;
      entry.metrics += request.counts.metrics;
    }
    return {
      format: CAPTURE_FORMAT,
      requests: requests.length,
      emptyRequests: requests.filter((request) => request.empty).map((request) => request.seq),
      injectedFailures: requests.filter((request) => request.injectedFailure).map((request) => request.seq),
      statuses: requests.map((request) => ({ seq: request.seq, signal: request.signal, status: request.responseStatus })),
      bySignal,
    };
  };

  return {
    endpoint: origin,
    tracesUrl: `${origin}/v1/traces`,
    logsUrl: `${origin}/v1/logs`,
    metricsUrl: `${origin}/v1/metrics`,
    captureDir,
    /** In-memory copy of every request: metadata plus `body` (decompressed) and `rawBody`. */
    requests,
    bodiesFor: (signalPath) =>
      requests.filter((request) => request.path === signalPath).map((request) => request.body),
    latin1: () => Buffer.concat(requests.map((request) => request.body)).toString("latin1"),
    summary,
    /** Wait for every capture file to be written. */
    flush: async () => {
      await Promise.all([...pending]);
    },
    close: async () => {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await Promise.all([...pending]);
      if (captureDir !== undefined) {
        await writeFile(path.join(captureDir, "summary.json"), `${JSON.stringify(summary(), null, 2)}\n`);
      }
    },
  };
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `usage: otlp-receiver.mjs --capture-dir <dir> [--host 127.0.0.1] [--port 0]
                         [--fail-first N] [--fail-status 503] [--fail-signal traces|logs|metrics|all]
                         [--stop-on-stdin-close]`;

const parseArgs = (argv) => {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    const need = () => {
      if (value === undefined) {
        throw new Error(`${flag} needs a value`);
      }
      index += 1;
      return value;
    };
    switch (flag) {
      case "--capture-dir":
        options.captureDir = path.resolve(need());
        break;
      case "--host":
        options.host = need();
        break;
      case "--port":
        options.port = Number(need());
        break;
      case "--fail-first":
        options.failFirst = Number(need());
        break;
      case "--fail-status":
        options.failStatus = Number(need());
        break;
      case "--fail-signal": {
        const signal = need();
        if (!["traces", "logs", "metrics", "all"].includes(signal)) {
          throw new Error("--fail-signal expects traces, logs, metrics or all");
        }
        options.failSignal = signal;
        break;
      }
      case "--stop-on-stdin-close":
        options.stopOnStdinClose = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`unknown flag ${String(flag)}`);
    }
  }
  return options;
};

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
    process.exit(2);
  }
  if (options.help === true) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  if (options.captureDir === undefined) {
    process.stderr.write(`--capture-dir is required\n${USAGE}\n`);
    process.exit(2);
  }
  const { stopOnStdinClose, ...receiverOptions } = options;
  const receiver = await startOtlpReceiver({
    ...receiverOptions,
    log: (line) => process.stderr.write(`${line}\n`),
  });
  process.stdout.write(
    `${JSON.stringify({
      event: "listening",
      endpoint: receiver.endpoint,
      tracesUrl: receiver.tracesUrl,
      logsUrl: receiver.logsUrl,
      metricsUrl: receiver.metricsUrl,
      captureDir: receiver.captureDir,
    })}\n`,
  );
  let closing = false;
  const shutdown = async () => {
    if (closing) {
      return;
    }
    closing = true;
    await receiver.close();
    process.stdout.write(`${JSON.stringify({ event: "closed", ...receiver.summary() })}\n`);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  if (stopOnStdinClose === true) {
    process.stdin.on("end", () => void shutdown());
    process.stdin.resume();
  }
}
