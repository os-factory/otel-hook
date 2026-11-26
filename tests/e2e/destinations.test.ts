/**
 * Multiple OTLP destinations, end to end through the built CLI.
 *
 * Every receiver here is a local, ephemeral HTTP server; every payload is a
 * synthetic Claude Code hook payload written for this test. Nothing is copied from
 * a real session.
 */
import { readdir, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { decodeAllExportedSpans, type DecodedSpan } from "../helpers/otlp.js";
import {
  ensureBuiltCli,
  makeStateDir,
  runCliProcess,
  startCollector,
  type CliResult,
  type Collector,
} from "./harness.js";

beforeAll(async () => {
  await ensureBuiltCli();
}, 300_000);

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const withCollector = async (
  respond?: Parameters<typeof startCollector>[0],
  port?: number,
): Promise<Collector> => {
  const collector = await startCollector(respond, port === undefined ? {} : { port });
  let closed = false;
  cleanups.push(() => (closed ? Promise.resolve() : collector.close()));
  return {
    ...collector,
    close: async (): Promise<void> => {
      closed = true;
      await collector.close();
    },
  };
};

const withStateDir = async (): Promise<string> => {
  const state = await makeStateDir();
  cleanups.push(() => state.remove());
  return state.dir;
};

const writeConfig = async (dir: string, config: unknown): Promise<string> => {
  const file = path.join(dir, "otel-hook.json");
  await writeFile(file, JSON.stringify(config), "utf8");
  return file;
};

const base = (sessionId: string) => ({
  session_id: sessionId,
  transcript_path: "/workspace/fixture-repo/.claude/transcript.jsonl",
  cwd: "/workspace/fixture-repo",
});

const prompt = (sessionId: string, turn: number) => ({
  ...base(sessionId),
  hook_event_name: "UserPromptSubmit",
  prompt: `synthetic prompt ${String(turn)}`,
});

const toolStart = (sessionId: string, id: string) => ({
  ...base(sessionId),
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "ls" },
  tool_use_id: id,
});

const toolEnd = (sessionId: string, id: string) => ({
  ...base(sessionId),
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  tool_input: { command: "ls" },
  tool_response: { stdout: "" },
  tool_use_id: id,
});

const runHook = (
  config: string,
  stateDir: string,
  payload: unknown,
  env: Readonly<Record<string, string>> = {},
): Promise<CliResult> =>
  runCliProcess(
    [
      "run",
      "--provider",
      "claude-code",
      "--config-file",
      config,
      "--state-dir",
      stateDir,
      "--timeout-ms",
      "1000",
      "--flush-timeout-ms",
      "5000",
    ],
    JSON.stringify(payload),
    { env, timeoutMillis: 60_000 },
  );

const spanKeys = (spans: readonly DecodedSpan[]): string[] =>
  spans.map((span) => `${span.traceId}/${span.spanId}/${span.name}`).sort();

const spansOf = (collector: Collector): readonly DecodedSpan[] =>
  decodeAllExportedSpans(
    collector.requests.filter((request) => request.path === "/v1/traces").map((request) => request.body),
  );

const queuedFiles = async (stateDir: string, destination: string): Promise<string[]> => {
  try {
    const entries = await readdir(
      path.join(stateDir, "claude-code", "default", "destinations", destination, "spool"),
    );
    return entries.filter((entry) => entry.endsWith(".json"));
  } catch {
    return [];
  }
};

