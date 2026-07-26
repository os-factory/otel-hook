import { describe, expect, it } from "vitest";

import { CLI_USAGE, parseCliArgs, type CliRegistrationCommand } from "../../src/cli/args.js";

const expectCommand = (argv: readonly string[]): CliRegistrationCommand => {
  const parsed = parseCliArgs(argv);
  if (parsed.status !== "command") {
    throw new Error(`expected a command, got ${parsed.status}: ${JSON.stringify(parsed)}`);
  }
  return parsed.command as CliRegistrationCommand;
};

const expectErrors = (argv: readonly string[]): readonly string[] => {
  const parsed = parseCliArgs(argv);
  if (parsed.status !== "error") {
    throw new Error(`expected an error, got ${parsed.status}`);
  }
  return parsed.errors;
};

describe("setup / diagnose / uninstall argument parsing", () => {
  it("defaults the mutating commands to project scope", () => {
    // Writing into a developer's home directory is the surprising choice, so it
    // has to be asked for.
    expect(expectCommand(["setup", "--provider", "claude-code"]).scopes).toEqual(["project"]);
    expect(expectCommand(["uninstall", "--provider", "codex"]).scopes).toEqual(["project"]);
  });

  it("defaults diagnose to every scope and every provider", () => {
    const command = expectCommand(["diagnose"]);
    expect(command.scopes).toEqual(["global", "project"]);
    expect(command.providerIds).toEqual([]);
    expect(command.dryRun).toBe(false);
  });

  it("requires an explicit provider for the commands that write", () => {
    expect(expectErrors(["setup"])[0]).toContain("requires --provider");
    expect(expectErrors(["uninstall"])[0]).toContain("requires --provider");
  });

  it("accepts several providers and every documented option", () => {
    const command = expectCommand([
      "setup",
      "--provider",
      "claude-code",
      "--provider",
      "codex",
      "--scope",
      "all",
      "--project-dir",
      "/tmp/project",
      "--home-dir",
      "/tmp/home",
      "--hook-command",
      "/opt/bin/otel-hook run",
      "--event",
      "PreToolUse",
      "--event",
      "Stop",
      "--matcher",
      "Bash",
      "--timeout-seconds",
      "30",
      "--managed-marker",
      "my-hook",
      "--dry-run",
      "--json",
    ]);

    expect(command).toMatchObject({
      name: "setup",
      providerIds: ["claude-code", "codex"],
      scopes: ["global", "project"],
      projectDir: "/tmp/project",
      homeDir: "/tmp/home",
      hookCommand: "/opt/bin/otel-hook run",
      events: ["PreToolUse", "Stop"],
      matcher: "Bash",
      timeoutSeconds: 30,
      managedMarker: "my-hook",
      dryRun: true,
      json: true,
    });
  });

  it("rejects a scope it does not recognize", () => {
    expect(expectErrors(["setup", "--provider", "codex", "--scope", "user"])[0]).toContain(
      "expects global, project, or all",
    );
  });

  it("rejects --settings-file combined with --scope all, which names two documents", () => {
    expect(
      expectErrors(["setup", "--provider", "codex", "--settings-file", "/tmp/h.json", "--scope", "all"])[0],
    ).toContain("--settings-file names one document");
  });

  it("rejects flags that would imply diagnose writes or filters", () => {
    expect(expectErrors(["diagnose", "--dry-run"])[0]).toContain("never writes");
    expect(expectErrors(["diagnose", "--event", "Stop"])[0]).toContain("--event is not accepted");
  });

  it("does not let a registration flag leak into run, doctor, or providers", () => {
    for (const command of ["run", "doctor", "providers"]) {
      expect(expectErrors([command, "--scope", "global"])[0], command).toContain(
        `flag --scope is not accepted by "${command}"`,
      );
    }
  });

  it("does not let a run flag leak into setup", () => {
    expect(expectErrors(["setup", "--provider", "codex", "--endpoint", "https://c"])[0]).toContain(
      'flag --endpoint is not accepted by "setup"',
    );
  });

  it("bounds --timeout-seconds", () => {
    expect(expectErrors(["setup", "--provider", "codex", "--timeout-seconds", "0"])[0]).toContain(
      "expects an integer",
    );
  });

  it("documents all three commands in the usage text", () => {
    for (const fragment of ["otel-hook setup", "otel-hook diagnose", "otel-hook uninstall", "--dry-run"]) {
      expect(CLI_USAGE, fragment).toContain(fragment);
    }
  });

  it("routes --help on a registration subcommand to that topic", () => {
    expect(parseCliArgs(["setup", "--help"])).toEqual({ status: "help", topic: "setup" });
  });
});
