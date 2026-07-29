/**
 * Claude Code's compaction contract, and the `contextTokensBefore` exclusion.
 *
 * Confirmed against 2.1.220's own hook-input schemas: `PreCompact` carries
 * `{ trigger, custom_instructions }` and `PostCompact` carries
 * `{ trigger, compact_summary }`. **Neither reports a token count.** That is what
 * settles `ADAPTER-NOTE-002`: there is no provider-stated context size to carry
 * across the compaction boundary, so `contextTokensBefore` is an explicit
 * capability exclusion rather than a plumbing gap waiting on injected state.
 *
 * See docs/claude-code-usage-contract.md, finding 6.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { CanonicalEvent } from "../../../src/model/events.js";
import { createClaudeCodeAdapter } from "../../../src/providers/claude/index.js";
import { createTestHook } from "../../../src/testing/index.js";

const CONTRACTS_DIR = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "fixtures",
  "contracts",
  "claude-code",
);

const loadFixture = async (name: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(path.join(CONTRACTS_DIR, name), "utf8")) as Record<string, unknown>;

type SessionReplay = {
  readonly events: readonly CanonicalEvent[];
  readonly attributions: readonly string[];
  readonly ignoredReasons: readonly string[];
};

/** Replay an ordered session, one ingest per payload, as separate hook firings would. */
const replaySession = async (payloads: readonly unknown[]): Promise<SessionReplay> => {
  const harness = createTestHook({ adapters: [createClaudeCodeAdapter()] });
  const attributions: string[] = [];
  for (const payload of payloads) {
    const outcome = await harness.hook.ingest({
      payload,
      transport: "hook-stdin",
      providerHint: "claude-code",
    });
    attributions.push(outcome.attribution);
  }
  await harness.hook.flush();

  const ignoredReasons = harness.logger
    .records()
    .filter((record) => record.message === "adapter ignored input")
    .map((record) => String(record.fields?.["adapter.reason"] ?? ""));

  return { events: harness.sink.events(), attributions, ignoredReasons };
};

const compactionOf = (events: readonly CanonicalEvent[]): CanonicalEvent | undefined =>
  events.find((event) => event.type === "compaction.performed");

describe("Claude Code compaction: the upstream contract carries no token counts", () => {
  it("emits one compaction.performed from PostCompact with the trigger and no context sizes", async () => {
    const { events, attributions } = await replaySession([
      await loadFixture("pre-compact-upstream.json"),
      await loadFixture("post-compact-upstream.json"),
    ]);

    const compaction = compactionOf(events);
    expect(events.filter((event) => event.type === "compaction.performed")).toHaveLength(1);
    expect(compaction?.type === "compaction.performed" ? compaction.trigger : undefined).toBe(
      "automatic",
    );
    // Absent because the provider reports no context size on either callback —
    // not because the adapter dropped one.
    expect(
      compaction?.type === "compaction.performed" ? compaction.contextTokensBefore : undefined,
    ).toBeUndefined();
    expect(
      compaction?.type === "compaction.performed" ? compaction.contextTokensAfter : undefined,
    ).toBeUndefined();
    // PreCompact yields no telemetry: reported as not-applicable, never as an error.
    expect(attributions).toEqual(["not-applicable", "attributed"]);
  });

  it("never lets the conversation summary reach an event", async () => {
    const postCompact = await loadFixture("post-compact-upstream.json");
    const { events } = await replaySession([postCompact]);

    // `compact_summary` is a model-generated précis of the conversation. The
    // adapter does not read it, so there is no path by which it could leak.
    expect(JSON.stringify(events)).not.toContain("Synthetic placeholder standing in");
    expect(JSON.stringify(events)).not.toContain("compact_summary");
  });
});

describe("Claude Code compaction: contextTokensBefore is an explicit exclusion", () => {
  it("carries both figures when one harness attaches them to the single PostCompact callback", async () => {
    const { events } = await replaySession([
      {
        ...(await loadFixture("post-compact-upstream.json")),
        context_tokens_before: 180_000,
        context_tokens_after: 42_000,
        dropped_message_count: 37,
      },
    ]);

    const compaction = compactionOf(events);
    // No state, no cross-invocation carry: one callback stated both ends.
    expect(compaction?.type === "compaction.performed" ? compaction.contextTokensBefore : undefined).toBe(
      180_000,
    );
    expect(compaction?.type === "compaction.performed" ? compaction.contextTokensAfter : undefined).toBe(
      42_000,
    );
    expect(
      compaction?.type === "compaction.performed" ? compaction.droppedMessageCount : undefined,
    ).toBe(37);
  });

  it("declines a PreCompact-only before-figure explicitly, naming the exclusion", async () => {
    const { events, attributions, ignoredReasons } = await replaySession([
      { ...(await loadFixture("pre-compact-upstream.json")), context_tokens_before: 180_000 },
      { ...(await loadFixture("post-compact-upstream.json")), context_tokens_after: 42_000 },
    ]);

    const compaction = compactionOf(events);
    expect(compaction?.type === "compaction.performed" ? compaction.contextTokensAfter : undefined).toBe(
      42_000,
    );
    // The exclusion: an adapter must not hold cross-invocation state (ADR 0006),
    // and no canonical channel exists to hand the figure to the integration layer.
    expect(
      compaction?.type === "compaction.performed" ? compaction.contextTokensBefore : undefined,
    ).toBeUndefined();
    expect(attributions[0]).toBe("not-applicable");
    // Declined out loud, so a harness can find out why its field vanished — and
    // within the 160 characters a reason survives at the log boundary, so the
    // remedy is not the part that gets truncated.
    expect(ignoredReasons.join(" ")).toContain("contextTokensBefore is an explicit exclusion");
    expect(ignoredReasons.join(" ")).toContain("attach context_tokens_before to PostCompact");
  });

  it("stays quiet about the exclusion when no before-figure was offered", async () => {
    const { ignoredReasons } = await replaySession([
      await loadFixture("pre-compact-upstream.json"),
    ]);

    expect(ignoredReasons).toHaveLength(1);
    expect(ignoredReasons[0]).toBe("compaction is reported once it completes, at PostCompact");
  });
});