describe("otel-hook run: multiple destinations", () => {
  it("sends the same spans for one session to every destination, and to the default one", async () => {
    const first = await withCollector();
    const second = await withCollector();
    const legacy = await withCollector();
    const stateDir = await withStateDir();
    const config = await writeConfig(stateDir, {
      exporter: {
        destinations: [
          { name: "first", endpoint: first.url },
          { name: "second", endpoint: second.url },
        ],
      },
    });
    const session = "ses-e2e-fanout";
    // The standard variable still describes one destination, `default`, so an
    // existing setup keeps receiving alongside the new list.
    const env = { OTEL_EXPORTER_OTLP_ENDPOINT: legacy.url };

    for (const payload of [
      prompt(session, 1),
      toolStart(session, "toolu_fanout_1"),
      toolEnd(session, "toolu_fanout_1"),
    ]) {
      const result = await runHook(config, stateDir, payload, env);
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("");
    }

    const expected = spanKeys(spansOf(first));
    expect(expected.length).toBeGreaterThanOrEqual(2);
    expect(spanKeys(spansOf(second))).toEqual(expected);
    expect(spanKeys(spansOf(legacy))).toEqual(expected);
    // A start-only callback (PreToolUse) has no span to send, so no destination
    // receives a request for it — in particular, never an empty one.
    for (const collector of [first, second, legacy]) {
      expect(collector.requests.every((request) => request.body.length > 0)).toBe(true);
      expect(collector.requests).toHaveLength(2);
    }
  }, 120_000);

  it("keeps delivering to a healthy destination while another refuses connections, then catches the other up", async () => {
    const healthy = await withCollector();
    const flaky = await withCollector();
    const flakyPort = flaky.port;
    await flaky.close();
    const stateDir = await withStateDir();
    const config = await writeConfig(stateDir, {
      exporter: {
        // Hooks skip an endpoint that refused connections for this long; short
        // here so the test does not wait out the 30 s default.
        endpointDownMillis: 500,
        destinations: [
          { name: "healthy", endpoint: healthy.url },
          { name: "flaky", endpoint: `http://127.0.0.1:${String(flakyPort)}/v1/traces` },
        ],
      },
    });
    const session = "ses-e2e-refused";

    const down = await runHook(config, stateDir, prompt(session, 1));
    expect(down.code).toBe(0);
    expect(down.stdout).toBe("");
    expect(down.stderr).toContain("flaky");
    expect(spansOf(healthy)).toHaveLength(1);
    expect(await queuedFiles(stateDir, "flaky")).toHaveLength(1);
    expect(await queuedFiles(stateDir, "healthy")).toHaveLength(0);

    // The receiver comes back on the same port; once the down window is over,
    // the next hook event probes it, sends its own batch, and drains the spool.
    const back = await withCollector(undefined, flakyPort);
    await new Promise((resolve) => setTimeout(resolve, 600));
    const up = await runHook(config, stateDir, prompt(session, 2));
    expect(up.code).toBe(0);

    expect(spansOf(healthy)).toHaveLength(2);
    expect(spanKeys(spansOf(back))).toEqual(spanKeys(spansOf(healthy)));
    expect(await queuedFiles(stateDir, "flaky")).toHaveLength(0);
  }, 120_000);

  it("spools a batch a destination answers 503 for, and delivers it once the destination recovers", async () => {
    const healthy = await withCollector();
    let unavailable = true;
    const recovering = await withCollector(() => ({ status: unavailable ? 503 : 200 }));
    const stateDir = await withStateDir();
    const config = await writeConfig(stateDir, {
      exporter: {
        destinations: [
          { name: "healthy", endpoint: healthy.url },
          { name: "recovering", endpoint: recovering.url },
        ],
      },
    });
    const session = "ses-e2e-503";

    const first = await runHook(config, stateDir, prompt(session, 1));
    expect(first.code).toBe(0);
    expect(spansOf(healthy)).toHaveLength(1);
    // Every attempt (the exporter's own in-process retries included) was answered 503.
    const refusedAttempts = recovering.requests.length;
    expect(refusedAttempts).toBeGreaterThanOrEqual(1);
    expect(await queuedFiles(stateDir, "recovering")).toHaveLength(1);

    unavailable = false;
    const second = await runHook(config, stateDir, prompt(session, 2));
    expect(second.code).toBe(0);
    const accepted = recovering.requests.slice(refusedAttempts).map((request) => request.body);
    expect(accepted).toHaveLength(2);
    expect(spanKeys(decodeAllExportedSpans(accepted))).toEqual(spanKeys(spansOf(healthy)));
    expect(await queuedFiles(stateDir, "recovering")).toHaveLength(0);
  }, 120_000);

  it("does not spool a batch a destination refused outright", async () => {
    const healthy = await withCollector();
    const refusing = await withCollector(() => ({ status: 400 }));
    const stateDir = await withStateDir();
    const config = await writeConfig(stateDir, {
      exporter: {
        destinations: [
          { name: "healthy", endpoint: healthy.url },
          { name: "refusing", endpoint: refusing.url },
        ],
      },
    });
    const result = await runHook(config, stateDir, prompt("ses-e2e-400", 1));
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("non-retryable");
    expect(spansOf(healthy)).toHaveLength(1);
    expect(await queuedFiles(stateDir, "refusing")).toHaveLength(0);
  }, 60_000);

  it("resolves env: header references at send time and never prints the value", async () => {
    const secret = "Bearer synthetic-destination-secret-0001";
    const collector = await withCollector();
    const stateDir = await withStateDir();
    const config = await writeConfig(stateDir, {
      exporter: {
        destinations: [
          {
            name: "authed",
            endpoint: collector.url,
            headers: { authorization: "env:E2E_DESTINATION_TOKEN", "x-tenant": "synthetic-tenant" },
          },
        ],
      },
    });

    const sent = await runHook(config, stateDir, prompt("ses-e2e-env", 1), {
      E2E_DESTINATION_TOKEN: secret,
      OTEL_HOOK_LOG_LEVEL: "debug",
    });
    expect(sent.code).toBe(0);
    expect(collector.requests).toHaveLength(1);
    expect(collector.requests[0]?.headers.authorization).toBe(secret);
    expect(collector.requests[0]?.headers["x-tenant"]).toBe("synthetic-tenant");
    expect(sent.stderr).not.toContain("synthetic-destination-secret");

    // Unset: the destination sits the invocation out and says which variable.
    const skipped = await runHook(config, stateDir, prompt("ses-e2e-env", 2));
    expect(skipped.code).toBe(0);
    expect(skipped.stderr).toContain("E2E_DESTINATION_TOKEN");
    expect(collector.requests).toHaveLength(1);
  }, 60_000);
});

