import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_EXPORTER_POLICY } from "../../src/config/schema.js";
import { parseCanonicalEvent } from "../../src/model/events.js";
import { CANONICAL_SCHEMA_VERSION } from "../../src/model/version.js";
import { createFixedClock } from "../../src/runtime/clock.js";
import { createFileDurableSpool, type SpoolBatch } from "../../src/telemetry/durable-spool.js";
import { createOtlpTraceSink } from "../../src/telemetry/otlp-sink.js";
import { createTestIdentity } from "../../src/testing/index.js";

/**
 * Custom resource attributes, asserted where they actually matter: on the bytes
 * a real (ephemeral, local-only) collector received, and on the durable spool
 * file a later invocation will replay. A protobuf-encoded string field appears
 * verbatim in the payload, so reading the body as text proves what left the
 * process without re-serializing it first.
 */
type Captured = { readonly body: Buffer };

const startCollector = async (
  respond: () => { readonly status: number } = () => ({ status: 200 }),
): Promise<{
  readonly url: string;
  readonly server: Server;
  readonly requests: Captured[];
  text(): string;
}> => {
  const requests: Captured[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({ body: Buffer.concat(chunks) });
      res.writeHead(respond().status);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("failed to bind capturing collector");
  }
  return {
    url: `http://127.0.0.1:${String(address.port)}/v1/traces`,
    server,
    requests,
    text: (): string => Buffer.concat(requests.map((request) => request.body)).toString("latin1"),
  };
};

const identity = createTestIdentity();
let index = 0;
const nextEvent = () =>
  parseCanonicalEvent({
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    invocationId: identity.invocationId,
    sessionId: identity.sessionId,
    provenance: identity.provenance,
    workspace: identity.workspace,
    extensions: {},
    eventId: `resattr-${String((index += 1))}`,
    sequence: index,
    occurredAt: 1_000,
    type: "prompt.submitted",
    promptSource: "user",
  });

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const withCollector = async (
  respond?: () => { readonly status: number },
): Promise<Awaited<ReturnType<typeof startCollector>>> => {
  const collector = await startCollector(respond);
  closers.push(() => new Promise<void>((resolve) => collector.server.close(() => resolve())));
  return collector;
};

const withRootDir = async (): Promise<string> => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "otel-hook-resattr-"));
  closers.push(() => rm(rootDir, { recursive: true, force: true }));
  return rootDir;
};

const spoolFiles = async (rootDir: string): Promise<readonly string[]> => {
  const dir = path.join(rootDir, "acme-cli", "install-1", "spool");
  return (await readdir(dir)).filter((entry) => entry.endsWith(".json") && !entry.startsWith(".tmp-"));
};

describe("custom resource attributes on the wire", () => {
  it("merges configured attributes into the exported OTLP Resource", async () => {
    const collector = await withCollector();
    const sink = createOtlpTraceSink({
      exporter: {
        ...DEFAULT_EXPORTER_POLICY,
        endpoint: collector.url,
        timeoutMillis: 5_000,
        serviceName: "agent-under-test",
        serviceNamespace: "platform",
        resourceAttributes: {
          "deployment.environment": "staging",
          "service.instance.id": "i-0abc",
          "deployment.replica": 3,
          "deployment.canary": true,
        },
      },
      providerId: "acme-cli",
      installationId: "install-1",
      clock: createFixedClock(),
    });

    expect(await sink.emit([nextEvent()])).toEqual({ accepted: 1, rejected: 0, errors: [] });
    const exported = collector.text();
    for (const fragment of [
      "deployment.environment",
      "staging",
      "service.instance.id",
      "i-0abc",
      "deployment.replica",
      "deployment.canary",
      "agent-under-test",
      "platform",
    ]) {
      expect(exported, fragment).toContain(fragment);
    }
    await sink.shutdown();
  });

  it("keeps service.name from exporter policy even when an attribute map claims it", async () => {
    const collector = await withCollector();
    const sink = createOtlpTraceSink({
      exporter: {
        ...DEFAULT_EXPORTER_POLICY,
        endpoint: collector.url,
        timeoutMillis: 5_000,
        serviceName: "policy-service-name",
        // The schema refuses this; a hand-built policy does not go through the
        // schema, so the sink is the last gate and must hold on its own.
        resourceAttributes: { "service.name": "hijacked-service-name", "team.name": "core" },
      },
      providerId: "acme-cli",
      installationId: "install-1",
      clock: createFixedClock(),
    });

    await sink.emit([nextEvent()]);
    const exported = collector.text();
    expect(exported).toContain("policy-service-name");
    expect(exported).toContain("team.name");
    expect(exported).not.toContain("hijacked-service-name");
    await sink.shutdown();
  });

  it("never exports an attribute whose key names a secret", async () => {
    const collector = await withCollector();
    const sink = createOtlpTraceSink({
      exporter: {
        ...DEFAULT_EXPORTER_POLICY,
        endpoint: collector.url,
        timeoutMillis: 5_000,
        resourceAttributes: {
          "tenant.api_key": "sk-live-must-not-be-exported",
          "team.name": "core",
        },
      },
      providerId: "acme-cli",
      installationId: "install-1",
      clock: createFixedClock(),
    });

    await sink.emit([nextEvent()]);
    expect(collector.text()).toContain("team.name");
    expect(collector.text()).not.toContain("sk-live-must-not-be-exported");
    expect(collector.text()).not.toContain("tenant.api_key");
    await sink.shutdown();
  });
});

