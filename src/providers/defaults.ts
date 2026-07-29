import { ANTIGRAVITY_PROVIDER_ID, createAntigravityAdapter } from "./antigravity/adapter.js";
import { ANTIGRAVITY_PROMOTION_GATES, ANTIGRAVITY_PROVIDER_MATURITY } from "./antigravity/maturity.js";
import { createClaudeCodeAdapter } from "./claude/adapter.js";
import { CLAUDE_CODE_PROVIDER_ID } from "./claude/detect.js";
import { createCodexAdapter } from "./codex/adapter.js";
import { CODEX_PROVIDER_ID } from "./codex/version.js";
import { createCursorAdapter } from "./cursor/adapter.js";
import { CURSOR_PROVIDER_ID } from "./cursor/payload.js";
import { createGeminiCliAdapter, GEMINI_PROVIDER_ID } from "./gemini/adapter.js";
import {
  describeAdapter,
  type AdapterDescription,
  type DeliveryIdentifierSupport,
  type ProviderAdapter,
} from "./adapter.js";
import { createProviderRegistry, type ProviderRegistry } from "./registry.js";

/**
 * How much of a provider adapter's behaviour is confirmed against the real
 * provider.
 *
 * `experimental` is not a quality grade — it states that some of the adapter's
 * field and lifecycle mapping is a reconstruction pending confirmation against
 * real captures. Consumers are expected to be able to see this before they
 * depend on the data, so it is part of the descriptor rather than a comment.
 */
export type ProviderMaturity = "stable" | "experimental";

export type ProviderDescriptor = {
  readonly id: string;
  readonly maturity: ProviderMaturity;
  /** Human-readable name of the coding agent this adapter targets. */
  readonly title: string;
  /** Constructs a fresh adapter instance. Adapters are values, never singletons. */
  readonly createAdapter: () => ProviderAdapter;
  /**
   * For an `experimental` adapter: what must be verified before promotion.
   * Empty for a `stable` one.
   */
  readonly promotionGates: readonly string[];
};

/**
 * Every provider adapter this package ships, with its maturity.
 *
 * Ordering is stable and alphabetical by id so `otel-hook providers` output and
 * detection candidate lists are reproducible.
 */
export const PROVIDER_DESCRIPTORS: readonly ProviderDescriptor[] = Object.freeze([
  Object.freeze({
    id: ANTIGRAVITY_PROVIDER_ID,
    maturity: ANTIGRAVITY_PROVIDER_MATURITY,
    title: "Google Antigravity (experimental)",
    createAdapter: (): ProviderAdapter => createAntigravityAdapter(),
    promotionGates: ANTIGRAVITY_PROMOTION_GATES,
  }),
  Object.freeze({
    id: CLAUDE_CODE_PROVIDER_ID,
    maturity: "stable" as const,
    title: "Claude Code",
    createAdapter: (): ProviderAdapter => createClaudeCodeAdapter(),
    promotionGates: Object.freeze([]),
  }),
  Object.freeze({
    id: CODEX_PROVIDER_ID,
    maturity: "stable" as const,
    title: "OpenAI Codex CLI",
    createAdapter: (): ProviderAdapter => createCodexAdapter(),
    promotionGates: Object.freeze([]),
  }),
  Object.freeze({
    id: CURSOR_PROVIDER_ID,
    maturity: "stable" as const,
    title: "Cursor",
    createAdapter: (): ProviderAdapter => createCursorAdapter(),
    promotionGates: Object.freeze([]),
  }),
  Object.freeze({
    id: GEMINI_PROVIDER_ID,
    maturity: "stable" as const,
    title: "Gemini CLI",
    createAdapter: (): ProviderAdapter => createGeminiCliAdapter(),
    promotionGates: Object.freeze([]),
  }),
]);

/** Ids of the adapters whose mapping is still a reconstruction. */
export const EXPERIMENTAL_PROVIDER_IDS: readonly string[] = Object.freeze(
  PROVIDER_DESCRIPTORS.filter((descriptor) => descriptor.maturity === "experimental").map(
    (descriptor) => descriptor.id,
  ),
);

export const findProviderDescriptor = (id: string): ProviderDescriptor | undefined =>
  PROVIDER_DESCRIPTORS.find((descriptor) => descriptor.id === id);

export const isExperimentalProvider = (id: string): boolean =>
  findProviderDescriptor(id)?.maturity === "experimental";

