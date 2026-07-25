/**
 * Named, reviewable catalog of known `opentelemetry-hooks==0.14.0` semantic
 * bugs/quirks that this repository's differential tests deliberately assert
 * *do not* match our own canonical behavior.
 *
 * Every entry here must be:
 *   1. Empirically reproduced (not inferred) against the pinned Python
 *      package — see the `citation` field for the source-reading basis.
 *   2. Exercised by at least one fixture under fixtures/parity/**.
 *   3. Asserted by name in a `tests/parity/*.parity.test.ts` file, so a
 *      change to either side's behavior shows up as a named, reviewable diff
 *      instead of a silent test update.
 *
 * This is not a list of things we intend to fix upstream, and not a list of
 * "differences we haven't looked at yet" — it is the opposite: the explicit,
 * reviewed set of divergences a maintainer has already decided are
 * acceptable (or required, in the privacy case) so CI can fail loudly if a
 * *new*, unreviewed divergence appears instead.
 */

export type DivergenceDimension = "usage" | "lifecycle" | "privacy" | "aggregation";

export type DivergenceEntry = {
  readonly id: string;
  readonly title: string;
  readonly dimension: DivergenceDimension;
  /** What opentelemetry-hooks==0.14.0 actually does, empirically confirmed. */
  readonly pythonBehavior: string;
  /** What `@osfactory/otel-hook`'s canonical model does instead, and why. */
  readonly ourBehavior: string;
  /** Function/line basis for the Python behavior claim, for future re-verification against a version bump. */
  readonly citation: string;
};

