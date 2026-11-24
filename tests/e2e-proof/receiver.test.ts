import { readFile, readdir } from "node:fs/promises";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { makeTempDir, startReceiverProcess, type ReceiverProcess } from "./harness.js";

/**
 * The disk receiver used by the e2e proof runs (scripts/e2e-proof/otlp-receiver.mjs),
 * exercised as the process a proof run starts: it must write every request, raw
 * and decoded, record an empty body as such, inject the configured failures, and
 * never write a credential to disk.
 */

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const withReceiver = async (args: readonly string[]): Promise<{ receiver: ReceiverProcess; captureDir: string }> => {
  const temp = await makeTempDir("otel-hook-receiver-");
  cleanups.push(() => temp.remove());
  const captureDir = path.join(temp.dir, "capture");
  const receiver = await startReceiverProcess(["--capture-dir", captureDir, ...args]);
  cleanups.push(async () => {
    if (receiver.child.exitCode === null) {
      await receiver.stop();
    }
  });
  return { receiver, captureDir };
};

type Meta = {
  seq: number;
  signal: string;
  path: string;
  bytes: number;
  empty: boolean;
  responseStatus: number;
  injectedFailure: boolean;
  encoding: string;
  headers: Record<string, string>;
  counts: { spans: number; logs: number };
  decoded: { spans: { name: string; attributes: Record<string, unknown> }[]; logs: { attributes: Record<string, unknown> }[] } | null;
};

const readMeta = async (captureDir: string, stem: string): Promise<Meta> =>
  JSON.parse(await readFile(path.join(captureDir, `${stem}.json`), "utf8")) as Meta;

const SYNTHETIC_SECRET = "synthetic-langfuse-secret-do-not-write";

const jsonTraces = {
  resourceSpans: [
    {
      resource: { attributes: [{ key: "session.id", value: { stringValue: "har-receiver-test" } }] },
      scopeSpans: [
        {
          scope: { name: "@osfactory/otel-hook", version: "0.0.0-test" },
          spans: [
            {
              traceId: "0af7651916cd43dd8448eb211c80319c",
              spanId: "b7ad6b7169203331",
              name: "tool Read",
              startTimeUnixNano: "1780000000000000000",
              endTimeUnixNano: "1780000001000000000",
              attributes: [
                { key: "gen_ai.tool.name", value: { stringValue: "Read" } },
                { key: "gen_ai.usage.input_tokens", value: { intValue: "12" } },
              ],
            },
          ],
        },
      ],
    },
  ],
};

describe("otlp-receiver: writes every OTLP request to disk", () => {
  it("records raw and decoded bodies, empty bodies, injected failures, and redacts auth", async () => {
    const { receiver, captureDir } = await withReceiver(["--fail-first", "1", "--fail-status", "503"]);

    const empty = await fetch(receiver.tracesUrl, {
      method: "POST",
      headers: { "content-type": "application/x-protobuf" },
      body: new Uint8Array(0),
    });
    expect(empty.status).toBe(503);

    const traces = await fetch(receiver.tracesUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Basic ${SYNTHETIC_SECRET}` },
      body: JSON.stringify(jsonTraces),
    });
    expect(traces.status).toBe(200);
    expect(await traces.text()).toBe("{}");

    const logs = await fetch(`${receiver.endpoint}/api/public/otel/v1/logs`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-langfuse-key": SYNTHETIC_SECRET },
      body: JSON.stringify({
        resourceLogs: [
          {
            resource: { attributes: [] },
            scopeLogs: [{ scope: { name: "s" }, logRecords: [{ attributes: [{ key: "otelhook.event.type", value: { stringValue: "session.start" } }] }] }],
          },
        ],
      }),
    });
    expect(logs.status).toBe(200);

    const closed = await receiver.stop();
    expect(closed).toMatchObject({ event: "closed", requests: 3, emptyRequests: [1], injectedFailures: [1] });

    const files = (await readdir(captureDir)).sort();
    expect(files).toEqual([
      "0001-traces.body",
      "0001-traces.json",
      "0002-traces.body",
      "0002-traces.json",
      "0003-logs.body",
      "0003-logs.json",
      "summary.json",
    ]);

    const first = await readMeta(captureDir, "0001-traces");
    expect(first).toMatchObject({ seq: 1, signal: "traces", bytes: 0, empty: true, responseStatus: 503, injectedFailure: true });
    expect((await readFile(path.join(captureDir, "0001-traces.body"))).length).toBe(0);

    const second = await readMeta(captureDir, "0002-traces");
    expect(second).toMatchObject({ seq: 2, empty: false, responseStatus: 200, injectedFailure: false, encoding: "json" });
    expect(second.counts).toEqual({ spans: 1, logs: 0 });
    expect(second.decoded?.spans[0]?.name).toBe("tool Read");
    expect(second.decoded?.spans[0]?.attributes["gen_ai.usage.input_tokens"]).toBe(12);
    expect(second.headers.authorization).toBe("<redacted:Basic>");
    expect(await readFile(path.join(captureDir, "0002-traces.body"), "utf8")).toBe(JSON.stringify(jsonTraces));

    const third = await readMeta(captureDir, "0003-logs");
    expect(third).toMatchObject({ signal: "logs", path: "/api/public/otel/v1/logs" });
    expect(third.counts.logs).toBe(1);
    expect(third.headers["x-langfuse-key"]).toBe("<redacted>");

    // No credential reaches the disk, in any file.
    for (const file of files.filter((name) => name.endsWith(".json"))) {
      expect(await readFile(path.join(captureDir, file), "utf8")).not.toContain(SYNTHETIC_SECRET);
    }
    const summary = JSON.parse(await readFile(path.join(captureDir, "summary.json"), "utf8")) as Record<string, unknown>;
    expect(summary).toMatchObject({ requests: 3, emptyRequests: [1], bySignal: { traces: { requests: 2, empty: 1, spans: 1 } } });
  }, 30_000);

  it("limits injected failures to one signal when asked", async () => {
    const { receiver } = await withReceiver(["--fail-first", "1", "--fail-signal", "logs"]);
    const post = (url: string): Promise<Response> =>
      fetch(url, { method: "POST", headers: { "content-type": "application/x-protobuf" }, body: new Uint8Array(0) });
    expect((await post(receiver.tracesUrl)).status).toBe(200);
    expect((await post(receiver.logsUrl)).status).toBe(503);
    expect((await post(receiver.logsUrl)).status).toBe(200);
    await receiver.stop();
  }, 30_000);
});
