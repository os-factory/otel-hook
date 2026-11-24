import { readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PASSING_CAPTURE,
  copyPassingCapture,
  detailsOf,
  makeTempDir,
  runChecker,
  statusOf,
} from "./harness.js";

/**
 * The evidence checker (scripts/e2e-proof/check-evidence.mjs) against the
 * synthetic capture in tests/fixtures/e2e-proof (see its README for provenance).
 * Each failing case is the passing capture with one edit, so a test names
 * exactly the fact that turns a matrix row red.
 */

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const PASSING_ARGS = [
  "--session-id",
  "har-synthetic-session-0001",
  "--work-unit-id",
  "synthetic-56",
  "--expect-tool",
  "Read",
  "--expect-usage",
  "input=200,output=8,cache_read=80",
];

const mutableCopy = async (): Promise<string> => {
  const temp = await makeTempDir("otel-hook-evidence-");
  cleanups.push(() => temp.remove());
  return copyPassingCapture(path.join(temp.dir, "capture"));
};

type JsonBody = Record<string, unknown>;

/** Rewrite one OTLP/JSON body in a capture copy, keeping its metadata's byte count honest. */
const editBody = async (captureDir: string, stem: string, edit: (body: JsonBody) => void): Promise<void> => {
  const bodyPath = path.join(captureDir, `${stem}.body`);
  const body = JSON.parse(await readFile(bodyPath, "utf8")) as JsonBody;
  edit(body);
  const text = JSON.stringify(body);
  await writeFile(bodyPath, text);
  const metaPath = path.join(captureDir, `${stem}.json`);
  const meta = JSON.parse(await readFile(metaPath, "utf8")) as JsonBody;
  meta.bytes = Buffer.byteLength(text);
  await writeFile(metaPath, JSON.stringify(meta));
};

type KeyValue = { key: string; value: Record<string, unknown> };
type JsonSpan = { name: string; attributes: KeyValue[] };
type JsonLog = { attributes: KeyValue[]; timeUnixNano: string };

const resourceOf = (body: JsonBody): KeyValue[] => {
  const groups = (body.resourceSpans ?? body.resourceLogs) as { resource: { attributes: KeyValue[] } }[];
  const first = groups[0];
  if (first === undefined) {
    throw new Error("fixture body has no resource");
  }
  return first.resource.attributes;
};

const spansOf = (body: JsonBody): JsonSpan[] =>
  (body.resourceSpans as { scopeSpans: { spans: JsonSpan[] }[] }[]).flatMap((group) =>
    group.scopeSpans.flatMap((scope) => scope.spans),
  );

const logsOf = (body: JsonBody): JsonLog[] =>
  (body.resourceLogs as { scopeLogs: { logRecords: JsonLog[] }[] }[]).flatMap((group) =>
    group.scopeLogs.flatMap((scope) => scope.logRecords),
  );

const setAttribute = (attributes: KeyValue[], key: string, value: Record<string, unknown>): void => {
  const existing = attributes.find((entry) => entry.key === key);
  if (existing === undefined) {
    attributes.push({ key, value });
  } else {
    existing.value = value;
  }
};

