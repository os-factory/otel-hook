/**
 * Reviewable catalog of gaps between what the *canonical model* can express and
 * what a *shipped provider adapter* actually emits for the same parity fixture.
 *
 * `divergence-manifest.ts` catalogs `opentelemetry-hooks==0.14.0`'s quirks. This
 * file catalogs ours. It exists because the original parity suites compared the
 * Python reference against a hand-written comparison mapper
 * (`harness/canonical-mapping.ts`), which demonstrated what the *model* supports
 * — not what any registered adapter produces. Running the same fixtures through
 * the real adapters surfaced the differences below.
 *
 * Every entry is:
 *   1. Empirically observed by replaying a fixture under `fixtures/parity/**`
 *      through the shipped adapter via `harness/real-adapters.ts`.
 *   2. Asserted by id in a `tests/parity/*.parity.test.ts` file, so an adapter
 *      that starts behaving differently fails loudly and this catalog has to be
 *      updated deliberately rather than drifting.
 *
 * A `contract-mismatch` entry means the fixture and the adapter disagree about
 * where a field lives in the provider's protocol. One of the two is wrong about
 * upstream, and this repository cannot settle it without a real capture — so the
 * entry names the disagreement instead of silently rewriting either side.
 *
 * A `capability-exclusion` entry is one that *has* been settled that way: a real
 * capture confirmed the provider does not report the thing at all, so the gap
 * belongs to upstream rather than to this adapter. Those entries carry
 * `evidence` naming the capture, and they are the only ones that do — an entry
 * without it is still an open question, and the distinction is deliberate.
 */

export type AdapterParityNoteKind =
  /** The adapter declares (via capabilities) that it does not report this. */
  | "declared-capability"
  /**
   * Confirmed against a real capture: the provider does not report this at all,
   * so the gap is a settled exclusion rather than an open question. The strongest
   * kind — it names something upstream, not something this repository chose.
   */
  | "capability-exclusion"
  /** The adapter cannot know this without cross-invocation state it must not hold. */
  | "stateless-adapter"
  /** The fixture and the adapter disagree about a protocol field name. */
  | "contract-mismatch"
  /** The two sides of the comparison consume different envelopes. */
  | "envelope-bridge";

export type AdapterParityNote = {
  readonly id: string;
  readonly providerId: string;
  readonly kind: AdapterParityNoteKind;
  readonly title: string;
  /** What the canonical model or the comparison mapper shows is possible. */
  readonly modelSupports: string;
  /** What the shipped adapter actually does for the parity fixture. */
  readonly adapterEmits: string;
  /** What would have to happen for this entry to go away. */
  readonly resolution: string;
  /**
   * The capture that settled this entry, when one has. Present only on
   * `capability-exclusion` entries: it is what distinguishes "we confirmed the
   * provider does not report this" from "we have not been able to find out".
   */
  readonly evidence?: string;
};

