import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../../src/config/schema.js";
import { parseCanonicalEvent, type CanonicalEvent } from "../../src/model/events.js";
import { CANONICAL_SCHEMA_VERSION } from "../../src/model/version.js";
import { createFixedClock } from "../../src/runtime/clock.js";
import { createRecordingTelemetrySink } from "../../src/runtime/memory.js";
import type { TelemetrySink } from "../../src/runtime/ports.js";
import {
  LOCAL_EXPORT_SCHEMA,
  LOCAL_EXPORT_SCHEMA_VERSION,
  attachLocalExporters,
  createConsoleSink,
  createJsonlSink,
  createLocalExportSinks,
  isForbiddenJsonlPath,
  serializeLocalExportLine,
  stableStringify,
} from "../../src/telemetry/local-export.js";
import { createTestIdentity } from "../../src/testing/index.js";

const identity = createTestIdentity();

let sequence = 0;
const build = (): CanonicalEvent =>
  parseCanonicalEvent({
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    invocationId: identity.invocationId,
    sessionId: identity.sessionId,
    provenance: identity.provenance,
    workspace: identity.workspace,
    extensions: {},
    eventId: `evt_${String((sequence += 1)).padStart(16, "0")}`,
    sequence,
    occurredAt: 1_700_000_000_000,
    type: "session.start",
    sessionKind: "interactive",
  });

const oversized = (): CanonicalEvent =>
  parseCanonicalEvent({
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    invocationId: identity.invocationId,
    sessionId: identity.sessionId,
    provenance: identity.provenance,
    workspace: identity.workspace,
    extensions: { "test.pad": "x".repeat(4_096) },
    eventId: `evt_${String((sequence += 1)).padStart(16, "0")}`,
    sequence,
    occurredAt: 1_700_000_000_000,
    type: "session.start",
    sessionKind: "interactive",
  });

describe("local-export serialization", () => {
  it("is deterministic for the same event regardless of key insertion order", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(stableStringify({ a: { c: 3, d: 2 }, b: 1 }));
    const event = build();
    expect(serializeLocalExportLine(event)).toBe(serializeLocalExportLine(event));
    const parsed = JSON.parse(serializeLocalExportLine(event)) as {
      schema: string;
      schemaVersion: number;
      exportedAt?: unknown;
    };
    expect(parsed.schema).toBe(LOCAL_EXPORT_SCHEMA);
    expect(parsed.schemaVersion).toBe(LOCAL_EXPORT_SCHEMA_VERSION);
    expect(parsed.exportedAt).toBeUndefined();
  });
});

describe("forbidden JSONL paths", () => {
  it("refuses stdout, stderr, and dash, so a file exporter cannot corrupt the hook protocol", () => {
    expect(isForbiddenJsonlPath("-")).toBe(true);
    expect(isForbiddenJsonlPath("stdout")).toBe(true);
    expect(isForbiddenJsonlPath("/dev/stdout")).toBe(true);
    expect(isForbiddenJsonlPath("/dev/fd/1")).toBe(true);
    expect(isForbiddenJsonlPath("/dev/stderr")).toBe(true);
    expect(isForbiddenJsonlPath("events.jsonl")).toBe(false);
  });
});

describe("console sink", () => {
  it("writes JSONL to the injected writer and never to stdout", async () => {
    const lines: string[] = [];
    const sink = createConsoleSink({ write: (line) => lines.push(line) });
    const event = build();
    const result = await sink.emit([event]);
    expect(result.accepted).toBe(1);
    expect(result.rejected).toBe(0);
    expect(lines).toEqual([`${serializeLocalExportLine(event)}\n`]);
  });
});

