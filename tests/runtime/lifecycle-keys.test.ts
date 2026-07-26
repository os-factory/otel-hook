import { describe, expect, it } from "vitest";

import {
  DEDUP_KEY_VERSION,
  dedupKey,
  dedupScanPrefix,
  rollupEpochKey,
  rollupUsageKey,
  SPAN_KEY_VERSION,
  spanKey,
  spanScanPrefix,
} from "../../src/lifecycle/keys.js";

/**
 * The state store hashes a whole logical key into one record, so two logical
 * keys that render identically *are* one record. These tests pin the two
 * properties that keeps safe: distinct inputs stay distinct, and a sweep can
 * still reach a previous layout version.
 */
describe("lifecycle state key spaces", () => {
  it("keeps the span and dedup spaces disjoint", () => {
    const span = spanKey("ses-1", "claude-code", "tool", "toolu_1");
    const dedup = dedupKey("ses-1", "toolu_1");

    expect(span.startsWith(spanScanPrefix())).toBe(true);
    expect(dedup.startsWith(dedupScanPrefix())).toBe(true);
    expect(span.startsWith(dedupScanPrefix())).toBe(false);
    expect(dedup.startsWith(spanScanPrefix())).toBe(false);
  });

  it("does not let a colon in one segment forge the next delimiter", () => {
    // Without escaping both of these render "lifecycle:dedup:...:a:b:c", so one
    // delivery would suppress an unrelated one.
    expect(dedupKey("a:b", "c")).not.toBe(dedupKey("a", "b:c"));
    expect(dedupKey("a", "b")).not.toBe(dedupKey("a:b", ""));

    expect(spanKey("s", "p", "tool", "x:y")).not.toBe(spanKey("s", "p", "tool:x", "y"));
    expect(spanKey("s:p", "tool", "x", "y")).not.toBe(spanKey("s", "p", "tool", "x:y"));

    expect(rollupUsageKey("s", "tool", "x:y")).not.toBe(rollupUsageKey("s", "tool:x", "y"));
    expect(rollupEpochKey("s", "tool", "x:y")).not.toBe(rollupEpochKey("s", "tool:x", "y"));
  });

  it("keeps the escaping injective, so `%` cannot spoof an escape", () => {
    // "%3A" typed literally must not collide with an escaped colon.
    expect(dedupKey("a%3Ab", "c")).not.toBe(dedupKey("a:b", "c"));
    expect(spanKey("s", "p", "tool", "%3A")).not.toBe(spanKey("s", "p", "tool", ":"));
  });

  it("leaves an ordinary segment byte-identical, so no baseline is reset", () => {
    // Adopting the escaping must not silently orphan records already on disk.
    expect(rollupUsageKey("ses-1", "tool", "toolu_1")).toBe("lifecycle:usage:ses-1:tool:toolu_1");
    expect(dedupKey("delivery", "cb-1")).toBe(
      `lifecycle:dedup:v${String(DEDUP_KEY_VERSION)}:delivery:cb-1`,
    );
    expect(spanKey("ses-1", "claude-code", "tool", "toolu_1")).toBe(
      `lifecycle:span:v${String(SPAN_KEY_VERSION)}:ses-1:claude-code:tool:toolu_1`,
    );
  });

  it("scopes a read to one layout version but a sweep to every one", () => {
    const scopedSpan = spanScanPrefix("ses-1");
    const scopedDedup = dedupScanPrefix("delivery");

    expect(scopedSpan).toContain(`v${String(SPAN_KEY_VERSION)}`);
    expect(scopedDedup).toContain(`v${String(DEDUP_KEY_VERSION)}`);
    expect(spanKey("ses-1", "p", "tool", "x").startsWith(scopedSpan)).toBe(true);
    expect(dedupKey("delivery", "cb-1").startsWith(scopedDedup)).toBe(true);

    // The bare prefixes carry no version, so a janitor sweep still reclaims
    // records a previous layout wrote.
    expect(spanScanPrefix()).not.toContain("v");
    expect(dedupScanPrefix()).not.toContain("v");
    expect(`lifecycle:span:v1:ses-1:tool:x`.startsWith(spanScanPrefix())).toBe(true);
    expect(`lifecycle:dedup:ses-1:cb-1`.startsWith(dedupScanPrefix())).toBe(true);
  });

  it("scopes a span read by provider, so two providers cannot share a record", () => {
    expect(spanKey("ses-1", "claude-code", "tool", "t1")).not.toBe(
      spanKey("ses-1", "codex", "tool", "t1"),
    );
  });
});
