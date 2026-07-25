import { describeProviderCatalog, type ProviderCatalogEntry } from "../providers/defaults.js";
import { findRegistrationSupport } from "../install/index.js";
import type { CliProvidersCommand } from "./args.js";
import { writeLine, type CliIo } from "./context.js";

export type ProviderListing = ProviderCatalogEntry & {
  /** Whether this repository can plan a hook registration for the provider. */
  readonly registrationSupported: boolean;
  readonly registrationNote: string;
};

export const collectProviderListing = (
  command: CliProvidersCommand,
): readonly ProviderListing[] =>
  describeProviderCatalog({ includeExperimental: command.includeExperimental }).map((entry) => {
    const support = findRegistrationSupport(entry.id);
    return {
      ...entry,
      registrationSupported: support?.supported ?? false,
      registrationNote: support?.reason ?? "no registration planner is available",
    };
  });

/**
 * List adapters and what each one can actually observe.
 *
 * Capabilities are printed rather than inferred from the data because "this
 * provider does not report cached tokens" and "this session used no cache" look
 * identical downstream. A consumer needs to be able to tell them apart before
 * building a dashboard on the difference.
 */
export const runProvidersCommand = (command: CliProvidersCommand, io: CliIo): number => {
  const listing = collectProviderListing(command);

  if (command.json) {
    writeLine(io.stdout, JSON.stringify(listing, null, 2));
    return 0;
  }

  for (const entry of listing) {
    writeLine(io.stdout, `${entry.id}  ${entry.title}`);
    writeLine(io.stdout, `  adapter version    ${entry.version}`);
    writeLine(io.stdout, `  maturity           ${entry.maturity}`);
    writeLine(io.stdout, `  lifecycle events   ${entry.lifecycleEvents.join(", ")}`);
    writeLine(io.stdout, `  usage temporality  ${entry.usageTemporality}`);
    writeLine(
      io.stdout,
      `  usage reported     cached-input=${String(entry.reportsCachedInput)} ` +
        `cache-creation=${String(entry.reportsCacheCreation)} (${entry.cacheCreationAccounting}) ` +
        `reasoning=${String(entry.reportsReasoningOutput)} provider-total=${String(entry.reportsProviderTotal)} ` +
        `cost=${String(entry.reportsCost)}`,
    );
    writeLine(
      io.stdout,
      `  emits              subagent=${String(entry.emitsSubagentEvents)} compaction=${String(
        entry.emitsCompactionEvents,
      )}`,
    );
    writeLine(io.stdout, `  stdout protocol    ${entry.requiresHookResponse ? "required" : "silent"}`);
    writeLine(
      io.stdout,
      `  registration       ${entry.registrationSupported ? "supported" : "unsupported"} — ${entry.registrationNote}`,
    );
    if (entry.promotionGates.length > 0) {
      writeLine(io.stdout, `  promotion gates    ${String(entry.promotionGates.length)} open:`);
      for (const gate of entry.promotionGates) {
        writeLine(io.stdout, `    - ${gate}`);
      }
    }
    writeLine(io.stdout, "");
  }
  return 0;
};
