import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../../src/config/schema.js";
import { parseCanonicalEvent, type CanonicalEvent } from "../../src/model/events.js";
import { CANONICAL_SCHEMA_VERSION } from "../../src/model/version.js";
import { createPrivacyService } from "../../src/privacy/service.js";
import { createClaudeCodeAdapter } from "../../src/providers/claude/adapter.js";
import { createProviderRegistry } from "../../src/providers/registry.js";
import { createFixedClock } from "../../src/runtime/clock.js";
import { createOtelHook } from "../../src/runtime/hook.js";
import { createDeterministicIdGenerator } from "../../src/runtime/ids.js";
import { createInMemoryStateStore, createRecordingLogger, createRecordingTelemetrySink } from "../../src/runtime/memory.js";
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
import { createTestIdentity, findDisclosureViolations } from "../../src/testing/index.js";

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
    // Lexicographic key order, not insertion order: `event` sorts before `schema`.
    expect(serializeLocalExportLine(event).startsWith('{"event":')).toBe(true);
  });
});

describe("forbidden JSONL paths", () => {
  it("refuses protocol streams and Windows reserved devices on every host", () => {
    const forbidden = [
      "",
      "   ",
      "\0",
      "safe\0name.jsonl",
      "-",
      "stdout",
      "STDERR",
      "foo/stdout",
      "foo\\stderr",
      "/dev/stdout",
      "/dev/stderr",
      "/dev/fd/1",
      "/dev/fd/2",
      "/dev/fd/1/",
      "/proc/self/fd/1",
      "/proc/self/fd/2",
      "/tmp/../dev/stdout",
      "/proc/self/fd/../fd/1",
      "CON",
      "con.jsonl",
      "CON.txt",
      "CON:",
      "NUL",
      "nul.txt",
      "PRN",
      "AUX",
      "COM1",
      "com3.jsonl",
      "LPT1",
      "lpt9.txt",
      "C:\\CON",
      "C:/foo/CON.jsonl",
      String.raw`\\.\CON`,
      String.raw`\\.\CONOUT$`,
      String.raw`\\.\CONIN$`,
      "//./CON",
      "//./CONOUT$",
    ];
    for (const candidate of forbidden) {
      expect(isForbiddenJsonlPath(candidate), candidate).toBe(true);
    }

    const allowed = [
      "events.jsonl",
      "stdout.jsonl",
      "console.jsonl",
      "report.con",
      "COM10",
      "LPT10",
      "conout.jsonl",
      "/var/log/otel-hook/events.jsonl",
      "C:/logs/events.jsonl",
      String.raw`D:\telemetry\events.jsonl`,
    ];
    for (const candidate of allowed) {
      expect(isForbiddenJsonlPath(candidate), candidate).toBe(false);
    }
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

  it("creates missing parents as mode 0o700 and does not tighten a directory that already existed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "otel-hook-jsonl-mode-"));
    const existing = path.join(root, "existing");
    await mkdir(existing, { mode: 0o755 });
    if (process.platform !== "win32") {
      await chmod(existing, 0o755);
    }
    const clock = createFixedClock({ tickMillis: 0 });
    const kept = path.join(existing, "events.jsonl");
    const created = path.join(root, "fresh", "nested", "events.jsonl");
    await createJsonlSink({ path: kept, maxBytes: 10 * 1024 * 1024, maxFiles: 2, clock }).emit([build()]);
    await createJsonlSink({ path: created, maxBytes: 10 * 1024 * 1024, maxFiles: 2, clock }).emit([build()]);

    expect(await readFile(kept, "utf8")).toContain(LOCAL_EXPORT_SCHEMA);
    expect(await readFile(created, "utf8")).toContain(LOCAL_EXPORT_SCHEMA);
    if (process.platform === "win32") {
      // Windows does not implement Unix permission bits. Both files must still exist.
      await stat(kept);
      await stat(created);
      return;
    }
    expect((await stat(existing)).mode & 0o777).toBe(0o755);
    expect((await stat(kept)).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(root, "fresh"))).mode & 0o777).toBe(0o700);
    expect((await stat(path.dirname(created))).mode & 0o777).toBe(0o700);
    expect((await stat(created)).mode & 0o777).toBe(0o600);
  });

  it("keeps at most maxFiles generations, replacing the active file when maxFiles is 1", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "otel-hook-jsonl-files-"));
    const filePath = path.join(dir, "events.jsonl");
    const clock = createFixedClock({ tickMillis: 0 });
    const sink = createJsonlSink({ path: filePath, maxBytes: 1_024, maxFiles: 1, clock });
    await sink.emit([build(), build(), build(), build(), build()]);
    await expect(stat(`${filePath}.1`)).rejects.toMatchObject({ code: "ENOENT" });
    const body = await readFile(filePath, "utf8");
    expect(body.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(body, "utf8")).toBeLessThan(8_192);
  });

  it("rejects a directory, a parent that is a file, and a symlink to a stream without throwing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "otel-hook-jsonl-invalid-"));
    const clock = createFixedClock({ tickMillis: 0 });
    const asDirectory = path.join(dir, "not-a-file");
    await mkdir(asDirectory);
    const directoryResult = await createJsonlSink({
      path: asDirectory,
      maxBytes: 10 * 1024 * 1024,
      maxFiles: 2,
      clock,
    }).emit([build()]);
    expect(directoryResult.accepted).toBe(0);
    expect(directoryResult.rejected).toBe(1);
    expect(directoryResult.errors[0]?.code).toBe("telemetry-export-failure");
    expect(JSON.stringify(directoryResult.errors)).not.toContain(asDirectory);

    const parentFile = path.join(dir, "parent-is-file");
    await writeFile(parentFile, "not a directory");
    const nested = path.join(parentFile, "events.jsonl");
    const parentResult = await createJsonlSink({
      path: nested,
      maxBytes: 10 * 1024 * 1024,
      maxFiles: 2,
      clock,
    }).emit([build()]);
    expect(parentResult.accepted).toBe(0);
    expect(parentResult.rejected).toBe(1);
    expect(JSON.stringify(parentResult.errors)).not.toContain(parentFile);

    if (process.platform === "win32") {
      // The Windows equivalent is a reserved device name, refused before open.
      const reserved = await createJsonlSink({
        path: path.join(dir, "CON.jsonl"),
        maxBytes: 1_024,
        maxFiles: 2,
        clock,
      }).emit([build()]);
      expect(reserved.rejected).toBe(1);
      expect(reserved.errors[0]?.details?.["local.reason"]).toBe("forbidden-path");
      return;
    }
    const link = path.join(dir, "stdout-link");
    await symlink("/dev/stdout", link);
    const linkResult = await createJsonlSink({
      path: link,
      maxBytes: 10 * 1024 * 1024,
      maxFiles: 2,
      clock,
    }).emit([build()]);
    expect(linkResult.accepted).toBe(0);
    expect(linkResult.rejected).toBe(1);
    expect(JSON.stringify(linkResult.errors)).not.toContain("/dev/stdout");
    expect(JSON.stringify(linkResult.errors)).not.toContain(link);
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

describe("local exporters receive privacy-filtered events", () => {
  it("applies the central privacy policy before JSONL or console see the batch", async () => {
    const secret = "claude-prompt-secret-do-not-export";
    const dir = await mkdtemp(path.join(tmpdir(), "otel-hook-jsonl-privacy-"));
    const filePath = path.join(dir, "events.jsonl");
    const clock = createFixedClock({ tickMillis: 0 });
    const primary = createRecordingTelemetrySink();
    const consoleLines: string[] = [];
    const sink = attachLocalExporters(primary, [
      createJsonlSink({ path: filePath, maxBytes: 1024 * 1024, maxFiles: 2, clock }),
      createConsoleSink({ write: (line) => consoleLines.push(line) }),
    ]);
    const hook = createOtelHook({
      sink,
      stateStore: createInMemoryStateStore({ clock }),
      config: DEFAULT_CONFIG,
      registry: createProviderRegistry([createClaudeCodeAdapter()]),
      clock,
      ids: createDeterministicIdGenerator({ namespace: "local-export" }),
      privacy: createPrivacyService(DEFAULT_CONFIG.privacy),
      logger: createRecordingLogger("silent"),
    });

    const outcome = await hook.ingest({
      payload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "ses-local-privacy",
        transcript_path: "/workspace/fixture-repo/.claude/transcript.jsonl",
        cwd: "/workspace/fixture-repo",
        prompt: secret,
      },
      transport: "hook-stdin",
      providerHint: "claude-code",
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.attribution).toBe("attributed");
    expect(outcome.emitted).toBeGreaterThan(0);
    expect(outcome.durability).toBe("delivered");
    expect(outcome.hookResponse.stdout).toBeUndefined();
    expect(findDisclosureViolations(primary.events())).toEqual([]);

    const jsonl = await readFile(filePath, "utf8");
    const consoleText = consoleLines.join("");
    expect(jsonl).toContain(`"schema":"${LOCAL_EXPORT_SCHEMA}"`);
    expect(consoleText).toContain(`"schema":"${LOCAL_EXPORT_SCHEMA}"`);
    expect(jsonl).not.toContain(secret);
    expect(consoleText).not.toContain(secret);
    expect(jsonl).not.toContain("/workspace/fixture-repo");
    expect(consoleText).not.toContain("/workspace/fixture-repo");
    expect(jsonl).toBe(consoleText);
  });

  it("keeps a delivered OTLP result when the JSONL path is unusable", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "otel-hook-jsonl-durability-"));
    const clock = createFixedClock({ tickMillis: 0 });
    const primary = createRecordingTelemetrySink();
    const sink = attachLocalExporters(primary, [
      createJsonlSink({ path: dir, maxBytes: 1024 * 1024, maxFiles: 2, clock }),
    ]);
    const hook = createOtelHook({
      sink,
      stateStore: createInMemoryStateStore({ clock }),
      config: DEFAULT_CONFIG,
      registry: createProviderRegistry([createClaudeCodeAdapter()]),
      clock,
      ids: createDeterministicIdGenerator({ namespace: "local-export-durability" }),
      privacy: createPrivacyService(DEFAULT_CONFIG.privacy),
      logger: createRecordingLogger("silent"),
    });

    const outcome = await hook.ingest({
      payload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "ses-local-durability",
        transcript_path: "/workspace/fixture-repo/.claude/transcript.jsonl",
        cwd: "/workspace/fixture-repo",
        prompt: "ignored-by-privacy",
      },
      transport: "hook-stdin",
      providerHint: "claude-code",
    });

    expect(outcome.durability).toBe("delivered");
    expect(outcome.exportRejected).toBe(0);
    expect(outcome.emitted).toBeGreaterThan(0);
    expect(primary.events().length).toBe(outcome.emitted);
    expect(outcome.diagnostics.some((info) => info.code === "telemetry-export-failure")).toBe(true);
    expect(outcome.hookResponse.stdout).toBeUndefined();
    expect(JSON.stringify(outcome.diagnostics)).not.toContain(dir);
  });
});
