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
 */

export type AdapterParityNoteKind =
  /** The adapter declares (via capabilities) that it does not report this. */
  | "declared-capability"
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
};

export const ADAPTER_PARITY_NOTES: readonly AdapterParityNote[] = [
  {
    id: "ADAPTER-NOTE-001",
    providerId: "claude-code",
    kind: "declared-capability",
    title: "Claude Code usage is read only from a nested Anthropic-shaped `usage` object",
    modelSupports:
      "canonicalUsageSchema carries cachedInputTokens, cacheCreationInputTokens, reasoningOutputTokens, " +
      "and providerTotalTokens with an explicit agreement flag; the comparison mapper populates all of them " +
      "from the fixture's top-level cache_read_input_tokens / reasoning_output_tokens / usage.total_tokens.",
    adapterEmits:
      "normalizeClaudeUsage reads only payload.usage.{input,output,cache_creation,cache_read}_tokens. " +
      "The fixture's top-level cache/reasoning fields and nested usage.total_tokens are outside that shape, " +
      "so the emitted usage reports cachedInputTokens=0, reasoningOutputTokens=0, and " +
      "providerTotalAgreement=\"unreported\".",
    resolution:
      "This is consistent with the adapter's declared capabilities (reportsReasoningOutput=false, " +
      "reportsProviderTotal=false), which is exactly what a capability declaration is for: a consumer can " +
      "tell \"this adapter does not report reasoning tokens\" from \"this turn used none\". Promoting those " +
      "capabilities requires the provider owner to confirm where Claude Code really reports the fields.",
  },
  {
    id: "ADAPTER-NOTE-002",
    providerId: "claude-code",
    kind: "stateless-adapter",
    title: "contextTokensBefore reported only on PreCompact cannot reach compaction.performed",
    modelSupports:
      "compaction.performed carries both contextTokensBefore and contextTokensAfter, and the comparison " +
      "mapper fills the former by remembering the PreCompact payload across events.",
    adapterEmits:
      "The adapter ignores PreCompact (compaction is reported once it completes) and emits " +
      "compaction.performed from PostCompact alone, so only contextTokensAfter is present.",
    resolution:
      "Not fixable inside an adapter: ADR 0006 forbids adapters holding cross-invocation state, and each " +
      "hook firing is a separate process. Carrying the PreCompact figure forward would have to be done by " +
      "the integration layer through the injected state store, keyed by session.",
  },
  {
    id: "ADAPTER-NOTE-003",
    providerId: "claude-code",
    kind: "contract-mismatch",
    title: "SessionEnd reason field name disagreement",
    modelSupports: "session.end carries a mapped reason (completed | aborted | error | timeout | unknown).",
    adapterEmits:
      "sessionEndPayloadSchema requires `end_reason`; the parity fixture sends `reason`. The payload fails " +
      "schema validation, so the invocation is reported as an adapter failure (invalid-input) and no " +
      "session.end event is emitted at all.",
    resolution:
      "A real Claude Code SessionEnd capture must settle which field name upstream sends. Until then this is " +
      "a release blocker for claiming Claude Code session-end coverage, not a test to relax.",
  },
  {
    id: "ADAPTER-NOTE-004",
    providerId: "claude-code",
    kind: "contract-mismatch",
    title: "PostCompact trigger field name disagreement",
    modelSupports: "compaction.performed carries trigger = automatic | manual | unknown.",
    adapterEmits:
      "The adapter reads `compact_trigger` and maps \"auto\" to automatic; the parity fixture sends " +
      "`trigger: \"automatic\"`, so the emitted trigger is \"unknown\".",
    resolution:
      "Same as ADAPTER-NOTE-003: a real capture must settle the field name. `unknown` is at least honest — " +
      "it does not assert a trigger the adapter did not read.",
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