describe("otel-hook doctor: destinations", () => {
  type DoctorJson = {
    ok: boolean;
    checks: { name: string; ok: boolean; detail: string }[];
    destinations: {
      name: string;
      ok: boolean;
      missingVariables: string[];
      headerVariables: string[];
      spool?: { traces?: { batches: number; dropped: { total: number; count: number } } };
    }[];
  };

  it("names a missing header variable, and never prints a header value", async () => {
    const secret = "Bearer doctor-secret-must-not-appear-0002";
    const literal = "literal-tenant-must-not-appear-0003";
    const stateDir = await withStateDir();
    const config = await writeConfig(stateDir, {
      exporter: {
        destinations: [
          {
            name: "langfuse",
            endpoint: "http://127.0.0.1:9/api/public/otel/v1/traces",
            headers: { authorization: "env:DOCTOR_LANGFUSE_AUTH" },
          },
          {
            name: "collector",
            endpoint: "http://127.0.0.1:9/v1/traces",
            headers: { "x-tenant": literal, "x-key": "env:DOCTOR_COLLECTOR_KEY" },
          },
        ],
      },
    });
    const args = ["doctor", "--config-file", config, "--state-dir", stateDir];

    const missing = await runCliProcess([...args, "--json"], "", {
      env: { DOCTOR_COLLECTOR_KEY: secret },
    });
    const report = JSON.parse(missing.stdout) as DoctorJson;
    expect(missing.code).toBe(1);
    const langfuse = report.destinations.find((entry) => entry.name === "langfuse");
    expect(langfuse).toMatchObject({ ok: false, missingVariables: ["DOCTOR_LANGFUSE_AUTH"] });
    expect(report.destinations.find((entry) => entry.name === "collector")).toMatchObject({
      ok: true,
      missingVariables: [],
      headerVariables: ["DOCTOR_COLLECTOR_KEY"],
    });
    expect(report.checks.find((check) => check.name === "destinations")?.detail).toContain(
      "DOCTOR_LANGFUSE_AUTH",
    );

    const text = await runCliProcess(args, "", { env: { DOCTOR_COLLECTOR_KEY: secret } });
    expect(text.stdout).toContain("MISSING DOCTOR_LANGFUSE_AUTH");

    for (const output of [missing.stdout, missing.stderr, text.stdout, text.stderr]) {
      expect(output).not.toContain("doctor-secret-must-not-appear");
      expect(output).not.toContain(literal);
    }

    const resolved = await runCliProcess([...args, "--json"], "", {
      env: { DOCTOR_COLLECTOR_KEY: secret, DOCTOR_LANGFUSE_AUTH: secret },
    });
    expect((JSON.parse(resolved.stdout) as DoctorJson).destinations.every((entry) => entry.ok)).toBe(
      true,
    );
    expect(resolved.stdout).not.toContain("doctor-secret-must-not-appear");
  }, 60_000);

  it("names, and never prints, the default destination's OTEL_EXPORTER_OTLP_*HEADERS values", async () => {
    const generic = "Basic%20env-generic-secret-must-not-appear-0004";
    const traces = "env-traces-secret-must-not-appear-0005";
    const stateDir = await withStateDir();
    const config = await writeConfig(stateDir, {
      exporter: {
        endpoint: "http://127.0.0.1:9/v1/traces",
        destinations: [{ name: "collector", endpoint: "http://127.0.0.1:9/v1/traces" }],
      },
    });
    const env = {
      OTEL_EXPORTER_OTLP_HEADERS: `authorization=${generic}`,
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: `x-api-key=${traces}`,
    };
    const args = ["doctor", "--config-file", config, "--state-dir", stateDir];
    const json = await runCliProcess([...args, "--json"], "", { env });
    const text = await runCliProcess(args, "", { env });

    const report = JSON.parse(json.stdout) as {
      destinations: { name: string; headerNames: string[] }[];
    };
    expect(report.destinations.find((entry) => entry.name === "default")?.headerNames).toEqual([
      "authorization",
      "x-api-key",
    ]);
    expect(report.destinations.find((entry) => entry.name === "collector")?.headerNames).toEqual([]);
    for (const output of [json.stdout, json.stderr, text.stdout, text.stderr]) {
      expect(output).not.toContain("must-not-appear");
    }
  }, 60_000);

  it("reports a destination's queued batches and the batches its spool bound dropped", async () => {
    const healthy = await withCollector();
    const down = await withCollector();
    const downPort = down.port;
    await down.close();
    const stateDir = await withStateDir();
    const config = await writeConfig(stateDir, {
      exporter: {
        spool: { maxBatches: 1 },
        destinations: [
          { name: "healthy", endpoint: healthy.url },
          { name: "down", endpoint: `http://127.0.0.1:${String(downPort)}/v1/traces` },
        ],
      },
    });
    for (const turn of [1, 2, 3]) {
      const result = await runHook(config, stateDir, prompt("ses-e2e-drops", turn));
      expect(result.code).toBe(0);
    }

    const doctor = await runCliProcess(
      ["doctor", "--json", "--config-file", config, "--state-dir", stateDir],
      "",
    );
    const report = JSON.parse(doctor.stdout) as DoctorJson;
    const entry = report.destinations.find((destination) => destination.name === "down");
    expect(entry?.spool?.traces?.batches).toBe(1);
    // Each later failure evicted the one batch before it: oldest first, counted.
    expect(entry?.spool?.traces?.dropped).toMatchObject({ total: 2, count: 2 });

    const text = await runCliProcess(["doctor", "--config-file", config, "--state-dir", stateDir], "");
    expect(text.stdout).toMatch(/destination down: .*dropped 2/);
  }, 120_000);
});
