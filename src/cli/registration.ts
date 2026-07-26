import * as os from "node:os";
import * as path from "node:path";

import {
  PROVIDERS_WITH_VERIFIED_LOCATION,
  runRegistrationLifecycle,
  type RegistrationOutcome,
  type RegistrationReport,
} from "../install/index.js";
import { createSystemClock } from "../runtime/clock.js";
import type { CliRegistrationCommand } from "./args.js";
import { writeLine, type CliIo } from "./context.js";
import { VERSION } from "../version.js";

/**
 * `setup`, `diagnose`, and `uninstall`.
 *
 * The command layer only resolves *where* to look — provider ids, scopes, the
 * project root, the home directory — and formats the result. Every decision
 * about what a document should contain lives in `install/lifecycle.ts` and the
 * pure planners beneath it, so the human-readable and `--json` outputs describe
 * exactly the same plan and a dry run cannot diverge from a real one.
 *
 * Unlike `run`, these commands are ordinary programs: they exit non-zero when
 * something needs an operator's attention, so CI can gate on
 * `otel-hook diagnose --json`. Nothing here can affect a hook invocation.
 */

const resolveProjectDir = (command: CliRegistrationCommand, io: CliIo): string =>
  path.resolve(command.projectDir ?? io.env.PWD ?? process.cwd());

const resolveHomeDir = (command: CliRegistrationCommand, io: CliIo): string =>
  path.resolve(command.homeDir ?? io.homeDir ?? os.homedir());

export const collectRegistrationReport = async (
  command: CliRegistrationCommand,
  io: CliIo,
): Promise<RegistrationReport> =>
  runRegistrationLifecycle({
    action: command.name,
    // A bare `diagnose` sweeps the providers this tool can locate by itself.
    // One whose path has to be supplied by hand (see
    // PROVIDERS_WITHOUT_VERIFIED_LOCATION) has nowhere to be swept, so naming
    // it would only ever produce a self-inflicted failure.
    providerIds:
      command.providerIds.length > 0 ? command.providerIds : PROVIDERS_WITH_VERIFIED_LOCATION,
    scopes: command.scopes,
    roots: { homeDir: resolveHomeDir(command, io), projectDir: resolveProjectDir(command, io) },
    ...(command.settingsFile === undefined ? {} : { configFile: command.settingsFile }),
    ...(command.hookCommand === undefined ? {} : { command: command.hookCommand }),
    ...(command.events === undefined ? {} : { events: command.events }),
    ...(command.matcher === undefined ? {} : { matcher: command.matcher }),
    ...(command.timeoutSeconds === undefined ? {} : { timeoutSeconds: command.timeoutSeconds }),
    ...(command.managedMarker === undefined ? {} : { managedMarker: command.managedMarker }),
    dryRun: command.dryRun,
    clock: createSystemClock(),
  });

const STATUS_LABEL: Readonly<Record<RegistrationOutcome["status"], string>> = Object.freeze({
  planned: "would change",
  applied: "changed     ",
  unchanged: "up to date  ",
  absent: "not present ",
  blocked: "REFUSED     ",
  unsupported: "UNSUPPORTED ",
  failed: "FAILED      ",
});

const writeOutcome = (io: CliIo, outcome: RegistrationOutcome, dryRun: boolean): void => {
  writeLine(
    io.stdout,
    `${STATUS_LABEL[outcome.status]} ${outcome.providerId} (${outcome.scope})` +
      (outcome.configPath === undefined ? "" : `  ${outcome.configPath}`),
  );

  const added = outcome.changes.filter((change) => change.action === "added").map((c) => c.event);
  const updated = outcome.changes.filter((change) => change.action === "updated").map((c) => c.event);
  const removed = outcome.changes.filter((change) => change.action === "removed").map((c) => c.event);
  if (added.length > 0) {
    writeLine(io.stdout, `  add     ${added.join(", ")}`);
  }
  if (updated.length > 0) {
    writeLine(io.stdout, `  update  ${updated.join(", ")}`);
  }
  if (removed.length > 0) {
    writeLine(io.stdout, `  remove  ${removed.join(", ")}`);
  }
  if (outcome.registeredEvents.length > 0 && outcome.changes.length === 0) {
    writeLine(io.stdout, `  events  ${outcome.registeredEvents.join(", ")}`);
  }
  for (const note of outcome.notes) {
    writeLine(io.stdout, `  note    ${note}`);
  }
  for (const problem of outcome.problems) {
    writeLine(io.stdout, `  problem ${problem}`);
  }
  if (dryRun && outcome.plannedContents !== undefined) {
    writeLine(io.stdout, "  --- would write ---");
    for (const line of outcome.plannedContents.replace(/\r?\n$/, "").split(/\r?\n/)) {
      writeLine(io.stdout, `  ${line}`);
    }
    writeLine(io.stdout, "  --- end ---");
  }
};

export const runRegistrationCommand = async (
  command: CliRegistrationCommand,
  io: CliIo,
): Promise<number> => {
  const report = await collectRegistrationReport(command, io);

  if (command.json) {
    writeLine(io.stdout, JSON.stringify({ version: VERSION, ...report }, null, 2));
    return report.ok ? 0 : 1;
  }

  writeLine(
    io.stdout,
    `otel-hook ${VERSION} — ${report.action}${report.dryRun ? " (dry run; nothing was written)" : ""}`,
  );
  writeLine(io.stdout, "");
  for (const outcome of report.outcomes) {
    writeOutcome(io, outcome, report.dryRun);
    writeLine(io.stdout, "");
  }
  return report.ok ? 0 : 1;
};
