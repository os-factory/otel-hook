import { CLI_USAGE, parseCliArgs } from "./args.js";
import { writeLine, type CliIo } from "./context.js";
import { runDoctorCommand } from "./doctor.js";
import { runProvidersCommand } from "./providers.js";
import { runHookCommand } from "./run.js";
import { VERSION } from "../version.js";

/**
 * Exit codes.
 *
 * `run` is special: it always resolves to {@link EXIT_OK}, because a hook that
 * can fail its host agent is a liability (ADR 0004). The non-hook commands are
 * ordinary CLI programs and report failure normally, so a CI job can gate on
 * `otel-hook doctor`.
 */
export const EXIT_OK = 0;
export const EXIT_UNHEALTHY = 1;
export const EXIT_USAGE = 2;

/**
 * CLI entry point.
 *
 * Takes its argv, environment, and streams as arguments and returns an exit
 * code: nothing here reads `process`, writes to the environment, or holds state
 * between calls, so the whole surface is testable in-process and two invocations
 * in one process cannot see each other's identity.
 */
export const runCli = async (io: CliIo): Promise<number> => {
  const parsed = parseCliArgs(io.argv);

  switch (parsed.status) {
    case "version":
      writeLine(io.stdout, VERSION);
      return EXIT_OK;

    case "help":
      writeLine(io.stdout, CLI_USAGE);
      return EXIT_OK;

    case "error":
      for (const error of parsed.errors) {
        writeLine(io.stderr, `otel-hook: ${error}`);
      }
      writeLine(io.stderr, 'run "otel-hook --help" for usage');
      return EXIT_USAGE;

    case "command":
      break;
  }

  switch (parsed.command.name) {
    case "run":
      return runHookCommand(parsed.command, io);
    case "doctor":
      return runDoctorCommand(parsed.command, io);
    case "providers":
      return Promise.resolve(runProvidersCommand(parsed.command, io));
  }
};
