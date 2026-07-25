import { readdir } from "node:fs/promises";
import * as path from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  ensureBuiltCli,
  findProviderCase,
  makeStateDir,
  PROVIDER_CASES,
  runCliProcess,
  startCollector,
  unreachableCollectorUrl,
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
): Promise<Collector> => {
  const collector = await startCollector(respond);
  cleanups.push(() => collector.close());
  return collector;
};

const withStateDir = async (): Promise<string> => {
  const state = await makeStateDir();
  cleanups.push(() => state.remove());
  return state.dir;
};

describe("otel-hook CLI: non-hook commands", () => {
  it("reports its version and nothing else", async () => {
    const result = await runCliProcess(["--version"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("0.0.0\n");
    expect(result.stderr).toBe("");
  });

  it("lists every provider with its capabilities and maturity as JSON", async () => {
    const result = await runCliProcess(["providers", "--json"]);
    expect(result.code).toBe(0);
    const listing = JSON.parse(result.stdout) as readonly {
      id: string;
      maturity: string;
      lifecycleEvents: readonly string[];
      requiresHookResponse: boolean;
      registrationSupported: boolean;
    }[];

    expect(listing.map((entry) => entry.id)).toEqual([
      "antigravity",
      "claude-code",
      "codex",
      "cursor",
      "gemini-cli",
    ]);
    // Antigravity's mapping is a reconstruction; that must stay visible to a
    // consumer reading the catalog, not just to someone reading the source.
    expect(listing.find((entry) => entry.id === "antigravity")?.maturity).toBe("experimental");
    expect(
      listing.filter((entry) => entry.id !== "antigravity").every((entry) => entry.maturity === "stable"),
    ).toBe(true);
    // Cursor is the one provider whose protocol reads a response from stdout.
    expect(listing.filter((entry) => entry.requiresHookResponse).map((entry) => entry.id)).toEqual([
      "cursor",
    ]);
    expect(
      listing.filter((entry) => entry.registrationSupported).map((entry) => entry.id),
    ).toEqual(["antigravity", "gemini-cli"]);
  });

  it("excludes the experimental adapter on request", async () => {
    const result = await runCliProcess(["providers", "--json", "--no-experimental"]);
    const listing = JSON.parse(result.stdout) as readonly { id: string }[];
    expect(listing.map((entry) => entry.id)).not.toContain("antigravity");
  });

  it("reports health as JSON and fails when the exporter is unconfigured", async () => {
    const stateDir = await withStateDir();
    const result = await runCliProcess(["doctor", "--json", "--state-dir", stateDir]);
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      version: string;
      checks: readonly { name: string; ok: boolean }[];
      config: Record<string, unknown>;
      state: { writable: boolean };
    };

    expect(report.version).toBe("0.0.0");
    expect(report.state.writable).toBe(true);
    expect(report.checks.find((check) => check.name === "state-store")?.ok).toBe(true);
    // No endpoint configured, so the exporter check fails and the exit code says so.
    expect(report.checks.find((check) => check.name === "exporter")?.ok).toBe(false);
    expect(report.ok).toBe(false);
    expect(result.code).toBe(1);
  });

  it("passes doctor once an endpoint is configured, and never leaks header values", async () => {
    const collector = await withCollector();
    const stateDir = await withStateDir();
    const result = await runCliProcess([
      "doctor",
      "--json",
      "--state-dir",
      stateDir,
      "--endpoint",
      collector.url,
      "--header",
      "authorization=Bearer super-secret-token-value",
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("super-secret-token-value");
    const report = JSON.parse(result.stdout) as { ok: boolean; config: Record<string, unknown> };
    expect(report.ok).toBe(true);
    expect(report.config["exporter.header_names"]).toEqual(["authorization"]);
    // Doctor is a local diagnostic: it must not send anything.
    expect(collector.requests).toHaveLength(0);
  });

  it("rejects an unknown command with a usage exit code", async () => {
    const result = await runCliProcess(["frobnicate"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('unknown command "frobnicate"');
  });
});

describe("otel-hook run: every registered provider", () => {
  for (const providerCase of PROVIDER_CASES) {
    it(`processes a ${providerCase.providerId} payload, exports it, and writes exactly the required stdout`, async () => {
      const collector = await withCollector();
      const stateDir = await withStateDir();
      const sessionId = `ses-e2e-${providerCase.providerId}`;

      const result = await runCliProcess(
        [
          "run",
          "--provider",
          providerCase.providerId,
          "--endpoint",
          collector.url,
          "--state-dir",
          stateDir,
        ],
        JSON.stringify(providerCase.payload(sessionId)),
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toBe(providerCase.expectedStdout);
      expect(collector.requests.length).toBeGreaterThanOrEqual(1);

      const exported = collector.text();
      expect(exported).toContain(sessionId);
      // Default privacy posture, asserted on the bytes that actually left the
      // process rather than on an in-memory event.
      expect(exported).not.toContain(providerCase.secret);
      // No raw filesystem path reaches the wire: workspace identity is an opaque
      // salted handle by construction.
      expect(exported).not.toContain("/workspace/fixture-repo");
    });
  }

  it("warns visibly when the selected adapter is experimental", async () => {
    const stateDir = await withStateDir();
    const providerCase = findProviderCase("antigravity");
    const result = await runCliProcess(
      ["run", "--provider", "antigravity", "--no-export", "--state-dir", stateDir],
      JSON.stringify(providerCase.payload("ses-e2e-experimental")),
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("experimental");
  });
});

describe("otel-hook run: refusals", () => {
  it("exits 0 on malformed JSON without writing stdout", async () => {
    const stateDir = await withStateDir();
    const result = await runCliProcess(
      ["run", "--provider", "claude-code", "--no-export", "--state-dir", stateDir],
      "{not json at all",
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("not a single well-formed JSON value");
  });

  it("rejects a stream carrying more than one JSON value", async () => {
    const stateDir = await withStateDir();
    const providerCase = findProviderCase("claude-code");
    const twice = `${JSON.stringify(providerCase.payload("ses-a"))}${JSON.stringify(
      providerCase.payload("ses-b"),
    )}`;
    const result = await runCliProcess(
      ["run", "--provider", "claude-code", "--no-export", "--state-dir", stateDir],
      twice,
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("not a single well-formed JSON value");
  });

  it("rejects input beyond the configured bound", async () => {
    const stateDir = await withStateDir();
    const result = await runCliProcess(
      [
        "run",
        "--provider",
        "claude-code",
        "--no-export",
        "--state-dir",
        stateDir,
        "--max-input-bytes",
        "64",
      ],
      JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt: "x".repeat(500) }),
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("exceeded the 64-byte bound");
  });

  it("exits 0 on an empty stream", async () => {
    const stateDir = await withStateDir();
    const result = await runCliProcess(
      ["run", "--provider", "claude-code", "--no-export", "--state-dir", stateDir],
      "",
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("stdin was empty");
  });

  it("names the registered providers when asked for an unknown one", async () => {
    const result = await runCliProcess(["run", "--provider", "not-a-provider", "--no-export"], "{}");
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unknown provider");
    expect(result.stderr).toContain("not-a-provider");
    expect(result.stderr).toContain("claude-code");
  });

  it("refuses an ambiguous auto-detection and never falls back to claude", async () => {
    const collector = await withCollector();
    const stateDir = await withStateDir();
    // A real Claude Code SessionStart payload. Three adapters recognize it,
    // because Claude Code, Codex, and the Gemini CLI share PascalCase hook event
    // names — and the Gemini adapter even scores it `exact`. Attributing it by
    // confidence comparison would file Claude Code telemetry under another
    // provider's id.
    const payload = {
      hook_event_name: "SessionStart",
      session_id: "ses-e2e-ambiguous",
      transcript_path: "/workspace/fixture-repo/.claude/transcript.jsonl",
      cwd: "/workspace/fixture-repo",
      source: "startup",
    };

    const result = await runCliProcess(
      ["run", "--endpoint", collector.url, "--state-dir", stateDir],
      JSON.stringify(payload),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("auto-detection refused");
    expect(result.stderr).toContain("claude-code");
    expect(result.stderr).toContain("--provider");
    expect(collector.requests).toHaveLength(0);
  });

  it("auto-detects a payload only one adapter recognizes", async () => {
    const collector = await withCollector();
    const stateDir = await withStateDir();
    const providerCase = findProviderCase("cursor");
    const result = await runCliProcess(
      ["run", "--endpoint", collector.url, "--state-dir", stateDir],
      JSON.stringify(providerCase.payload("ses-e2e-autodetect")),
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(providerCase.expectedStdout);
    expect(collector.text()).toContain("ses-e2e-autodetect");
  });

  it("refuses when no adapter recognizes the payload", async () => {
    const stateDir = await withStateDir();
    const result = await runCliProcess(
      ["run", "--no-export", "--state-dir", stateDir],
      JSON.stringify({ totally: "unrelated" }),
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("no registered adapter recognized this payload");
  });

  it("declines attribution when caller identity conflicts with the payload", async () => {
    const collector = await withCollector();
    const stateDir = await withStateDir();
    const providerCase = findProviderCase("claude-code");

    const result = await runCliProcess(
      [
        "run",
        "--provider",
        "claude-code",
        "--endpoint",
        collector.url,
        "--state-dir",
        stateDir,
        "--session-id",
        "ses-asserted-by-caller",
      ],
      JSON.stringify(providerCase.payload("ses-in-the-payload")),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("identity-conflict");
    // Fail-closed attribution: nothing is exported under either session id.
    expect(collector.requests).toHaveLength(0);
  });

  it("accepts caller identity that agrees with the payload", async () => {
    const collector = await withCollector();
    const stateDir = await withStateDir();
    const providerCase = findProviderCase("claude-code");
    const sessionId = "ses-agreeing-identity";

    const result = await runCliProcess(
      [
        "run",
        "--provider",
        "claude-code",
        "--endpoint",
        collector.url,
        "--state-dir",
        stateDir,
        "--session-id",
        sessionId,
      ],
      JSON.stringify(providerCase.payload(sessionId)),
    );

    expect(result.code).toBe(0);
    expect(collector.text()).toContain(sessionId);
  });
});

describe("otel-hook run: delivery failures stay fail-open", () => {
  it("exits 0 and spools the batch when the collector is unreachable", async () => {
    const stateDir = await withStateDir();
    const endpoint = await unreachableCollectorUrl();
    const providerCase = findProviderCase("claude-code");

    const result = await runCliProcess(
      [
        "run",
        "--provider",
        "claude-code",
        "--endpoint",
        endpoint,
        "--state-dir",
        stateDir,
        "--timeout-ms",
        "500",
        "--flush-timeout-ms",
        "3000",
      ],
      JSON.stringify(providerCase.payload("ses-e2e-unreachable")),
      { timeoutMillis: 60_000 },
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");

    // The observation is not lost: it is persisted for a later invocation to
    // retry, which is what "no daemon" costs and buys.
    const spoolDir = path.join(stateDir, "claude-code", "default", "spool");
    const spooled = await readdir(spoolDir);
    expect(spooled.filter((entry) => entry.endsWith(".json")).length).toBeGreaterThanOrEqual(1);
  }, 90_000);

  it("exits 0 when the collector rejects the batch outright", async () => {
    const collector = await withCollector(() => ({ status: 400 }));
    const stateDir = await withStateDir();
    const providerCase = findProviderCase("cursor");

    const result = await runCliProcess(
      [
        "run",
        "--provider",
        "cursor",
        "--endpoint",
        collector.url,
        "--state-dir",
        stateDir,
        "--no-spool",
        "--timeout-ms",
        "1000",
      ],
      JSON.stringify(providerCase.payload("ses-e2e-rejected")),
      { timeoutMillis: 60_000 },
    );

    expect(result.code).toBe(0);
    // The protocol response is still exactly right: telemetry delivery and the
    // host's hook contract are independent.
    expect(result.stdout).toBe(providerCase.expectedStdout);
    expect(result.stderr).toContain("telemetry-export-failure");
  }, 60_000);
});

describe("otel-hook run: identity isolation and concurrency", () => {
  it("keeps two processes' identities entirely separate", async () => {
    const first = await withCollector();
    const second = await withCollector();
    const stateDir = await withStateDir();
    const providerCase = findProviderCase("claude-code");

    const [resultA, resultB] = await Promise.all([
      runCliProcess(
        ["run", "--provider", "claude-code", "--endpoint", first.url, "--state-dir", stateDir],
        JSON.stringify(providerCase.payload("ses-isolation-alpha")),
      ),
      runCliProcess(
        ["run", "--provider", "claude-code", "--endpoint", second.url, "--state-dir", stateDir],
        JSON.stringify(providerCase.payload("ses-isolation-beta")),
      ),
    ]);

    expect(resultA.code).toBe(0);
    expect(resultB.code).toBe(0);

    expect(first.text()).toContain("ses-isolation-alpha");
    expect(first.text()).not.toContain("ses-isolation-beta");
    expect(second.text()).toContain("ses-isolation-beta");
    expect(second.text()).not.toContain("ses-isolation-alpha");
  }, 60_000);

  it("handles concurrent invocations across every provider without cross-contamination", async () => {
    const collector = await withCollector();
    const stateDir = await withStateDir();

    const results = await Promise.all(
      PROVIDER_CASES.map((providerCase) =>
        runCliProcess(
          [
            "run",
            "--provider",
            providerCase.providerId,
            "--endpoint",
            collector.url,
            "--state-dir",
            stateDir,
          ],
          JSON.stringify(providerCase.payload(`ses-concurrent-${providerCase.providerId}`)),
        ),
      ),
    );

    for (const [index, result] of results.entries()) {
      const providerCase = PROVIDER_CASES[index];
      expect(result.code, providerCase?.providerId).toBe(0);
      expect(result.stdout, providerCase?.providerId).toBe(providerCase?.expectedStdout);
    }

    const exported = collector.text();
    for (const providerCase of PROVIDER_CASES) {
      expect(exported, providerCase.providerId).toContain(
        `ses-concurrent-${providerCase.providerId}`,
      );
      expect(exported, providerCase.providerId).not.toContain(providerCase.secret);
    }
    expect(collector.requests.length).toBeGreaterThanOrEqual(PROVIDER_CASES.length);
  }, 90_000);

  it("suppresses telemetry for a redelivered callback id but still answers the protocol", async () => {
    const collector = await withCollector();
    const stateDir = await withStateDir();
    const providerCase = findProviderCase("cursor");
    const payload = JSON.stringify(providerCase.payload("ses-redelivery"));
    const args = [
      "run",
      "--provider",
      "cursor",
      "--endpoint",
      collector.url,
      "--state-dir",
      stateDir,
      "--callback-id",
      "host-delivery-42",
      "--log-level",
      "info",
    ];

    const first = await runCliProcess(args, payload);
    const second = await runCliProcess(args, payload);

    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    // The host still gets its response both times; only the duplicate telemetry
    // is dropped.
    expect(first.stdout).toBe(providerCase.expectedStdout);
    expect(second.stdout).toBe(providerCase.expectedStdout);
    expect(second.stderr).toContain('"delivery.duplicate":true');
    expect(collector.requests).toHaveLength(1);
  }, 60_000);
});

describe("otel-hook run: configuration and identity are separate", () => {
  it("reads exporter policy from the environment but never identity", async () => {
    const collector = await withCollector();
    const stateDir = await withStateDir();
    const providerCase = findProviderCase("claude-code");

    const result = await runCliProcess(
      ["run", "--provider", "claude-code", "--state-dir", stateDir],
      JSON.stringify(providerCase.payload("ses-env-config")),
      {
        env: {
          OTEL_EXPORTER_OTLP_ENDPOINT: collector.url,
          OTEL_HOOK_SERVICE_NAME: "env-configured-service",
          // Not an identity channel: there is no environment variable that sets a
          // session, and an unknown OTEL_HOOK_* name is simply not read.
          OTEL_HOOK_SESSION_ID: "ses-from-the-environment",
        },
      },
    );

    expect(result.code).toBe(0);
    const exported = collector.text();
    expect(exported).toContain("env-configured-service");
    expect(exported).toContain("ses-env-config");
    expect(exported).not.toContain("ses-from-the-environment");
  }, 60_000);

  it("carries opaque consumer attributes through unchanged", async () => {
    const stateDir = await withStateDir();
    const providerCase = findProviderCase("claude-code");
    const result = await runCliProcess(
      [
        "run",
        "--provider",
        "claude-code",
        "--no-export",
        "--state-dir",
        stateDir,
        "--attr",
        "tenant=acme",
      ],
      JSON.stringify(providerCase.payload("ses-consumer-attrs")),
      { env: { OTEL_HOOK_LOG_LEVEL: "info" } },
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('"attribution.outcome":"attributed"');
  });

  it("accepts identity from a file and conflicts with disagreeing flags", async () => {
    const stateDir = await withStateDir();
    const providerCase = findProviderCase("cursor");
    const { writeFile } = await import("node:fs/promises");
    const identityPath = path.join(stateDir, "identity.json");
    await writeFile(identityPath, JSON.stringify({ sessionId: "ses-from-file" }), "utf8");

    const agreeing = await runCliProcess(
      [
        "run",
        "--provider",
        "cursor",
        "--no-export",
        "--state-dir",
        stateDir,
        "--identity-file",
        identityPath,
      ],
      JSON.stringify(providerCase.payload("ses-from-file")),
      { env: { OTEL_HOOK_LOG_LEVEL: "info" } },
    );
    expect(agreeing.stderr).toContain('"attribution.outcome":"attributed"');

    const conflicting = await runCliProcess(
      [
        "run",
        "--provider",
        "cursor",
        "--no-export",
        "--state-dir",
        stateDir,
        "--identity-file",
        identityPath,
        "--session-id",
        "ses-from-flag",
      ],
      JSON.stringify(providerCase.payload("ses-from-file")),
    );
    expect(conflicting.code).toBe(0);
    expect(conflicting.stderr).toContain("identity-conflict");
  }, 60_000);
});
