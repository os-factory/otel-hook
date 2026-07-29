import { describe, expect, it } from "vitest";

import { DEFAULT_MAX_INPUT_BYTES, parseCliArgs } from "../../src/cli/args.js";

const expectRun = (argv: readonly string[]) => {
  const parsed = parseCliArgs(argv);
  if (parsed.status !== "command" || parsed.command.name !== "run") {
    throw new Error(`expected a run command, got ${JSON.stringify(parsed)}`);
  }
  return parsed.command;
};

const expectErrors = (argv: readonly string[]): readonly string[] => {
  const parsed = parseCliArgs(argv);
  if (parsed.status !== "error") {
    throw new Error(`expected errors, got ${JSON.stringify(parsed)}`);
  }
  return parsed.errors;
};

describe("CLI argument parsing", () => {
  it("defaults to help with no arguments", () => {
    expect(parseCliArgs([])).toEqual({ status: "help" });
  });

  it("reports the version only when it is the sole argument", () => {
    expect(parseCliArgs(["--version"])).toEqual({ status: "version" });
    expect(expectErrors(["--version", "run"])).toEqual(["--version takes no other arguments"]);
  });

  it("rejects an unknown command and an unknown flag", () => {
    expect(expectErrors(["deploy"])[0]).toContain('unknown command "deploy"');
    expect(expectErrors(["run", "--turbo"])).toEqual(["unknown flag --turbo"]);
  });

  it("accepts both --flag value and --flag=value", () => {
    expect(expectRun(["run", "--provider", "cursor"]).providerId).toBe("cursor");
    expect(expectRun(["run", "--provider=cursor"]).providerId).toBe("cursor");
  });

  it("accepts legacy --cursor as shorthand for --provider cursor", () => {
    expect(expectRun(["run", "--cursor"]).providerId).toBe("cursor");
  });

  it("accepts legacy --claude and --codex provider shorthands", () => {
    expect(expectRun(["run", "--claude"]).providerId).toBe("claude-code");
    expect(expectRun(["run", "--codex"]).providerId).toBe("codex");
  });

  it("applies the default stdin bound and validates an explicit one", () => {
    expect(expectRun(["run"]).maxInputBytes).toBe(DEFAULT_MAX_INPUT_BYTES);
    expect(expectRun(["run", "--max-input-bytes", "4096"]).maxInputBytes).toBe(4096);
    expect(expectErrors(["run", "--max-input-bytes", "zero"])[0]).toContain("expects an integer");
    expect(expectErrors(["run", "--max-input-bytes", "0"])[0]).toContain("expects an integer");
  });

  it("keeps identity separate from policy, with no shared field", () => {
    const command = expectRun([
      "run",
      "--session-id",
      "ses-1",
      "--invocation-id",
      "inv-1",
      "--endpoint",
      "http://localhost:4318/v1/traces",
      "--service-name",
      "agent",
    ]);
    expect(command.identity).toEqual({ sessionId: "ses-1", invocationId: "inv-1" });
    expect(Object.keys(command.policy)).not.toContain("sessionId");
    expect(command.policy.endpoint).toBe("http://localhost:4318/v1/traces");
    // Identity and policy share no key at all, so neither can set the other.
    expect(
      Object.keys(command.identity).filter((key) => key in command.policy),
    ).toEqual([]);
  });

  it("collects repeatable key=value flags and rejects malformed pairs", () => {
    const command = expectRun([
      "run",
      "--header",
      "authorization=Bearer x",
      "--header",
      "x-tenant=acme",
      "--attr",
      "team=platform",
    ]);
    expect(command.policy.headers).toEqual({ authorization: "Bearer x", "x-tenant": "acme" });
    expect(command.consumerAttributes).toEqual({ team: "platform" });
    expect(expectErrors(["run", "--header", "nope"])[0]).toContain("expects key=value");
  });

  it("rejects a repeated single-value flag rather than silently keeping one", () => {
    expect(expectErrors(["run", "--provider", "cursor", "--provider", "codex"])[0]).toContain(
      "accepts one value",
    );
  });

  it("requires --callback-id whenever --callback-scope is given", () => {
    expect(expectErrors(["run", "--callback-scope", "s"])).toEqual([
      "flag --callback-scope requires --callback-id",
    ]);
  });

  it("parses the delivery-deduplication policy flags", () => {
    const defaults = expectRun(["run"]);
    expect(defaults.requireCallbackId).toBeUndefined();
    expect(defaults.noDeriveCallbackId).toBeUndefined();

    const strict = expectRun(["run", "--require-callback-id", "--no-derive-callback-id"]);
    expect(strict.requireCallbackId).toBe(true);
    expect(strict.noDeriveCallbackId).toBe(true);

    // Both are boolean: a value is a mistake, not a scope.
    expect(expectErrors(["run", "--require-callback-id=yes"])[0]).toContain("does not take a value");
  });

  it("keeps the delivery flags off the non-hook commands", () => {
    expect(expectErrors(["providers", "--require-callback-id"])[0]).toContain(
      'flag --require-callback-id is not accepted by "providers"',
    );
    expect(expectErrors(["doctor", "--no-derive-callback-id"])[0]).toContain(
      'flag --no-derive-callback-id is not accepted by "doctor"',
    );
  });

  it("validates enumerated flags", () => {
    expect(expectErrors(["run", "--protocol", "grpc"])[0]).toContain("expects http/protobuf");
    expect(expectErrors(["run", "--transport", "carrier-pigeon"])[0]).toContain(
      "expects hook-stdin",
    );
  });

  it("rejects flags a command does not accept", () => {
    expect(expectErrors(["providers", "--endpoint", "http://x"])[0]).toContain(
      'flag --endpoint is not accepted by "providers"',
    );
    expect(expectErrors(["doctor", "--session-id", "s"])[0]).toContain(
      'flag --session-id is not accepted by "doctor"',
    );
  });

  it("rejects a value on a boolean flag and a positional argument", () => {
    expect(expectErrors(["run", "--no-export=true"])).toEqual([
      "flag --no-export does not take a value",
    ]);
    expect(expectErrors(["run", "payload.json"])[0]).toContain("unexpected positional argument");
  });

  it("parses the logs signal flags, defaulting to silence about them", () => {
    // Absent flags leave every logs field unset, so the configuration layer below
    // keeps its own default rather than being overridden with one.
    const quiet = expectRun(["run", "--provider", "claude-code"]).policy;
    expect(quiet.logsEnabled).toBeUndefined();
    expect(quiet.logsEndpoint).toBeUndefined();
    expect(quiet.logsIncludeContent).toBeUndefined();

    const enabled = expectRun([
      "run",
      "--provider",
      "claude-code",
      "--logs",
      "--logs-endpoint",
      "http://127.0.0.1:4318/v1/logs",
      "--logs-content",
    ]).policy;
    expect(enabled.logsEnabled).toBe(true);
    expect(enabled.logsEndpoint).toBe("http://127.0.0.1:4318/v1/logs");
    expect(enabled.logsIncludeContent).toBe(true);

    expect(expectRun(["run", "--provider", "claude-code", "--no-logs"]).policy.logsEnabled).toBe(false);
  });

  it("treats contradictory logs flags as an error", () => {
    expect(expectErrors(["run", "--provider", "claude-code", "--logs", "--no-logs"])).toContain(
      "flags --logs and --no-logs cannot both be given",
    );
  });

  it("keeps the logs flags on the commands that can act on them", () => {
    // `run` exports and `doctor` reports, so both need them; a registration command
    // writes a hook document and has no exporter to configure.
    expect(parseCliArgs(["doctor", "--logs", "--json"]).status).toBe("command");
    expect(expectErrors(["setup", "--provider", "claude-code", "--logs"])).toEqual([
      'flag --logs is not accepted by "setup"',
    ]);
  });

  it("treats contradictory experimental flags as an error", () => {
    expect(expectErrors(["run", "--include-experimental", "--no-experimental"])[0]).toContain(
      "cannot both be given",
    );
  });

  it("parses doctor and providers", () => {
    expect(parseCliArgs(["doctor", "--json"])).toMatchObject({
      status: "command",
      command: { name: "doctor", json: true },
    });
    expect(parseCliArgs(["providers", "--no-experimental"])).toMatchObject({
      status: "command",
      command: { name: "providers", json: false, includeExperimental: false },
    });
  });

  it("routes --help on a subcommand to that topic", () => {
    expect(parseCliArgs(["run", "--help"])).toEqual({ status: "help", topic: "run" });
  });
});
