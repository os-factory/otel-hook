import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_EXPORTER_POLICY } from "../../src/config/schema.js";
import {
  MAX_RESOURCE_ATTRIBUTES,
  MAX_RESOURCE_ATTRIBUTE_VALUE_LENGTH,
} from "../../src/config/resource-attributes.js";
import { createFixedClock } from "../../src/runtime/clock.js";
import { sanitizeSegment } from "../../src/state/keys.js";
import { createFileDurableSpool, type SpoolBatch } from "../../src/telemetry/durable-spool.js";
import { createOtlpTraceSink } from "../../src/telemetry/otlp-sink.js";
import { startCapturingCollector, type CapturingCollector } from "../helpers/collector.js";
import { decodeAllExportedSpans } from "../helpers/otlp.js";

/**
 * A spool file is a plain JSON file in a state directory, so everything drained
 * out of one is untrusted input: hand-editable, truncated, or written by an older
 * release. The live path validates resource attributes before they reach the wire;
 * the replay path has to enforce the same bounds, or "what a flag may set" and
 * "what a file may set" diverge — and the file wins.
 */

const PROVIDER = "acme-cli";
const INSTALLATION = "install-1";

let rootDir: string;
const cleanups: (() => Promise<void>)[] = [];

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(tmpdir(), "otel-hook-spool-validate-"));
});

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  await rm(rootDir, { recursive: true, force: true });
});

const withCollector = async (): Promise<CapturingCollector> => {
  const collector = await startCapturingCollector();
  cleanups.push(() => collector.close());
  return collector;
};

/** Write a spool file by hand, exactly as a tamperer would. */
const plantBatch = async (resourceAttributes: Record<string, unknown>): Promise<void> => {
  const spoolDir = path.join(rootDir, sanitizeSegment(PROVIDER), INSTALLATION, "spool");
  await mkdir(spoolDir, { recursive: true });
  const batch = {
    providerId: PROVIDER,
    installationId: INSTALLATION,
    resourceAttributes,
    instrumentationScope: { name: "otel-hook" },
    spans: [
      {
        name: "tool read_file",
        kind: 0,
        traceId: "0af7651916cd43dd8448eb211c80319c",
        spanId: "b7ad6b7169203331",
        startMillis: 1_000,
        endMillis: 1_750,
        attributes: { "gen_ai.tool.name": "read_file" },
        statusCode: 0,
      },
    ],
    enqueuedAt: 1_700_000_000_000,
  } satisfies Omit<SpoolBatch, "resourceAttributes"> & {
    resourceAttributes: Record<string, unknown>;
  };
  await writeFile(path.join(spoolDir, "0001700000000000-planted.json"), JSON.stringify(batch), "utf8");
};

const drainAndReadResource = async (
  collector: CapturingCollector,
  policyOverrides: Partial<typeof DEFAULT_EXPORTER_POLICY> = {},
): Promise<Record<string, unknown>> => {
  const clock = createFixedClock();
  const spool = createFileDurableSpool({
    rootDir,
    providerId: PROVIDER,
    installationId: INSTALLATION,
    clock,
  });
  const sink = createOtlpTraceSink({
    exporter: {
      ...DEFAULT_EXPORTER_POLICY,
      endpoint: collector.url,
      timeoutMillis: 5_000,
      serviceName: "the-real-service",
      ...policyOverrides,
    },
    providerId: PROVIDER,
    installationId: INSTALLATION,
    clock,
    spool,
  });

  expect(await sink.drainSpool()).toMatchObject({ drained: 1, remaining: 0 });
  const spans = decodeAllExportedSpans(collector.bodies());
  expect(spans.length).toBeGreaterThan(0);
  return spans[0]?.resourceAttributes ?? {};
};

