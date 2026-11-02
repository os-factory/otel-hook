/**
 * Versioned provider capability manifest.
 *
 * Adapter declarations are the only source. Maturity and promotion gates come
 * from the provider descriptors, events and usage and stdout come from
 * `ProviderCapabilities`, registration comes from the install support tables,
 * and log signals are derived from `lifecycleEvents` — never a second list an
 * adapter could let go stale.
 *
 * `otel-hook providers` (text and `--json`), the README matrix, and
 * `docs/provider-capability-manifest.json` are renderings of this object. A
 * test fails when a rendering and the declarations disagree.
 *
 * `manifestVersion` bumps when an existing field changes meaning. Adding a
 * provider, or an optional field a consumer can ignore, does not.
 */

import {
  findInstallLocation,
  findRegistrationSupport,
  PROVIDERS_WITHOUT_VERIFIED_LOCATION,
  REGISTRATION_SCOPES,
} from "../install/index.js";
import { CANONICAL_EVENT_TYPES, type CanonicalEventType } from "../model/events.js";
import {
  DELIVERY_IDENTIFIER_SUMMARY,
  describeProviderCatalog,
  type ProviderCatalogEntry,
} from "../providers/defaults.js";
import { logSignalsForLifecycleEvents, type LogSignal } from "../telemetry/log-records.js";

export const CAPABILITY_MANIFEST_VERSION = 1;

/**
 * Protocols this package can actually put on the wire.
 *
 * Traces and logs are OTLP HTTP/protobuf. `http/json` is accepted by
 * configuration and then disabled, and there is no metrics pipeline. Per
 * provider, which log signals can appear is `logSignals` on each entry.
 */
export const CAPABILITY_EXPORT_SIGNALS = Object.freeze({
  traces: "otlp-http-protobuf",
  logs: "otlp-http-protobuf",
  metrics: "unsupported",
} as const);

export type CapabilityExportSignals = typeof CAPABILITY_EXPORT_SIGNALS;

export type RegistrationLocation = "global-and-project" | "settings-file" | "unsupported";

export type StdoutProtocol = "silent" | "provider-json";

export type CapabilityManifestProvider = ProviderCatalogEntry & {
  /** Descriptor title without a trailing maturity annotation. */
  readonly agent: string;
  readonly stdoutProtocol: StdoutProtocol;
  readonly registrationSupported: boolean;
  readonly registrationNote: string;
  readonly registrationHelper?: string;
  readonly registrationLocation: RegistrationLocation;
  /** Log signals this provider can populate, derived from `lifecycleEvents`. */
  readonly logSignals: readonly LogSignal[];
};

export type CapabilityManifest = {
  readonly manifestVersion: typeof CAPABILITY_MANIFEST_VERSION;
  readonly exportSignals: CapabilityExportSignals;
  readonly providers: readonly CapabilityManifestProvider[];
};

export type CapabilityManifestOptions = {
  readonly includeExperimental?: boolean;
};

const agentName = (title: string): string => title.replace(/ \(experimental\)$/, "");

export const stdoutProtocolOf = (requiresHookResponse: boolean): StdoutProtocol =>
  requiresHookResponse ? "provider-json" : "silent";

/** Human label shared by the CLI text listing and the README matrix. */
export const stdoutProtocolLabel = (protocol: StdoutProtocol): string =>
  protocol === "provider-json" ? "provider JSON" : "silent";

const registrationLocationOf = (providerId: string, supported: boolean): RegistrationLocation => {
  if (!supported) {
    return "unsupported";
  }
  const verifiedScopes = REGISTRATION_SCOPES.filter(
    (scope) => findInstallLocation(providerId, scope) !== undefined,
  );
  if (
    Object.prototype.hasOwnProperty.call(PROVIDERS_WITHOUT_VERIFIED_LOCATION, providerId) ||
    verifiedScopes.length < REGISTRATION_SCOPES.length
  ) {
    return "settings-file";
  }
  return "global-and-project";
};

export const registrationSummary = (location: RegistrationLocation): string => {
  switch (location) {
    case "global-and-project":
      return "`setup` (global and project)";
    case "settings-file":
      return "`setup --settings-file`";
    case "unsupported":
      return "unsupported";
  }
};