export const DIVERGENCE_MANIFEST: readonly DivergenceEntry[] = [
  {
    id: "DIVERGENCE-001",
    title: "total_tokens is passed through verbatim, never computed",
    dimension: "usage",
    pythonBehavior:
      "gen_ai.usage.total_tokens is a direct copy of the payload's usage.total_tokens field when present, " +
      "with no arithmetic over input/output/cache-creation tokens. A payload whose top-level and nested " +
      "usage.* fields disagree resolves to whichever the nested usage dict states, independent of accuracy.",
    ourBehavior:
      "normalizeUsage always derives totalTokens = inputTokens + (cacheCreationInputTokens if disjoint-from-input) " +
      "+ outputTokens, and separately preserves any provider-reported total in providerTotalTokens with an " +
      "explicit providerTotalAgreement flag (\"agrees\" | \"disagrees\" | \"unreported\") rather than trusting it blindly.",
    citation: "_apply_genai_semconv, otel_hook.py:4588-4617 (see docs/adr/0002 for the canonical rule)",
  },
  {
    id: "DIVERGENCE-002",
    title: "No reasoning/thinking-token support",
    dimension: "usage",
    pythonBehavior:
      "There is no handling anywhere in the package for a reasoning/thinking token count (o1/o3/Gemini-thinking " +
      "style fields). If a payload reports one, it is silently dropped rather than surfaced as an attribute.",
    ourBehavior:
      "canonicalUsageSchema has an explicit reasoningOutputTokens field, defined as a subset of outputTokens " +
      "and validated as such (reasoningOutputTokens must not exceed outputTokens).",
    citation: "full-file review of otel_hook.py: zero matches for \"reasoning\" or \"thinking\"",
  },
  {
    id: "DIVERGENCE-003",
    title: "No cache-aware validation or reconciliation",
    dimension: "usage",
    pythonBehavior:
      "cache_read_input_tokens and cache_creation_input_tokens are copied as independent attributes with no " +
      "cross-check against input_tokens — a cache subset larger than the input total is accepted silently.",
    ourBehavior:
      "normalizeUsage rejects (not clamps) a cachedInputTokens or cacheCreationInputTokens that would exceed " +
      "inputTokens, and requires an explicit cacheCreationAccounting discriminator whenever cache-creation " +
      "tokens are non-zero, because guessing the accounting mode mis-totals downstream cost calculations.",
    citation: "_apply_genai_semconv, otel_hook.py:4588-4617",
  },
  {
    id: "DIVERGENCE-004",
    title: "PreCompact/PostCompact carry no compaction-specific attributes",
    dimension: "lifecycle",
    pythonBehavior:
      "_EVENT_ATTR_MAP has no entry for PreCompact or PostCompact, despite both being first-class Claude Code " +
      "hook events. Any context-window/token-count fields Claude Code sends on these events are dropped; the " +
      "resulting spans carry only the generic hook identity/genai attributes.",
    ourBehavior:
      "compaction.performed is a first-class canonical event type with explicit optional contextTokensBefore, " +
      "contextTokensAfter, droppedMessageCount, and usage fields.",
    citation: "_EVENT_ATTR_MAP, otel_hook.py:496-523; _CLAUDE_EVENTS, otel_hook.py:328-332",
  },
  {
    id: "DIVERGENCE-005",
    title: "Structural paths (cwd/workspace) are copied verbatim into span attributes",
    dimension: "privacy",
    pythonBehavior:
      "gen_ai.client.cwd and gen_ai.client.workspace are set to the raw filesystem path from the payload on " +
      "every span, unconditionally. Text-content masking (IDE_OTEL_MASK_PROMPTS) only applies to free-text " +
      "content fields, never to these structural attributes, and even there only matches macOS-style /Users/ " +
      "paths, never /home/ or Windows profile paths.",
    ourBehavior:
      "WorkspaceIdentity has no path field at all: workspaceId is a salted opaque `<scheme>:<token>` hash " +
      "(ADR 0005), so a raw path cannot reach an event regardless of the configured content mode.",
    citation:
      "_populate_span path handling and _mask_text/_HOME_RE (otel_hook.py:2650-2654, :276); " +
      "empirically confirmed via the session-start.json fixture's Stop/SessionStart spans carrying the literal cwd",
  },
  {
    id: "DIVERGENCE-006",
    title: "No session-cumulative usage tracking; unconditional session rollup span",
    dimension: "aggregation",
    pythonBehavior:
      "Usage numbers are attached per-event only; no accumulator sums usage across a session anywhere in the " +
      "codebase. Separately, a gen_ai.client.session rollup span was empirically observed even with " +
      "IDE_OTEL_BATCH_ON_STOP=false, so its presence does not reliably signal that a per-turn generation/session " +
      "rollup happened deliberately.",
    ourBehavior:
      "Usage temporality (delta vs. cumulative) is an explicit, required field on every UsageReport, and " +
      "cumulativeToDelta/addUsage refuse to mix modes rather than silently summing or dropping a running total.",
    citation:
      "no session-usage accumulator found in _new_session_context/_update_session_context; " +
      "empirically confirmed extra `gen_ai.client.session` span in the claude-code fixture session output " +
      "despite IDE_OTEL_BATCH_ON_STOP=false",
  },
  {
    id: "DIVERGENCE-007",
    title: "A provider's own event vocabulary is rewritten into Claude Code's",
    dimension: "lifecycle",
    pythonBehavior:
      "The Gemini adapter renames each Gemini CLI hook event to the Claude Code event it considers " +
      "equivalent: a `BeforeTool` payload produces a span named `gen_ai.client.hook.PreToolUse` with " +
      "`gen_ai.client.hook.event=PreToolUse`, keeping the real name only in a secondary " +
      "`gen_ai.client.hook.original_event` attribute. A consumer filtering on the primary event attribute " +
      "therefore cannot tell a Gemini tool call from a Claude Code one, and the two providers' distinct " +
      "hook semantics are flattened into one vocabulary.",
    ourBehavior:
      "Canonical event types are provider-neutral by design (`tool.start`, not any provider's hook name), and " +
      "the provider's own name for the event is preserved verbatim and separately in " +
      "`provenance.sourceEventName` — so `BeforeTool` stays `BeforeTool` while the lifecycle meaning is " +
      "expressed in the canonical type. Nothing is renamed into another provider's vocabulary.",
    citation:
      "empirically confirmed against fixtures/parity/gemini-cli/before-tool.json: the emitted span reports " +
      'hook.event="PreToolUse" with hook.original_event="BeforeTool" and provider_adapter="gemini"',
  },
];

export const findDivergence = (id: string): DivergenceEntry => {
  const entry = DIVERGENCE_MANIFEST.find((candidate) => candidate.id === id);
  if (entry === undefined) {
    throw new Error(`no such divergence manifest entry: ${id}`);
  }
  return entry;
};