describe("check-evidence: the passing synthetic capture", () => {
  it("passes every mechanical row and reports the manual ones", async () => {
    const { code, result } = await runChecker([PASSING_CAPTURE, ...PASSING_ARGS, "--provider", "claude-code"]);

    expect(code).toBe(0);
    expect(result?.ok).toBe(true);
    expect(result?.schema).toBe("otel-hook.e2e-proof.evidence/v1");
    expect(result?.provider).toBe("claude-code");
    for (const id of ["capture-integrity", "session-span", "profile-attributes", "tool-spans", "token-usage", "logs-signal", "spool-replay", "privacy"]) {
      expect({ id, status: statusOf(result, id) }).toEqual({ id, status: "pass" });
    }
    expect(statusOf(result, "headers-auth")).toBe("manual");
    expect(statusOf(result, "trace-proof")).toBe("manual");
    expect(statusOf(result, "multi-destination")).toBe("skip");
    // The empty body is evidence, recorded rather than dropped.
    expect(result?.summary.emptyRequests).toEqual([1]);
    expect(result?.summary.rejectedRequests).toEqual([3]);
    expect(result?.summary.launcherSessionIds).toEqual(["har-synthetic-session-0001"]);
  }, 30_000);

  it("renders a markdown snippet with one line per matrix row", async () => {
    const { code, stdout } = await runChecker([PASSING_CAPTURE, ...PASSING_ARGS, "--markdown"]);

    expect(code).toBe(0);
    expect(stdout).toContain("Result: **PASS**");
    expect(stdout).toContain("| Row | Check | Result | Evidence |");
    expect(stdout).toContain("| Session span with the launcher's `session.id` | `session-span` | PASS |");
    expect(stdout).toContain("| Trace ↔ Factory Commits proof correlation | `trace-proof` | manual |");
    expect(stdout).toContain("empty bodies: #1");
  }, 30_000);

  it("writes the JSON and markdown files when asked", async () => {
    const temp = await makeTempDir("otel-hook-evidence-out-");
    cleanups.push(() => temp.remove());
    const jsonOut = path.join(temp.dir, "evidence.json");
    const markdownOut = path.join(temp.dir, "evidence.md");

    const { code } = await runChecker([PASSING_CAPTURE, ...PASSING_ARGS, "--json-out", jsonOut, "--markdown-out", markdownOut]);

    expect(code).toBe(0);
    expect((JSON.parse(await readFile(jsonOut, "utf8")) as { ok: boolean }).ok).toBe(true);
    expect(await readFile(markdownOut, "utf8")).toContain("#### Receiver capture");
  }, 30_000);

  it("compares a second destination's capture", async () => {
    const same = await runChecker([PASSING_CAPTURE, PASSING_CAPTURE, ...PASSING_ARGS]);
    expect(statusOf(same.result, "multi-destination")).toBe("pass");

    const second = await mutableCopy();
    await rm(path.join(second, "0006-traces.json"));
    const differs = await runChecker([PASSING_CAPTURE, second, ...PASSING_ARGS]);
    expect(differs.code).toBe(1);
    expect(statusOf(differs.result, "multi-destination")).toBe("fail");
  }, 30_000);
});

