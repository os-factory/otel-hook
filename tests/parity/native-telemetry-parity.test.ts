import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { ensureBuiltCli, runCliProcess, startCollector, type Collector } from "../e2e/harness.js";

/**
 * The native-telemetry parity script (scripts/parity/native-telemetry-parity.mjs)
 * driven as a child process, the way an operator reruns it.
 *
 * The fixtures under tests/fixtures/native-parity/ are synthetic (see their
 * PROVENANCE.md): they prove the script's decoding, matching, and personal-data
 * flagging, not what any provider really emits. The real-CLI case below is what
 * keeps the otel-hook half of the category mapping honest: it compares against
 * bytes the built otel-hook binary actually sent.
 */

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "parity", "native-telemetry-parity.mjs");
const MAPPING = path.join(REPO_ROOT, "scripts", "parity", "native-parity-categories.json");
const FIXTURES = path.join(REPO_ROOT, "tests", "fixtures", "native-parity");
const CLAUDE_NATIVE = path.join(FIXTURES, "claude-code.native.otlp.jsonl");
const CLAUDE_HOOK = path.join(FIXTURES, "claude-code.otel-hook.otlp.jsonl");

type Side = { readonly count: number; readonly names: readonly string[]; readonly mapped: boolean };
type CategoryReport = {
  readonly id: string;
  readonly observed: "both" | "gap" | "otel-hook-only" | "neither";
  readonly documented: string;
  readonly native: Side;
  readonly otelHook: Side;
};
type PersonalDataEntry = { readonly attribute: string; readonly where: string; readonly count: number };
type ParityReport = {
  readonly provider: string;
  readonly categories: readonly CategoryReport[];
  readonly summary: Readonly<Record<string, readonly string[]>>;
  readonly unmappedNative: readonly string[];
  readonly unmappedOtelHook: readonly string[];
  readonly personalData: {
    readonly native: readonly PersonalDataEntry[];
    readonly otelHook: readonly PersonalDataEntry[];
  };
};

type RunResult = { readonly code: number; readonly stdout: string; readonly stderr: string };

const runScript = async (args: readonly string[]): Promise<RunResult> => {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [SCRIPT, ...args], { cwd: REPO_ROOT });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? -1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
};

const compare = async (provider: string, native: string, otelHook: string): Promise<ParityReport> => {
  const result = await runScript(["--provider", provider, "--native", native, "--otel-hook", otelHook, "--json"]);
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  return JSON.parse(result.stdout) as ParityReport;
};

const category = (report: ParityReport, id: string): CategoryReport => {
  const found = report.categories.find((entry) => entry.id === id);
  if (found === undefined) {
    throw new Error(`category ${id} missing from report`);
  }
  return found;
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), "otel-hook-native-parity-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

// --- a minimal protobuf writer, enough for one ExportMetricsServiceRequest ---

