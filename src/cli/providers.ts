import type { CliProvidersCommand } from "./args.js";
import {
  buildCapabilityManifest,
  capabilityManifestLines,
  type CapabilityManifestProvider,
} from "./capability-manifest.js";
import { writeLine, type CliIo } from "./context.js";

export type ProviderListing = CapabilityManifestProvider;

export const collectProviderListing = (
  command: CliProvidersCommand,
): readonly ProviderListing[] =>
  buildCapabilityManifest({ includeExperimental: command.includeExperimental }).providers;

/**
 * List adapters and what each one can actually observe.
 *
 * Text and `--json` are two renderings of {@link buildCapabilityManifest}.
 * Capabilities are printed rather than inferred from the data because "this
 * provider does not report cached tokens" and "this session used no cache" look
 * identical downstream.
 */
export const runProvidersCommand = (command: CliProvidersCommand, io: CliIo): number => {
  const manifest = buildCapabilityManifest({
    includeExperimental: command.includeExperimental,
  });

  if (command.json) {
    writeLine(io.stdout, JSON.stringify(manifest, null, 2));
    return 0;
  }

  for (const line of capabilityManifestLines(manifest)) {
    writeLine(io.stdout, line);
  }
  return 0;
};