describe("spool replay cannot forge service identity", () => {
  it("replays a well-formed recorded service identity as recorded", async () => {
    // The recorded name is a fact about the process that made the observation, so
    // a valid one is honoured rather than relabelled.
    await plantBatch({
      "service.name": "the-observing-service",
      "service.namespace": "team-a",
      "deployment.environment": "staging",
    });
    const resource = await drainAndReadResource(await withCollector());

    expect(resource["service.name"]).toBe("the-observing-service");
    expect(resource["service.namespace"]).toBe("team-a");
    expect(resource["deployment.environment"]).toBe("staging");
  });

  it("refuses a non-string service.name and falls back to the live policy", async () => {
    await plantBatch({ "service.name": { evil: "object" } });
    const resource = await drainAndReadResource(await withCollector());

    // Never the forged structure, and never absent — a resource with no
    // service.name is bucketed as "unknown_service" by most collectors, so losing
    // the batch to a tampered byte would make the validation itself the outage.
    expect(resource["service.name"]).toBe("the-real-service");
  });

  it("refuses an empty or over-long service.name", async () => {
    await plantBatch({ "service.name": "" });
    expect((await drainAndReadResource(await withCollector()))["service.name"]).toBe(
      "the-real-service",
    );

    await rm(rootDir, { recursive: true, force: true });
    rootDir = await mkdtemp(path.join(tmpdir(), "otel-hook-spool-validate-"));
    await plantBatch({ "service.name": "x".repeat(5_000) });
    expect((await drainAndReadResource(await withCollector()))["service.name"]).toBe(
      "the-real-service",
    );
  });

  it("cannot smuggle a service name in through a differently-cased key", async () => {
    await plantBatch({ "Service.Name": "forged-by-casing", "SERVICE.NAMESPACE": "forged-ns" });
    const resource = await drainAndReadResource(await withCollector());

    expect(resource["service.name"]).toBe("the-real-service");
    // The case variants are reserved keys too, so they are dropped rather than
    // exported alongside as look-alike attributes.
    expect(resource["Service.Name"]).toBeUndefined();
    expect(resource["SERVICE.NAMESPACE"]).toBeUndefined();
  });
});

describe("spool replay enforces the live path's attribute bounds", () => {
  it("drops keys the live path would have refused", async () => {
    await plantBatch({
      "service.name": "obs",
      api_key: "should-never-be-exported",
      "9-bad-start": "malformed",
      "has space": "malformed",
      "deployment.environment": "prod",
    });
    const resource = await drainAndReadResource(await withCollector());

    // A secret-looking name is refused on the flag path, so it must be refused
    // here too — a resource attribute rides on every span, making it the most
    // durable possible leak.
    expect(resource["api_key"]).toBeUndefined();
    expect(resource["9-bad-start"]).toBeUndefined();
    expect(resource["has space"]).toBeUndefined();
    expect(resource["deployment.environment"]).toBe("prod");
  });

  it("drops values that are not primitives, or are over-long", async () => {
    await plantBatch({
      "service.name": "obs",
      "attr.object": { nested: true },
      "attr.array": [1, 2, 3],
      "attr.null": null,
      "attr.nan": Number.NaN,
      "attr.long": "y".repeat(MAX_RESOURCE_ATTRIBUTE_VALUE_LENGTH + 1),
      "attr.ok": "kept",
      "attr.number": 42,
      "attr.bool": true,
    });
    const resource = await drainAndReadResource(await withCollector());

    for (const dropped of ["attr.object", "attr.array", "attr.null", "attr.nan", "attr.long"]) {
      expect(resource[dropped]).toBeUndefined();
    }
    expect(resource["attr.ok"]).toBe("kept");
    expect(resource["attr.number"]).toBe(42);
    expect(resource["attr.bool"]).toBe(true);
  });

  it("caps how many custom attributes a spool file may contribute", async () => {
    const many: Record<string, unknown> = { "service.name": "obs" };
    for (let index = 0; index < MAX_RESOURCE_ATTRIBUTES * 3; index += 1) {
      many[`attr.k${String(index)}`] = "v";
    }
    await plantBatch(many);
    const resource = await drainAndReadResource(await withCollector());

    const custom = Object.keys(resource).filter((key) => key.startsWith("attr.k"));
    expect(custom.length).toBe(MAX_RESOURCE_ATTRIBUTES);
    // The service identity is written after the custom attributes, so an
    // overflowing file can never crowd it out.
    expect(resource["service.name"]).toBe("obs");
  });
});