describe("custom resource attributes survive the durable spool", () => {
  it("records the whole merged resource when a collector refuses a batch", async () => {
    const rootDir = await withRootDir();
    const down = await withCollector(() => ({ status: 503 }));
    const clock = createFixedClock();
    const spool = createFileDurableSpool({
      rootDir,
      providerId: "acme-cli",
      installationId: "install-1",
      clock,
    });
    const sink = createOtlpTraceSink({
      exporter: {
        ...DEFAULT_EXPORTER_POLICY,
        endpoint: down.url,
        timeoutMillis: 2_000,
        maxRetryAttempts: 0,
        serviceName: "spooling-agent",
        resourceAttributes: { "deployment.environment": "staging", "team.name": "core" },
      },
      providerId: "acme-cli",
      installationId: "install-1",
      clock,
      spool,
    });

    await sink.emit([nextEvent()]);
    const [fileName] = await spoolFiles(rootDir);
    expect(fileName).toBeDefined();
    const persisted = JSON.parse(
      await readFile(path.join(rootDir, "acme-cli", "install-1", "spool", fileName ?? ""), "utf8"),
    ) as SpoolBatch;

    // The spool file is the structured record of the resource that would have
    // been exported: custom attributes and the policy service name, together.
    expect(persisted.resourceAttributes).toEqual({
      "deployment.environment": "staging",
      "team.name": "core",
      "service.name": "spooling-agent",
    });

    const up = await withCollector();
    const drainSink = createOtlpTraceSink({
      exporter: { ...DEFAULT_EXPORTER_POLICY, endpoint: up.url, timeoutMillis: 2_000 },
      providerId: "acme-cli",
      installationId: "install-1",
      clock,
      spool,
    });
    expect(await drainSink.drainSpool()).toEqual({ drained: 1, remaining: 0, failed: 0, quarantined: 0 });

    // Replayed as recorded: the attributes belong to the invocation that made
    // the observation, not to the one that happened to drain the spool.
    const replayed = up.text();
    expect(replayed).toContain("deployment.environment");
    expect(replayed).toContain("staging");
    expect(replayed).toContain("team.name");
    expect(replayed).toContain("spooling-agent");

    await sink.shutdown();
    await drainSink.shutdown();
  }, 30_000);

  it("refuses to replay a resource attribute a tampered spool file added", async () => {
    const rootDir = await withRootDir();
    const collector = await withCollector();
    const clock = createFixedClock();
    const spool = createFileDurableSpool({
      rootDir,
      providerId: "acme-cli",
      installationId: "install-1",
      clock,
    });
    // Create the directory tree the same way the spool does.
    await spool.size();

    const tampered: SpoolBatch = {
      providerId: "acme-cli",
      installationId: "install-1",
      resourceAttributes: {
        "service.name": "recorded-agent",
        "team.name": "core",
        "tenant.api_key": "sk-live-injected-by-hand",
        "9malformed": "also-injected",
        ...Object.fromEntries(
          Array.from({ length: 65 }, (_, index) => [`replay.attribute.${String(index)}`, `value-${String(index)}`]),
        ),
      },
      instrumentationScope: { name: "otel-hook" },
      spans: [
        {
          name: "prompt",
          kind: 0,
          traceId: "0af7651916cd43dd8448eb211c80319c",
          spanId: "b7ad6b7169203331",
          startMillis: 1_000,
          endMillis: 1_000,
          attributes: { "otelhook.span.paired": true },
          statusCode: 0,
        },
      ],
      enqueuedAt: 1_000,
    };
    await writeFile(
      path.join(rootDir, "acme-cli", "install-1", "spool", "0000000000000001-abcdef012345.json"),
      JSON.stringify(tampered),
      "utf8",
    );

    const sink = createOtlpTraceSink({
      exporter: { ...DEFAULT_EXPORTER_POLICY, endpoint: collector.url, timeoutMillis: 2_000 },
      providerId: "acme-cli",
      installationId: "install-1",
      clock,
      spool,
    });
    expect(await sink.drainSpool()).toEqual({ drained: 1, remaining: 0, failed: 0, quarantined: 0 });

    const replayed = collector.text();
    expect(replayed).toContain("recorded-agent");
    expect(replayed).toContain("team.name");
    expect(replayed).toContain("replay.attribute.62");
    expect(replayed).not.toContain("replay.attribute.63");
    expect(replayed).not.toContain("replay.attribute.64");
    expect(replayed).not.toContain("sk-live-injected-by-hand");
    expect(replayed).not.toContain("also-injected");
    await sink.shutdown();
  }, 30_000);
});
