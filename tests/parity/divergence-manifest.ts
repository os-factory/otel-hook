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
      'hook.event="PreToolUse" with hook.original_event="BeforeTool" and provider_adapter="gemini"; the same ' +
      "rewriting is observable for Cursor, whose beforeSubmitPrompt becomes UserPromptSubmit",
  },
  {
    id: "DIVERGENCE-008",
    title: "Cursor's `duration` is read inconsistently: scaled 1000x on one event, dropped on another",
    dimension: "lifecycle",
    pythonBehavior:
      "Cursor sends its tool durations under the key `duration`, in milliseconds. The reference treats that key " +
      "as seconds for AfterMCPExecution — `data[\"duration_ms\"] = float(duration) * 1000` — so a payload " +
      "reporting duration 84.5 emits gen_ai.client.duration_ms=84500, a thousandfold overstatement. For " +
      "AfterShellExecution it reads only `duration_ms`, a key Cursor does not send, so the duration is dropped " +
      "and the span carries none at all. PostToolUse happens to be correct, but only for MCP-encoded tool names, " +
      "because that path alone falls back to `duration`.",
    ourBehavior:
      "The Cursor adapter reads `duration` as milliseconds on every callback that carries it and passes the value " +
      "through unscaled, so 84.5 stays 84.5 and the shell duration survives. The unit is established twice over: " +
      "cursor.com/docs/agent/hooks states it, and a captured `printenv` call reports duration 169.812 — 170ms, " +
      "not 170s. See fixtures/parity/cursor/post-tool-use-mcp.provenance.json.",
    citation:
      "_normalize_cursor_mcp_duration (otel_hook.py:1498-1508) and the AfterShellExecution attribute map " +
      "(otel_hook.py:516); empirically confirmed against fixtures/parity/cursor/after-mcp-execution.json " +
      "(84.5 in, 84500 out) and after-shell-execution.json (169.812 in, no duration attribute out)",
  },
  {
    id: "DIVERGENCE-009",
    title: "Cursor's cache-read tokens are dropped, leaving input tokens with no breakdown",
    dimension: "usage",
    pythonBehavior:
      "Cursor's `stop` and `afterAgentResponse` payloads carry input_tokens, output_tokens, cache_read_tokens, " +
      "and cache_write_tokens. The reference emits gen_ai.usage.input_tokens and gen_ai.usage.output_tokens and " +
      "no cache attribute of any kind, so a consumer cannot tell a fully cached prompt from an uncached one.",
    ourBehavior:
      "normalizeCursorUsage reads cache_read_tokens as a subset of the inclusive input total, so canonical usage " +
      "reports cachedInputTokens and the derived uncachedInputTokens alongside it. cache_write_tokens is " +
      "deliberately *not* mapped: canonical usage requires an explicit cacheCreationAccounting and no source " +
      "establishes whether Cursor bills cache writes inside or beside input_tokens, so a non-zero value produces " +
      "a warning naming the dropped field instead of either guess.",
    citation:
      "empirically confirmed against fixtures/parity/cursor/stop.json: the reference's Stop span reports " +
      "gen_ai.usage.input_tokens=43859 and output_tokens=1076 with no cache attribute, while the adapter reports " +
      "cachedInputTokens=28384 and uncachedInputTokens=15475",
  },
  {
    id: "DIVERGENCE-010",
    title: "Codex client version is read from a host binary on PATH, not from the payload",
    dimension: "lifecycle",
    pythonBehavior:
      "For Codex, `_detect_client_version` never looks at the `codex_version` field the hook payload actually " +
      "carries — it checks `client_version`/`ide_version`/`app_version`, then `$CODEX_VERSION`, and then shells " +
      "out to `subprocess.run([\"codex\", \"--version\"])` against whatever is on the host's PATH, caching the " +
      "result in a process-global for every subsequent payload. `gen_ai.client.version` therefore describes the " +
      "machine that ran the hook rather than the client that produced the event: it is absent on a host without " +
      "the CLI installed, and wrong for any replayed or forwarded payload.",
    ourBehavior:
      "`codex_version` is read from the payload and only from the payload. It reaches `session.start` as " +
      "`agentVersion` and detection as `providerVersion`, and stays absent when the payload omits it. No adapter " +
      "is given a filesystem, a subprocess, or a network handle (see AGENT.md and `ProviderContext`), so " +
      "substituting a host binary's version is not merely avoided by convention — it is unreachable by " +
      "construction. A replayed payload therefore yields the same version attribution on any machine.",
    citation:
      "otel_hook.py:1028-1046 (`_detect_client_version`, codex branch) with the process-global cache at " +
      "otel_hook.py:1004-1005; empirically confirmed against fixtures/parity/codex/session-start.json, whose " +
      'payload states codex_version="0.42.0-fixture" while the emitted span carried the host binary\'s own ' +
      "version string instead",
  },
];

export const findDivergence = (id: string): DivergenceEntry => {
  const entry = DIVERGENCE_MANIFEST.find((candidate) => candidate.id === id);
  if (entry === undefined) {
    throw new Error(`no such divergence manifest entry: ${id}`);
  }
  return entry;
};