describe("check-evidence: one edit away from passing", () => {
  it("fails the session row when the session span lacks the launcher's id", async () => {
    const { code, result } = await runChecker([PASSING_CAPTURE, ...PASSING_ARGS.slice(2), "--session-id", "har-some-other-session"]);

    expect(code).toBe(1);
    expect(statusOf(result, "session-span")).toBe("fail");
  }, 30_000);

  it("fails the session row when no session span was delivered", async () => {
    const capture = await mutableCopy();
    await rm(path.join(capture, "0006-traces.json"));

    const { result } = await runChecker([capture, ...PASSING_ARGS]);

    expect(statusOf(result, "session-span")).toBe("fail");
  }, 30_000);

  it("fails the profile row when a required profile attribute is missing", async () => {
    const capture = await mutableCopy();
    await editBody(capture, "0005-logs", (body) => {
      const resource = resourceOf(body);
      resource.splice(resource.findIndex((entry) => entry.key === "factory.work_unit.id"), 1);
    });

    const { result } = await runChecker([capture, ...PASSING_ARGS]);

    expect(statusOf(result, "profile-attributes")).toBe("fail");
    expect(detailsOf(result, "profile-attributes")).toContain("`factory.work_unit.id` missing on 4/9 records");
  }, 30_000);

  it("fails the tool row when an expected tool has no span", async () => {
    const { result } = await runChecker([PASSING_CAPTURE, ...PASSING_ARGS, "--expect-tool", "Bash"]);

    expect(statusOf(result, "tool-spans")).toBe("fail");
    expect(detailsOf(result, "tool-spans")).toContain("`Bash`");
  }, 30_000);

  it("fails the usage row when summed deltas disagree with the agent's own totals", async () => {
    const { result } = await runChecker([PASSING_CAPTURE, ...PASSING_ARGS.slice(0, -1), "input=220,output=32"]);

    expect(statusOf(result, "token-usage")).toBe("fail");
    expect(detailsOf(result, "token-usage")).toContain("exported input tokens 200 ≠ expected 220");
  }, 30_000);

  it("counts a session's running totals once rather than summing them", async () => {
    const capture = await mutableCopy();
    await editBody(capture, "0004-traces", (body) => {
      for (const span of spansOf(body)) {
        if (span.name.startsWith("generation")) {
          setAttribute(span.attributes, "otelhook.usage.temporality", { stringValue: "cumulative" });
        }
      }
    });

    const { result } = await runChecker([capture, ...PASSING_ARGS]);

    expect(statusOf(result, "token-usage")).toBe("pass");
    expect(detailsOf(result, "token-usage")).toContain("generation spans: 0 delta, 1 cumulative");
  }, 30_000);

  it("fails the usage row when usage has no temporality", async () => {
    const capture = await mutableCopy();
    await editBody(capture, "0004-traces", (body) => {
      for (const span of spansOf(body)) {
        span.attributes = span.attributes.filter((entry) => entry.key !== "otelhook.usage.temporality");
      }
    });

    const { result } = await runChecker([capture, ...PASSING_ARGS]);

    expect(statusOf(result, "token-usage")).toBe("fail");
  }, 30_000);

  it("fails the usage row when a cumulative total goes down", async () => {
    const capture = await mutableCopy();
    await editBody(capture, "0005-logs", (body) => {
      const logs = logsOf(body);
      const generationEnd = logs.find((log) => log.attributes.some((entry) => entry.value.stringValue === "generation.end"));
      const sessionEnd = logs.find((log) => log.attributes.some((entry) => entry.value.stringValue === "session.end"));
      if (generationEnd === undefined || sessionEnd === undefined) {
        throw new Error("fixture is missing its generation.end or session.end log");
      }
      setAttribute(generationEnd.attributes, "otelhook.usage.temporality", { stringValue: "cumulative" });
      setAttribute(sessionEnd.attributes, "otelhook.usage.temporality", { stringValue: "cumulative" });
      setAttribute(sessionEnd.attributes, "gen_ai.usage.input_tokens", { intValue: "150" });
      setAttribute(sessionEnd.attributes, "gen_ai.usage.output_tokens", { intValue: "8" });
    });

    const { result } = await runChecker([capture, ...PASSING_ARGS]);

    expect(statusOf(result, "token-usage")).toBe("fail");
    expect(detailsOf(result, "token-usage")).toContain("cumulative input went down (200 → 150)");
  }, 30_000);

  it("fails the logs row when no log record was delivered", async () => {
    const capture = await mutableCopy();
    await rm(path.join(capture, "0002-logs.json"));
    await rm(path.join(capture, "0005-logs.json"));

    const { result } = await runChecker([capture, ...PASSING_ARGS]);

    expect(statusOf(result, "logs-signal")).toBe("fail");
  }, 30_000);

  it("fails spool replay when a rejected batch never arrives later", async () => {
    const capture = await mutableCopy();
    await rm(path.join(capture, "0004-traces.json"));

    const { result } = await runChecker([capture, ...PASSING_ARGS]);

    expect(statusOf(result, "spool-replay")).toBe("fail");
  }, 30_000);

  it("fails privacy on factory.local.*, local paths and account identity, without echoing them", async () => {
    const capture = await mutableCopy();
    const localPath = "/home/synthetic-person/checkouts/sandbox";
    const email = "synthetic.person@example.invalid";
    await editBody(capture, "0006-traces", (body) => {
      setAttribute(resourceOf(body), "factory.local.checkout_path", { stringValue: localPath });
      const span = spansOf(body)[0];
      if (span === undefined) {
        throw new Error("fixture has no session span");
      }
      setAttribute(span.attributes, "user.email", { stringValue: email });
    });

    const { code, stdout, result } = await runChecker([capture, ...PASSING_ARGS]);

    expect(code).toBe(1);
    expect(statusOf(result, "privacy")).toBe("fail");
    const details = detailsOf(result, "privacy");
    expect(details).toContain("`factory.local.checkout_path` exported (resource) in request #6");
    expect(details).toContain("account-identity key `user.email`");
    expect(details).toContain("absolute path in `factory.local.checkout_path`");
    expect(details).toContain("email-shaped value in request #6");
    // The report itself is safe to paste into a public issue.
    expect(stdout).not.toContain(localPath);
    expect(stdout).not.toContain("synthetic-person");
    expect(stdout).not.toContain(email);
  }, 30_000);

  it("fails privacy on credentials in a repository URL", async () => {
    const capture = await mutableCopy();
    await editBody(capture, "0006-traces", (body) => {
      setAttribute(resourceOf(body), "vcs.repository.url.full", { stringValue: "https://synthetic:token@example.invalid/sandbox.git" });
    });

    const { result } = await runChecker([capture, ...PASSING_ARGS]);

    expect(statusOf(result, "privacy")).toBe("fail");
    expect(detailsOf(result, "privacy")).toContain("URL with embedded credentials");
  }, 30_000);

  it("fails privacy on a caller-supplied forbidden value, naming it only by position", async () => {
    const { code, stdout, result } = await runChecker([PASSING_CAPTURE, ...PASSING_ARGS, "--forbid", "proof/synthetic"]);

    expect(code).toBe(1);
    expect(detailsOf(result, "privacy")).toContain("forbidden value #1 (15 chars)");
    expect(stdout).not.toContain("proof/synthetic");
  }, 30_000);

  it("rejects a malformed --expect-usage as a usage error", async () => {
    const { code, stderr } = await runChecker([PASSING_CAPTURE, "--expect-usage", "inputs=1"]);

    expect(code).toBe(2);
    expect(stderr).toContain("--expect-usage");
  }, 30_000);
});