export const ADAPTER_PARITY_NOTES: readonly AdapterParityNote[] = [
  {
    id: "ADAPTER-NOTE-001",
    providerId: "claude-code",
    kind: "capability-exclusion",
    title: "Claude Code reports no reasoning-token counter and no provider total, anywhere",
    modelSupports:
      "canonicalUsageSchema carries cachedInputTokens, cacheCreationInputTokens, reasoningOutputTokens, " +
      "and providerTotalTokens with an explicit agreement flag; the comparison mapper populates all of them " +
      "from the fixture's top-level cache_read_input_tokens / reasoning_output_tokens / usage.total_tokens.",
    adapterEmits:
      "normalizeClaudeUsage reads the nested usage object only, which is where the counters actually live " +
      "(usage.cache_read_input_tokens, usage.cache_creation_input_tokens and its TTL split). The fixture's " +
      "*top-level* cache/reasoning fields and nested usage.total_tokens are not part of Claude Code's " +
      "contract, so the emitted usage reports reasoningOutputTokens=0 and " +
      "providerTotalAgreement=\"unreported\" — and now says which field it declined rather than dropping it.",
    resolution:
      "Resolved as an explicit exclusion, not an open question. reportsReasoningOutput=false and " +
      "reportsProviderTotal=false are facts about the provider: Anthropic bills thinking tokens inside " +
      "output_tokens with no separate counter, and reports no grand total. A consumer can therefore tell " +
      "\"this provider does not report reasoning tokens\" from \"this turn used none\", which is what a " +
      "capability declaration is for. Retiring the exclusion needs an upstream release that adds the " +
      "counters, not a decision by this repository.",
    evidence:
      "Claude Code 2.1.220: 4,999 real usage objects across 40 session transcripts, of which 0 carried any " +
      "key matching /reasoning/, /thinking_token/, or /total_token/; every one sat at message.usage, and none " +
      "carried a top-level token counter. The cache-creation TTL buckets summed to " +
      "cache_creation_input_tokens in 4,999 of 4,999. See docs/claude-code-usage-contract.md (findings 3-5).",
  },
  {
    id: "ADAPTER-NOTE-002",
    providerId: "claude-code",
    kind: "capability-exclusion",
    title: "Neither Claude Code compaction callback reports a context size, so there is none to carry",
    modelSupports:
      "compaction.performed carries both contextTokensBefore and contextTokensAfter, and the comparison " +
      "mapper fills the former by remembering the PreCompact payload across events.",
    adapterEmits:
      "The adapter ignores PreCompact (compaction is reported once it completes) and emits " +
      "compaction.performed from PostCompact alone. Both figures are emitted when one harness attaches them " +
      "to PostCompact, where a single callback carries both ends and no state is involved. A " +
      "context_tokens_before attached to PreCompact alone is declined explicitly, in the ignore reason, " +
      "rather than silently dropped.",
    resolution:
      "Resolved as an explicit exclusion. The premise this note was written on turned out to be wrong: " +
      "Claude Code states no context size on either compaction callback, so there is no provider-reported " +
      "figure for injected state to carry — a state bridge would only relay a value a non-Claude-Code " +
      "harness supplied, at the cost of cross-invocation machinery on the compaction path. Retiring the " +
      "exclusion needs, in order: an upstream release that reports context size, and then — only if it " +
      "reports the before-figure on PreCompact alone — an integration-layer state bridge keyed by session. " +
      "That bridge is the integration layer's to build: ADR 0006 forbids adapters holding cross-invocation " +
      "state, and a channel for it on ProviderParseResult would change a shared contract this provider does " +
      "not own.",
    evidence:
      "Claude Code 2.1.220's own hook-input schemas: PreCompact carries { trigger, custom_instructions } and " +
      "PostCompact carries { trigger, compact_summary }. Neither carries context_tokens_before, " +
      "context_tokens_after, estimated_tokens_removed, or a dropped-message count — and no hook event in the " +
      "protocol carries a token counter at all. Asserted in tests/providers/claude/compaction.test.ts; see " +
      "docs/claude-code-usage-contract.md (findings 1 and 6).",
  },
  {
    id: "ADAPTER-NOTE-005",
    providerId: "cursor",
    kind: "envelope-bridge",
    title: "Cursor parity needs an envelope bridge on our side of the comparison",
    modelSupports:
      "The canonical model is envelope-agnostic; the comparison mapper reads Cursor's real snake_case hook " +
      "JSON directly.",
    adapterEmits:
      "The shipped Cursor adapter targets the payload contract in src/providers/cursor/payload.ts, which that " +
      "file documents as synthetic: camelCase keys, a required timestampMillis, and per-event required " +
      "fields. A real-shaped fixture does not validate against it.",
    resolution:
      "bridgeCursorParityPayload renames the envelope (and performs the one documented seconds-to-milliseconds " +
      "conversion) without inventing semantic fields. Every Cursor parity claim that depends on the bridge says " +
      "so. Removing the bridge requires the provider owner to replace the synthetic contract with a verified one.",
  },
];

export const findAdapterParityNote = (id: string): AdapterParityNote => {
  const note = ADAPTER_PARITY_NOTES.find((candidate) => candidate.id === id);
  if (note === undefined) {
    throw new Error(`no such adapter parity note: ${id}`);
  }
  return note;
};