const providerFromCatalog = (entry: ProviderCatalogEntry): CapabilityManifestProvider => {
  const support = findRegistrationSupport(entry.id);
  const registrationSupported = support?.supported ?? false;
  const stdoutProtocol = stdoutProtocolOf(entry.requiresHookResponse);
  return {
    id: entry.id,
    title: entry.title,
    agent: agentName(entry.title),
    version: entry.version,
    maturity: entry.maturity,
    promotionGates: [...entry.promotionGates],
    lifecycleEvents: [...entry.lifecycleEvents],
    usageTemporality: entry.usageTemporality,
    ...(entry.cumulativeUsageSeries === undefined
      ? {}
      : { cumulativeUsageSeries: entry.cumulativeUsageSeries }),
    reportsCachedInput: entry.reportsCachedInput,
    reportsCacheCreation: entry.reportsCacheCreation,
    cacheCreationAccounting: entry.cacheCreationAccounting,
    reportsReasoningOutput: entry.reportsReasoningOutput,
    reportsProviderTotal: entry.reportsProviderTotal,
    reportsCost: entry.reportsCost,
    emitsSubagentEvents: entry.emitsSubagentEvents,
    emitsCompactionEvents: entry.emitsCompactionEvents,
    requiresHookResponse: entry.requiresHookResponse,
    stdoutProtocol,
    deliveryIdentifier: entry.deliveryIdentifier,
    registrationSupported,
    registrationNote: support?.reason ?? "no registration planner is available",
    ...(support?.helper === undefined ? {} : { registrationHelper: support.helper }),
    registrationLocation: registrationLocationOf(entry.id, registrationSupported),
    logSignals: logSignalsForLifecycleEvents(entry.lifecycleEvents as readonly CanonicalEventType[]),
  };
};

export const buildCapabilityManifest = (
  options: CapabilityManifestOptions = {},
): CapabilityManifest => ({
  manifestVersion: CAPABILITY_MANIFEST_VERSION,
  exportSignals: CAPABILITY_EXPORT_SIGNALS,
  providers: describeProviderCatalog({
    includeExperimental: options.includeExperimental ?? true,
  }).map(providerFromCatalog),
});

export const serializeCapabilityManifest = (manifest: CapabilityManifest): string =>
  `${JSON.stringify(manifest, null, 2)}\n`;

const usageCell = (provider: CapabilityManifestProvider): string =>
  provider.cumulativeUsageSeries === "session-lifetime"
    ? `${provider.usageTemporality}[^1]`
    : provider.usageTemporality;

const padRow = (cells: readonly string[], widths: readonly number[]): string =>
  `| ${cells.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join(" | ")} |`;

const markdownTable = (headers: readonly string[], rows: readonly (readonly string[])[]): string => {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const separator = `| ${widths.map((width) => "-".repeat(Math.max(width, 3))).join(" | ")} |`;
  return [padRow(headers, widths), separator, ...rows.map((row) => padRow(row, widths))].join("\n");
};

const sessionLifetimeFootnote = (providers: readonly CapabilityManifestProvider[]): string => {
  const names = providers.map((provider) => provider.agent);
  const subject = names.length === 1 ? names[0] : names.join(" and ");
  return [
    `[^1]: ${subject ?? "This provider"} reports usage as cumulative over the **whole session**, not per turn:`,
    "    every usage-bearing hook stamps the running total.",
    "    Deltas are therefore diffed against the session's previous snapshot rather",
    "    than per turn, which is what keeps a multi-turn session from billing its",
    "    first turn repeatedly. `otel-hook providers` prints this as",
    "    `usage temporality  cumulative (series: session-lifetime)`; see",
    "    [docs/usage-semantics.md](docs/usage-semantics.md#which-series-a-cumulative-report-continues).",
  ].join("\n");
};

/** README provider matrix, including the session-lifetime footnote when one applies. */
export const renderCapabilityMatrixMarkdown = (manifest: CapabilityManifest): string => {
  const headers = [
    "Provider id",
    "Agent",
    "Maturity",
    "stdout protocol",
    "Usage temporality",
    "Registration",
  ];
  const rows = manifest.providers.map((provider) => [
    `\`${provider.id}\``,
    provider.agent,
    provider.maturity,
    stdoutProtocolLabel(provider.stdoutProtocol),
    usageCell(provider),
    registrationSummary(provider.registrationLocation),
  ]);
  const table = markdownTable(headers, rows);
  const sessionLifetime = manifest.providers.filter(
    (provider) => provider.cumulativeUsageSeries === "session-lifetime",
  );
  if (sessionLifetime.length === 0) {
    return table;
  }
  return `${table}\n\n${sessionLifetimeFootnote(sessionLifetime)}`;
};