describe("JSONL sink", () => {
  it("appends a versioned envelope and creates the file with mode 0o600", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "otel-hook-jsonl-"));
    const filePath = path.join(dir, "events.jsonl");
    const clock = createFixedClock({ startMillis: 1_700_000_000_000, tickMillis: 0 });
    const sink = createJsonlSink({
      path: filePath,
      maxBytes: DEFAULT_CONFIG.localExport.jsonl.maxBytes,
      maxFiles: DEFAULT_CONFIG.localExport.jsonl.maxFiles,
      clock,
    });
    const event = build();
    const result = await sink.emit([event]);
    expect(result).toEqual({ accepted: 1, rejected: 0, errors: [] });
    expect(await readFile(filePath, "utf8")).toBe(`${serializeLocalExportLine(event)}\n`);
    if (process.platform !== "win32") {
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    }
  });

  it("rotates when the active file reaches the size bound", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "otel-hook-jsonl-rot-"));
    const filePath = path.join(dir, "events.jsonl");
    const clock = createFixedClock({ tickMillis: 0 });
    const sink = createJsonlSink({ path: filePath, maxBytes: 1_024, maxFiles: 8, clock });
    const events = [build(), build(), build(), build(), build()];
    await sink.emit(events);
    const readIfPresent = async (target: string): Promise<string> => {
      try {
        return await readFile(target, "utf8");
      } catch (thrown) {
        if ((thrown as NodeJS.ErrnoException).code === "ENOENT") {
          return "";
        }
        throw thrown;
      }
    };
    const combined = [
      await readIfPresent(filePath),
      await readIfPresent(`${filePath}.1`),
      await readIfPresent(`${filePath}.2`),
      await readIfPresent(`${filePath}.3`),
    ].join("");
    for (const event of events) {
      expect(combined).toContain(serializeLocalExportLine(event));
    }
    expect(await readIfPresent(`${filePath}.1`)).not.toBe("");
  });

  it("serializes concurrent writers through the file lock", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "otel-hook-jsonl-lock-"));
    const filePath = path.join(dir, "events.jsonl");
    const clock = createFixedClock({ tickMillis: 0 });
    const left = createJsonlSink({ path: filePath, maxBytes: 10 * 1024 * 1024, maxFiles: 3, clock });
    const right = createJsonlSink({ path: filePath, maxBytes: 10 * 1024 * 1024, maxFiles: 3, clock });
    const events = [build(), build(), build(), build()];
    await Promise.all([left.emit(events.slice(0, 2)), right.emit(events.slice(2))]);
    const lines = (await readFile(filePath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(4);
    expect(new Set(lines)).toEqual(new Set(events.map((event) => serializeLocalExportLine(event))));
  });

  it("rejects a forbidden path without naming it, so a home path cannot leak", async () => {
    const clock = createFixedClock({ tickMillis: 0 });
    const sink = createJsonlSink({ path: "/dev/stdout", maxBytes: 1_024, maxFiles: 3, clock });
    const result = await sink.emit([build()]);
    expect(result.accepted).toBe(0);
    expect(result.rejected).toBe(1);
    expect(result.errors[0]?.details?.["local.reason"]).toBe("forbidden-path");
    expect(JSON.stringify(result.errors)).not.toContain("/dev/stdout");
  });

  it("refuses a record larger than the file size bound rather than growing past it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "otel-hook-jsonl-bound-"));
    const filePath = path.join(dir, "events.jsonl");
    const clock = createFixedClock({ tickMillis: 0 });
    const sink = createJsonlSink({ path: filePath, maxBytes: 1_024, maxFiles: 3, clock });
    const result = await sink.emit([oversized()]);
    expect(result.accepted).toBe(0);
    expect(result.rejected).toBe(1);
    expect(result.errors[0]?.code).toBe("limit-exceeded");
    await expect(stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("attachLocalExporters", () => {
  it("does not let a JSONL failure change OTLP durability counts", async () => {
    const primary = createRecordingTelemetrySink();
    const failing: TelemetrySink = {
      emit: () => Promise.reject(new Error("/home/operator/secret.jsonl: ENOSPC")),
      flush: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
    };
    const wrapped = attachLocalExporters(primary, [failing]);
    const events = [build(), build()];
    const result = await wrapped.emit(events);
    expect(result.accepted).toBe(2);
    expect(result.rejected).toBe(0);
    expect(primary.batches()).toEqual([events]);
    expect(result.errors[0]?.code).toBe("telemetry-export-failure");
    expect(JSON.stringify(result.errors)).not.toContain("/home/operator");
    expect(JSON.stringify(result.errors)).not.toContain("ENOSPC");
  });
});

describe("createLocalExportSinks", () => {
  it("builds nothing on the default policy", () => {
    const clock = createFixedClock({ tickMillis: 0 });
    expect(createLocalExportSinks({ policy: DEFAULT_CONFIG.localExport, clock })).toEqual([]);
  });
});