export type DefaultRegistryOptions = {
  /**
   * Include adapters marked `experimental`. Default `true`: an experimental
   * adapter is registered but visibly labelled, so a host that wants only
   * confirmed mappings opts out explicitly rather than discovering the
   * distinction from telemetry that looks the same as the rest.
   */
  readonly includeExperimental?: boolean;
  /** Restrict to these provider ids, in descriptor order. Empty means "all". */
  readonly only?: readonly string[];
  /** Extra adapters — a host's own provider — appended after the built-ins. */
  readonly additional?: readonly ProviderAdapter[];
};

/**
 * Build a registry over this package's provider adapters.
 *
 * A factory rather than a shared constant: a registry is a value the runtime is
 * given, and two hooks in one process may legitimately be configured with
 * different adapter sets (see `createProviderRegistry`'s note and ADR 0001).
 */
export const createDefaultProviderRegistry = (
  options: DefaultRegistryOptions = {},
): ProviderRegistry => {
  const includeExperimental = options.includeExperimental ?? true;
  const only = options.only ?? [];
  const selected = PROVIDER_DESCRIPTORS.filter((descriptor) => {
    if (only.length > 0 && !only.includes(descriptor.id)) {
      return false;
    }
    return includeExperimental || descriptor.maturity !== "experimental";
  });
  return createProviderRegistry([
    ...selected.map((descriptor) => descriptor.createAdapter()),
    ...(options.additional ?? []),
  ]);
};

export type ProviderCatalogEntry = AdapterDescription & {
  readonly maturity: ProviderMaturity;
  readonly title: string;
  readonly promotionGates: readonly string[];
  /** True when the provider's protocol reads a structured response from stdout. */
  readonly requiresHookResponse: boolean;
  /**
   * Which series this provider's `cumulative` counters accumulate over, so a
   * consumer summing deltas knows whether a per-turn snapshot is a per-turn
   * figure or a session-wide one. Absent for `delta` providers.
   */
  readonly cumulativeUsageSeries?: string;
  readonly reportsCachedInput: boolean;
  readonly reportsCacheCreation: boolean;
  readonly cacheCreationAccounting: string;
  readonly reportsReasoningOutput: boolean;
  readonly reportsProviderTotal: boolean;
  readonly reportsCost: boolean;
  readonly emitsSubagentEvents: boolean;
  readonly emitsCompactionEvents: boolean;
};

/** How each adapter's declared delivery-identifier coverage reads to a human. */
export const DELIVERY_IDENTIFIER_SUMMARY: Readonly<Record<DeliveryIdentifierSupport, string>> =
  Object.freeze({
    none: "no callback carries a replay-stable identifier",
    partial: "some callbacks carry a replay-stable identifier",
    all: "every recognized callback carries a replay-stable identifier",
  });

/**
 * Machine-readable capability catalog, for `otel-hook providers --json` and for
 * consumers deciding whether a metric is absent or merely unreported.
 */
export const describeProviderCatalog = (
  options: DefaultRegistryOptions = {},
): readonly ProviderCatalogEntry[] => {
  const includeExperimental = options.includeExperimental ?? true;
  const only = options.only ?? [];
  const entries: ProviderCatalogEntry[] = [];
  for (const descriptor of PROVIDER_DESCRIPTORS) {
    if (only.length > 0 && !only.includes(descriptor.id)) {
      continue;
    }
    if (!includeExperimental && descriptor.maturity === "experimental") {
      continue;
    }
    const adapter = descriptor.createAdapter();
    const { capabilities } = adapter;
    entries.push({
      ...describeAdapter(adapter),
      maturity: descriptor.maturity,
      title: descriptor.title,
      promotionGates: [...descriptor.promotionGates],
      requiresHookResponse: capabilities.requiresHookResponse,
      ...(capabilities.cumulativeUsageSeries === undefined
        ? {}
        : { cumulativeUsageSeries: capabilities.cumulativeUsageSeries }),
      reportsCachedInput: capabilities.reportsCachedInput,
      reportsCacheCreation: capabilities.reportsCacheCreation,
      cacheCreationAccounting: capabilities.cacheCreationAccounting,
      reportsReasoningOutput: capabilities.reportsReasoningOutput,
      reportsProviderTotal: capabilities.reportsProviderTotal,
      reportsCost: capabilities.reportsCost,
      emitsSubagentEvents: capabilities.emitsSubagentEvents,
      emitsCompactionEvents: capabilities.emitsCompactionEvents,
    });
  }
  return entries;
};