export const capabilityManifestLines = (manifest: CapabilityManifest): readonly string[] => {
  const lines: string[] = [
    `manifest version   ${String(manifest.manifestVersion)}`,
    `export signals     traces=${manifest.exportSignals.traces} logs=${manifest.exportSignals.logs} metrics=${manifest.exportSignals.metrics}`,
    "",
  ];
  for (const entry of manifest.providers) {
    lines.push(`${entry.id}  ${entry.title}`);
    lines.push(`  adapter version    ${entry.version}`);
    lines.push(`  maturity           ${entry.maturity}`);
    lines.push(`  lifecycle events   ${entry.lifecycleEvents.join(", ")}`);
    lines.push(
      `  usage temporality  ${entry.usageTemporality}${
        entry.cumulativeUsageSeries === undefined ? "" : ` (series: ${entry.cumulativeUsageSeries})`
      }`,
    );
    lines.push(
      `  usage reported     cached-input=${String(entry.reportsCachedInput)} ` +
        `cache-creation=${String(entry.reportsCacheCreation)} (${entry.cacheCreationAccounting}) ` +
        `reasoning=${String(entry.reportsReasoningOutput)} provider-total=${String(entry.reportsProviderTotal)} ` +
        `cost=${String(entry.reportsCost)}`,
    );
    lines.push(
      `  emits              subagent=${String(entry.emitsSubagentEvents)} compaction=${String(
        entry.emitsCompactionEvents,
      )}`,
    );
    lines.push(`  stdout protocol    ${stdoutProtocolLabel(entry.stdoutProtocol)}`);
    lines.push(
      `  log signals        ${entry.logSignals.length === 0 ? "(none)" : entry.logSignals.join(", ")}`,
    );
    lines.push(
      `  delivery dedup     ${entry.deliveryIdentifier} — ${DELIVERY_IDENTIFIER_SUMMARY[entry.deliveryIdentifier]}`,
    );
    lines.push(
      `  registration       ${entry.registrationSupported ? "supported" : "unsupported"} — ${entry.registrationNote}`,
    );
    lines.push(`  install location   ${entry.registrationLocation}`);
    if (entry.promotionGates.length > 0) {
      lines.push(`  promotion gates    ${String(entry.promotionGates.length)} open:`);
      for (const gate of entry.promotionGates) {
        lines.push(`    - ${gate}`);
      }
    }
    lines.push("");
  }
  return lines;
};

/** Text listing, including the trailing blank line after the last provider. */
export const renderCapabilityManifestText = (manifest: CapabilityManifest): string =>
  `${capabilityManifestLines(manifest).join("\n")}\n`;

/**
 * Rows of the log-signal capability table.
 *
 * The signal *values* are not stored here: `renderSignalCapabilityTable` asks
 * `logSignalsForLifecycleEvents`. These rows only group canonical events the
 * way the compatibility document does, and rendering throws if a canonical
 * event type is missing or repeated — a new event cannot ship without a row.
 */
export const SIGNAL_CAPABILITY_ROWS: readonly {
  readonly label: string;
  readonly events: readonly CanonicalEventType[];
}[] = Object.freeze([
  Object.freeze({
    label: "`session.start` / `session.end`",
    events: Object.freeze(["session.start", "session.end"] as const),
  }),
  Object.freeze({
    label: "`prompt.submitted`",
    events: Object.freeze(["prompt.submitted"] as const),
  }),
  Object.freeze({
    label: "`generation.start`",
    events: Object.freeze(["generation.start"] as const),
  }),
  Object.freeze({
    label: "`generation.end`",
    events: Object.freeze(["generation.end"] as const),
  }),
  Object.freeze({
    label: "`tool.start` / `tool.end`",
    events: Object.freeze(["tool.start", "tool.end"] as const),
  }),
  Object.freeze({
    label: "`subagent.start` / `subagent.end`",
    events: Object.freeze(["subagent.start", "subagent.end"] as const),
  }),
  Object.freeze({
    label: "`compaction.performed`",
    events: Object.freeze(["compaction.performed"] as const),
  }),
  Object.freeze({
    label: "`error.raised`",
    events: Object.freeze(["error.raised"] as const),
  }),
]);

const assertSignalRowsCoverCanonicalEvents = (): void => {
  const seen = new Map<string, number>();
  for (const row of SIGNAL_CAPABILITY_ROWS) {
    for (const event of row.events) {
      seen.set(event, (seen.get(event) ?? 0) + 1);
    }
  }
  const missing = CANONICAL_EVENT_TYPES.filter((type) => !seen.has(type));
  const duplicated = [...seen.entries()].filter(([, count]) => count !== 1).map(([type]) => type);
  if (missing.length > 0 || duplicated.length > 0) {
    throw new Error(
      `log signal table rows must name each canonical event once; missing=${
        missing.join(",") || "none"
      } duplicated=${duplicated.join(",") || "none"}`,
    );
  }
};

/** Compatibility table: which log signals a declared lifecycle event can produce. */
export const renderSignalCapabilityTable = (): string => {
  assertSignalRowsCoverCanonicalEvents();
  const lines = [
    "| Declared lifecycle events | Signals declared |",
    "| --- | --- |",
    ...SIGNAL_CAPABILITY_ROWS.map((row) => {
      const signals = logSignalsForLifecycleEvents(row.events);
      const declared = signals.map((signal) => `\`${signal}\``).join(", ");
      return `| ${row.label} | ${declared} |`;
    }),
  ];
  return lines.join("\n");
};
