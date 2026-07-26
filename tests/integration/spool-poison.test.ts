import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFixedClock } from "../../src/runtime/clock.js";
import { sanitizeSegment } from "../../src/state/keys.js";
import {
  createFileDurableSpool,
  validateSpoolBatch,
  type SpoolBatch,
} from "../../src/telemetry/durable-spool.js";

/**
 * A poisoned spool file must cost one batch, never the queue.
 *
 * The drain processes the oldest file first and stops at the first undeliverable
 * one, which is right for a collector that is merely down. It is catastrophic for a
 * file that can *never* be delivered: a batch whose `spans` is not an array makes
 * the sink throw, a throwing send is indistinguishable from an unreachable
 * collector, and so the head is retried forever while every healthy batch behind it
 * waits. Validation before replay is what separates the two.
 */

const PROVIDER = "acme-cli";
const INSTALLATION = "install-1";

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(tmpdir(), "otel-hook-spool-poison-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

const spoolDir = (): string =>
  path.join(rootDir, sanitizeSegment(PROVIDER), INSTALLATION, "spool");

const goodSpan = {
  name: "tool read_file",
  kind: 0,
  traceId: "0af7651916cd43dd8448eb211c80319c",
  spanId: "b7ad6b7169203331",
  startMillis: 1_000,
  endMillis: 1_750,
  attributes: { "gen_ai.tool.name": "read_file" },
  statusCode: 0,
};

const goodBatch = (): Record<string, unknown> => ({
  providerId: PROVIDER,
  installationId: INSTALLATION,
  resourceAttributes: { "service.name": "obs" },
  instrumentationScope: { name: "otel-hook" },
  spans: [goodSpan],
  enqueuedAt: 1_700_000_000_000,
});

/** Write a spool file by hand, with a name that orders it as given. */
const plant = async (order: string, body: unknown): Promise<void> => {
  await mkdir(spoolDir(), { recursive: true });
  await writeFile(
    path.join(spoolDir(), `${order.padStart(16, "0")}-planted.json`),
    typeof body === "string" ? body : JSON.stringify(body),
    "utf8",
  );
};

const makeSpool = (): ReturnType<typeof createFileDurableSpool> =>
  createFileDurableSpool({
    rootDir,
    providerId: PROVIDER,
    installationId: INSTALLATION,
    clock: createFixedClock(),
  });

const identity = { providerId: PROVIDER, installationId: INSTALLATION };

describe("validateSpoolBatch rejects every malformed shape", () => {
  it("accepts a well-formed batch", () => {
    expect(validateSpoolBatch(goodBatch(), identity)).toHaveProperty("batch");
  });

  it("rejects a batch that is not an object", () => {
    for (const value of [null, 42, "batch", [goodBatch()]]) {
      expect(validateSpoolBatch(value, identity)).toEqual({ rejection: "not-an-object" });
    }
  });

  it("rejects a mismatched identity", () => {
    expect(validateSpoolBatch({ ...goodBatch(), providerId: "someone-else" }, identity)).toEqual({
      rejection: "identity-mismatch",
    });
  });

  it("rejects resourceAttributes that is not an object", () => {
    // A string would otherwise be iterated by index and produce a resource built
    // from its characters.
    for (const value of ["service.name=obs", ["a"], null, 7]) {
      expect(
        validateSpoolBatch({ ...goodBatch(), resourceAttributes: value }, identity),
      ).toEqual({ rejection: "resource-attributes-invalid" });
    }
  });

  it("rejects a malformed instrumentation scope", () => {
    for (const scope of [undefined, {}, { name: "" }, { name: 5 }, "otel-hook", { name: "ok", version: 2 }]) {
      expect(
        validateSpoolBatch({ ...goodBatch(), instrumentationScope: scope }, identity),
      ).toEqual({ rejection: "instrumentation-scope-invalid" });
    }
  });

  it("rejects a spans value that is not a bounded, non-empty array", () => {
    for (const spans of [undefined, {}, "spans", [], Array.from({ length: 5_000 }, () => goodSpan)]) {
      expect(validateSpoolBatch({ ...goodBatch(), spans }, identity)).toEqual({
        rejection: "spans-invalid",
      });
    }
  });

  it("rejects every individually malformed span field", () => {
    const bad: readonly Record<string, unknown>[] = [
      { ...goodSpan, name: "" },
      { ...goodSpan, name: 5 },
      { ...goodSpan, kind: "client" },
      { ...goodSpan, kind: -1 },
      // Trace and span ids must be their hex forms; a malformed id is not a span a
      // collector can place, and the encoder would reject it deep inside the SDK.
      { ...goodSpan, traceId: "not-hex" },
      { ...goodSpan, traceId: "0af7651916cd43dd" },
      { ...goodSpan, spanId: "b7ad6b716920333" },
      { ...goodSpan, parentSpanId: "zz" },
      { ...goodSpan, startMillis: null },
      { ...goodSpan, startMillis: Number.NaN },
      { ...goodSpan, endMillis: "later" },
      { ...goodSpan, statusCode: "ok" },
      { ...goodSpan, statusMessage: 5 },
      { ...goodSpan, attributes: undefined },
      { ...goodSpan, attributes: "a=b" },
      { ...goodSpan, attributes: { nested: { deep: true } } },
      { ...goodSpan, attributes: { arr: [{ deep: true }] } },
      { ...goodSpan, attributes: { n: Number.POSITIVE_INFINITY } },
    ];
    for (const span of bad) {
      expect(
        validateSpoolBatch({ ...goodBatch(), spans: [span] }, identity),
        JSON.stringify(span).slice(0, 80),
      ).toEqual({ rejection: "span-field-invalid" });
    }
  });

  it("accepts the optional fields a real batch carries", () => {
    expect(
      validateSpoolBatch(
        {
          ...goodBatch(),
          instrumentationScope: { name: "otel-hook", version: "1.2.3" },
          spans: [
            {
              ...goodSpan,
              parentSpanId: "aaaaaaaaaaaaaaaa",
              statusMessage: "error",
              attributes: { s: "x", n: 1, b: true, arr: ["a", "b"] },
            },
          ],
        },
        identity,
      ),
    ).toHaveProperty("batch");
  });
});

describe("a poisoned file cannot wedge the queue head", () => {
  it("quarantines the poison and still drains the healthy batch behind it", async () => {
    // Oldest first: the poison sorts ahead of the good batch, so the old drain
    // would stop on it forever and the good one would never be sent.
    await plant("1", { ...goodBatch(), spans: "not-an-array" });
    await plant("2", goodBatch());

    const sent: SpoolBatch[] = [];
    const result = await makeSpool().drain((batch) => {
      sent.push(batch);
      return Promise.resolve(true);
    });

    expect(result.quarantined).toBe(1);
    expect(result.drained).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.remaining).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.spans[0]?.name).toBe("tool read_file");

    // The poison is in the quarantine directory, not the queue.
    const corrupt = path.join(rootDir, sanitizeSegment(PROVIDER), INSTALLATION, "spool-corrupt");
    expect((await readdir(corrupt)).length).toBe(1);
  });

  it("quarantines unparseable JSON rather than retrying it", async () => {
    await plant("1", "{ this is not json");
    await plant("2", goodBatch());

    const result = await makeSpool().drain(() => Promise.resolve(true));
    expect(result.quarantined).toBe(1);
    expect(result.drained).toBe(1);
    expect(result.remaining).toBe(0);
  });

  it("counts a genuinely undeliverable batch as failed, not quarantined", async () => {
    // The distinction that matters: this one *will* become deliverable, so it stays
    // in the queue and stops the drain, exactly as before.
    await plant("1", goodBatch());

    const result = await makeSpool().drain(() => Promise.resolve(false));
    expect(result.failed).toBe(1);
    expect(result.quarantined).toBe(0);
    expect(result.drained).toBe(0);
    expect(result.remaining).toBe(1);
  });

  it("never lets a send see a batch it would throw on", async () => {
    // Every poison shape at once, all ahead of one good batch.
    await plant("1", { ...goodBatch(), spans: { 0: goodSpan } });
    await plant("2", { ...goodBatch(), resourceAttributes: "nope" });
    await plant("3", { ...goodBatch(), spans: [{ ...goodSpan, spanId: "short" }] });
    await plant("4", { ...goodBatch(), instrumentationScope: null });
    await plant("5", goodBatch());

    let threw = false;
    const result = await makeSpool().drain((batch) => {
      try {
        // What the sink does: map over the spans. A poisoned batch reaching here is
        // the bug, so it is provoked deliberately.
        batch.spans.map((span) => span.spanId);
      } catch {
        threw = true;
      }
      return Promise.resolve(true);
    });

    expect(threw).toBe(false);
    expect(result.quarantined).toBe(4);
    expect(result.drained).toBe(1);
    expect(result.remaining).toBe(0);
  });
});