const varint = (value: number): Buffer => {
  const bytes: number[] = [];
  let rest = value;
  while (rest > 0x7f) {
    bytes.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  bytes.push(rest);
  return Buffer.from(bytes);
};
const lengthDelimited = (field: number, payload: Buffer): Buffer =>
  Buffer.concat([varint((field << 3) | 2), varint(payload.length), payload]);
const stringField = (field: number, value: string): Buffer => lengthDelimited(field, Buffer.from(value, "utf8"));
const doubleField = (field: number, value: number): Buffer => {
  const payload = Buffer.alloc(8);
  payload.writeDoubleLE(value, 0);
  return Buffer.concat([varint((field << 3) | 1), payload]);
};
// KeyValue { 1: key, 2: AnyValue { 1: string_value } }
const keyValue = (field: number, key: string, value: string): Buffer =>
  lengthDelimited(field, Buffer.concat([stringField(1, key), lengthDelimited(2, stringField(1, value))]));

/** `claude_code.token.usage{type=input}` as http/protobuf, the way a native SDK posts it. */
const nativeTokenMetricProtobuf = (): Buffer => {
  const dataPoint = Buffer.concat([
    keyValue(7, "type", "input"),
    keyValue(7, "model", "synthetic-model"),
    keyValue(7, "user.email", "synthetic.user@example.invalid"),
    doubleField(4, 12),
  ]);
  const metric = Buffer.concat([
    stringField(1, "claude_code.token.usage"),
    lengthDelimited(7, lengthDelimited(1, dataPoint)),
  ]);
  const resource = keyValue(1, "service.name", "claude-code");
  const resourceMetrics = Buffer.concat([lengthDelimited(1, resource), lengthDelimited(2, lengthDelimited(2, metric))]);
  return lengthDelimited(1, resourceMetrics);
};

const captureFile = async (
  dir: string,
  name: string,
  meta: Record<string, unknown>,
  requests: readonly Record<string, unknown>[],
): Promise<string> => {
  const file = path.join(dir, name);
  await writeFile(file, [{ meta }, ...requests].map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
  return file;
};

describe("native telemetry parity script: synthetic Claude Code captures", () => {
  it("reports per-category verdicts for the synthetic pair", async () => {
    const report = await compare("claude-code", CLAUDE_NATIVE, CLAUDE_HOOK);

    expect(report.provider).toBe("claude-code");
    // Claude Code hooks carry no tokens or cost: native-only.
    for (const id of ["token.input", "token.output", "token.cache_read", "token.cache_write", "cost"]) {
      expect(category(report, id).observed).toBe("gap");
    }
    expect(category(report, "tool.calls").observed).toBe("both");
    expect(category(report, "prompts").observed).toBe("both");
    expect(category(report, "session.start").observed).toBe("both");
    // Native Claude Code has no session-end signal; otel-hook does.
    expect(category(report, "session.end").observed).toBe("otel-hook-only");
    expect(category(report, "session.end").native.mapped).toBe(false);
    // A cost category with no otel-hook matcher is "not mapped", not "zero found".
    expect(category(report, "cost").otelHook.mapped).toBe(false);
    // The generation's "unknown" model is not counted as model evidence; the
    // session.start record's requested model is.
    expect(category(report, "model").otelHook.count).toBe(1);
    expect(report.summary.gap).toContain("lines_of_code");
  });

  it("lists native names no category claims, so new provider signals surface", async () => {
    const report = await compare("claude-code", CLAUDE_NATIVE, CLAUDE_HOOK);
    expect(report.unmappedNative).toEqual(["log:hook_execution_complete"]);
    expect(report.unmappedOtelHook).toEqual([]);
  });

  it("flags personal-data keys on the native side and none on otel-hook, without printing values", async () => {
    const report = await compare("claude-code", CLAUDE_NATIVE, CLAUDE_HOOK);
    const nativeKeys = report.personalData.native.map((entry) => entry.attribute);
    expect(nativeKeys).toEqual(
      expect.arrayContaining(["user.email", "user.account_uuid", "organization.id", "user.id"]),
    );
    expect(report.personalData.otelHook).toEqual([]);

    const text = await runScript(["--provider", "claude-code", "--native", CLAUDE_NATIVE, "--otel-hook", CLAUDE_HOOK]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("user.email");
    expect(text.stdout).not.toContain("synthetic.user@example.invalid");
    expect(JSON.stringify(report)).not.toContain("synthetic.user@example.invalid");
  });

  it("decodes gzip http/protobuf metrics the way a native exporter sends them", async () => {
    const dir = await tempDir();
    const native = await captureFile(dir, "native.otlp.jsonl", { synthetic: true }, [
      {
        path: "/v1/metrics",
        contentType: "application/x-protobuf",
        contentEncoding: "gzip",
        bodyBase64: gzipSync(nativeTokenMetricProtobuf()).toString("base64"),
      },
    ]);
    const report = await compare("claude-code", native, CLAUDE_HOOK);

    expect(category(report, "token.input").native.count).toBe(1);
    expect(category(report, "token.output").native.count).toBe(0);
    expect(category(report, "model").native.count).toBe(1);
    expect(report.personalData.native.map((entry) => entry.attribute)).toEqual(["user.email"]);
  });

  it("flags an email-shaped value under an innocuous key", async () => {
    const dir = await tempDir();
    const native = await captureFile(dir, "native.otlp.jsonl", {}, [
      {
        path: "/v1/logs",
        body: {
          resourceLogs: [
            {
              scopeLogs: [
                {
                  logRecords: [
                    {
                      eventName: "claude_code.user_prompt",
                      attributes: [{ key: "actor", value: { stringValue: "someone@example.invalid" } }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    ]);
    const report = await compare("claude-code", native, CLAUDE_HOOK);
    expect(report.personalData.native).toEqual([
      { attribute: "actor", where: "attribute", reason: "value looks like an email address", count: 1 },
    ]);
  });

  it("exits 1 with --fail-on-gap when native has something otel-hook lacks, and 2 on bad input", async () => {
    const gaps = await runScript([
      "--provider",
      "claude-code",
      "--native",
      CLAUDE_NATIVE,
      "--otel-hook",
      CLAUDE_HOOK,
      "--fail-on-gap",
    ]);
    expect(gaps.code).toBe(1);

    const unknown = await runScript(["--provider", "no-such-agent", "--native", CLAUDE_NATIVE, "--otel-hook", CLAUDE_HOOK]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("no-such-agent");

    const usage = await runScript(["--provider", "claude-code"]);
    expect(usage.code).toBe(2);
  });
});

describe("native telemetry parity mapping data", () => {
  type Matcher = Record<string, unknown>;
  type ProviderEntry = {
    readonly sources: readonly string[];
    readonly nativeVersionDocumented: string;
    readonly native: Readonly<Record<string, readonly Matcher[]>>;
    readonly otelHook?: Readonly<Record<string, readonly Matcher[]>>;
    readonly documented: Readonly<Record<string, { readonly status: string }>>;
  };
  type Mapping = {
    readonly statuses: readonly string[];
    readonly categories: readonly { readonly id: string }[];
    readonly otelHook: Readonly<Record<string, readonly Matcher[]>>;
    readonly providers: Readonly<Record<string, ProviderEntry>>;
  };
  const MATCHER_KEYS = new Set([
    "signal",
    "name",
    "namePattern",
    "hasAttributes",
    "attributes",
    "notAttributes",
    "statusError",
    "minSeverity",
  ]);

  let mapping: Mapping;
  beforeAll(async () => {
    mapping = JSON.parse(await readFile(MAPPING, "utf8")) as Mapping;
  });

  it("covers the five providers the parity doc reports on", () => {
    expect(Object.keys(mapping.providers).sort()).toEqual(
      ["antigravity", "claude-code", "codex", "cursor", "gemini-cli"].sort(),
    );
  });

  it("gives every provider a documented status from the closed vocabulary for every category", () => {
    for (const [provider, entry] of Object.entries(mapping.providers)) {
      expect(entry.sources.length, provider).toBeGreaterThan(0);
      expect(entry.nativeVersionDocumented, provider).not.toBe("");
      for (const { id } of mapping.categories) {
        const status = entry.documented[id]?.status;
        expect(mapping.statuses, `${provider} ${id}`).toContain(status);
      }
    }
  });

  it("uses only matcher keys the script understands, and only known categories", () => {
    const ids = new Set(mapping.categories.map(({ id }) => id));
    const check = (owner: string, table: Readonly<Record<string, readonly Matcher[]>>): void => {
      for (const [id, matchers] of Object.entries(table)) {
        expect(ids.has(id), `${owner}: unknown category ${id}`).toBe(true);
        for (const matcher of matchers) {
          for (const key of Object.keys(matcher)) {
            expect(MATCHER_KEYS.has(key), `${owner} ${id}: unknown matcher key ${key}`).toBe(true);
          }
        }
      }
    };
    check("otelHook", mapping.otelHook);
    for (const [provider, entry] of Object.entries(mapping.providers)) {
      check(`${provider}.native`, entry.native);
      check(`${provider}.otelHook`, entry.otelHook ?? {});
    }
  });
});

describe("native telemetry parity script: against the real otel-hook binary", () => {
  beforeAll(async () => {
    await ensureBuiltCli();
  }, 300_000);

  const withCollector = async (): Promise<Collector> => {
    const collector = await startCollector();
    cleanups.push(() => collector.close());
    return collector;
  };

  it("decodes what otel-hook really sends and matches it with the shared otel-hook categories", async () => {
    const collector = await withCollector();
    const dir = await tempDir();
    const stateDir = path.join(dir, "state");
    const session = "native-parity-session-0001";
    const base = {
      session_id: session,
      transcript_path: "/workspace/synthetic-repo/.claude/transcript.jsonl",
      cwd: "/workspace/synthetic-repo",
    };
    const payloads = [
      { ...base, hook_event_name: "SessionStart", source: "startup", model: "synthetic-model" },
      { ...base, hook_event_name: "UserPromptSubmit", prompt_id: "p-1", prompt: "native-parity-secret-prompt" },
      {
        ...base,
        hook_event_name: "PreToolUse",
        prompt_id: "p-1",
        tool_use_id: "toolu_parity_0001",
        tool_name: "Bash",
        tool_input: { command: "echo synthetic" },
      },
      {
        ...base,
        hook_event_name: "PostToolUse",
        prompt_id: "p-1",
        tool_use_id: "toolu_parity_0001",
        tool_name: "Bash",
        tool_response: "synthetic",
      },
      { ...base, hook_event_name: "Stop", prompt_id: "p-1", stop_hook_active: false },
      { ...base, hook_event_name: "SessionEnd", reason: "other" },
    ];
    for (const payload of payloads) {
      const result = await runCliProcess(
        ["run", "--provider", "claude-code", "--endpoint", collector.url, "--logs", "--state-dir", stateDir],
        JSON.stringify(payload),
      );
      expect(result.code).toBe(0);
    }
    expect(collector.requests.length).toBeGreaterThan(0);

    const hookCapture = await captureFile(
      dir,
      "otel-hook.otlp.jsonl",
      { side: "otel-hook", provider: "claude-code", synthetic: true },
      collector.requests.map((request) => ({
        path: request.path,
        contentType: request.headers["content-type"],
        bodyBase64: request.body.toString("base64"),
      })),
    );
    const report = await compare("claude-code", CLAUDE_NATIVE, hookCapture);

    expect(category(report, "tool.calls").observed).toBe("both");
    expect(category(report, "tool.result").observed).toBe("both");
    expect(category(report, "prompts").observed).toBe("both");
    expect(category(report, "session.start").observed).toBe("both");
    expect(category(report, "session.end").observed).toBe("otel-hook-only");
    expect(category(report, "turns").otelHook.count).toBeGreaterThan(0);
    expect(category(report, "token.input").observed).toBe("gap");
    // Everything otel-hook sent is claimed by some category: a new otel-hook
    // signal must be placed in the mapping before it can drift out of the report.
    expect(report.unmappedOtelHook).toEqual([]);
    expect(report.personalData.otelHook).toEqual([]);
    expect(JSON.stringify(report)).not.toContain("native-parity-secret-prompt");
  }, 120_000);
});
