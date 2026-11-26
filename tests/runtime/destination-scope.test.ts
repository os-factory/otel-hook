import { describe, expect, it } from "vitest";

import { resolveDestinationScopes, type DestinationScopeConfig } from "../../src/config/destinations.js";
import { parseCanonicalEvent, type CanonicalEvent } from "../../src/model/events.js";
import { CANONICAL_SCHEMA_VERSION } from "../../src/model/version.js";
import { DEFAULT_PRIVACY_POLICY } from "../../src/privacy/policy.js";
import { createPrivacyService } from "../../src/privacy/service.js";
import {
  omitRestrictedContent,
  type ContentRestrictor,
  routeEventsToScopes,
  routePointsToScopes,
  sessionIdVariantsFor,
} from "../../src/telemetry/destination-scope.js";
import type { MetricPoint } from "../../src/telemetry/metric-model.js";
import { createTestIdentity } from "../../src/testing/index.js";

/**
 * Destination scopes as pure routing: which events and metric points one scoped
 * destination is given, and at what disclosure. Payloads are synthetic.
 */

const REPO_A = "https://github.com/acme/widget";
const REPO_B = "git@github.com:acme/gadget.git";
const SECRET = "sk-abcdefghijklmnopqrstuvwxyz0123";

const identity = createTestIdentity();
let sequence = 0;
const build = (fields: Record<string, unknown>, repository?: string): CanonicalEvent =>
  parseCanonicalEvent({
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    invocationId: identity.invocationId,
    sessionId: identity.sessionId,
    provenance: identity.provenance,
    workspace: identity.workspace,
    extensions: {},
    eventId: `e${String((sequence += 1))}`,
    sequence,
    occurredAt: 1_700_000_010_000 + sequence,
    ...(repository === undefined ? {} : { contextAttributes: { "vcs.repository.url.full": repository } }),
    ...fields,
  });

const rawPrivacy = createPrivacyService({ ...DEFAULT_PRIVACY_POLICY, contentMode: "raw", allowRawContent: true });
const restrict: ContentRestrictor = (fact, mode) => rawPrivacy.restrictContent(fact, mode);

const prompt = (repository: string | undefined, text = `use ${SECRET} please`): CanonicalEvent =>
  build(
    {
      type: "prompt.submitted",
      promptSource: "user",
      content: rawPrivacy.describeContent({ kind: "prompt", text, role: "user" }),
    },
    repository,
  );

const scopesOf = (
  configs: readonly DestinationScopeConfig[],
  signals = { traces: true, logs: true, metrics: true },
) => resolveDestinationScopes(configs, signals);

describe("routeEventsToScopes", () => {
  it("keeps only the scoped repository's events, and none without a repository", () => {
    const a = prompt(REPO_A);
    const b = prompt(REPO_B);
    const unknown = prompt(undefined);
    const routed = routeEventsToScopes([a, b, unknown], scopesOf([{ repositories: [REPO_A] }]), { restrict });
    expect(routed.traces.map((event) => event.eventId)).toEqual([a.eventId]);
    expect(routed.logs.map((event) => event.eventId)).toEqual([a.eventId]);
  });

  it("falls back to the Resource's repository, but never past a context stamp", () => {
    const unstamped = prompt(undefined);
    const stampedB = prompt(REPO_B);
    const routed = routeEventsToScopes([unstamped, stampedB], scopesOf([{ repositories: [REPO_A] }]), {
      restrict,
      resourceRepositoryKey: "github.com/acme/widget",
    });
    expect(routed.traces.map((event) => event.eventId)).toEqual([unstamped.eventId]);

    const garbled = prompt("not a url at all");
    expect(
      routeEventsToScopes([garbled], scopesOf([{ repositories: "*" }]), {
        restrict,
        resourceRepositoryKey: "github.com/acme/widget",
      }).traces,
    ).toEqual([]);
  });

  it("returns the batch itself when every event passes unchanged", () => {
    const events = [prompt(REPO_A), prompt(REPO_B)];
    const routed = routeEventsToScopes(events, scopesOf([{ repositories: "*" }]), { restrict });
    expect(routed.traces).toBe(events);
    expect(routed.logs).toBe(events);
  });

  it("restricts signals per scope (first match wins)", () => {
    const a = prompt(REPO_A);
    const b = prompt(REPO_B);
    const routed = routeEventsToScopes(
      [a, b],
      scopesOf([
        { repositories: [REPO_A], signals: ["traces"] },
        { repositories: "*", signals: ["logs"] },
        { repositories: [REPO_B], signals: ["traces", "logs"] },
      ]),
      { restrict },
    );
    expect(routed.traces.map((event) => event.eventId)).toEqual([a.eventId]);
    expect(routed.logs.map((event) => event.eventId)).toEqual([b.eventId]);
  });

  it("lowers content per scope and never raises it", () => {
    const a = prompt(REPO_A);
    const b = prompt(REPO_B);
    const routed = routeEventsToScopes(
      [a, b],
      scopesOf([
        { repositories: [REPO_A], contentMode: "redact" },
        { repositories: [REPO_B], contentMode: "omit" },
      ]),
      { restrict },
    );
    const [redacted, omitted] = routed.logs;
    expect(redacted?.type === "prompt.submitted" ? redacted.content : undefined).toMatchObject({
      disclosure: "redacted",
      text: "use [redacted] please",
      secretsRedacted: 1,
    });
    const omittedContent = omitted?.type === "prompt.submitted" ? omitted.content : undefined;
    expect(omittedContent?.disclosure).toBe("omitted");
    expect(omittedContent?.text).toBeUndefined();
    // Hash and lengths are kept: they never were content.
    expect(omittedContent?.contentHash).toBe(b.type === "prompt.submitted" ? b.content?.contentHash : "");
    // The input batch is untouched.
    expect(a.type === "prompt.submitted" ? a.content?.text : "").toContain(SECRET);

    const maskPrivacy = createPrivacyService({ ...DEFAULT_PRIVACY_POLICY, contentMode: "mask" });
    const masked = maskPrivacy.describeContent({ kind: "prompt", text: "hello there" });
    expect(maskPrivacy.restrictContent(masked, "raw")).toBe(masked);
    expect(maskPrivacy.restrictContent(masked, "redact")).toBe(masked);
    expect(rawPrivacy.restrictContent(rawPrivacy.describeContent({ kind: "prompt", text: "hi you" }), "mask").text).toBe(
      "** ***",
    );
  });

  it("drops a secret cut by the length bound before redacting", () => {
    const bounded = createPrivacyService({
      ...DEFAULT_PRIVACY_POLICY,
      contentMode: "raw",
      allowRawContent: true,
      limits: { ...DEFAULT_PRIVACY_POLICY.limits, maxStringLength: 20 },
    });
    const fact = bounded.describeContent({ kind: "prompt", text: `token ${SECRET}` });
    expect(fact.truncated).toBe(true);
    expect(fact.text).toBe("token sk-abcdefghijk");
    expect(bounded.restrictContent(fact, "redact").text).toBe("token ");
  });

  it("drops the trailing token in linear time, even on a long run of non-whitespace", () => {
    const bounded = createPrivacyService({
      ...DEFAULT_PRIVACY_POLICY,
      contentMode: "raw",
      allowRawContent: true,
      limits: { ...DEFAULT_PRIVACY_POLICY.limits, maxStringLength: 65_536 },
    });
    // `/\S+$/` backtracked quadratically here (CodeQL js/polynomial-redos).
    const described = bounded.describeContent({ kind: "prompt", text: `${"!".repeat(60_000)} tail 😀x` });
    const fact = { ...described, truncated: true };
    const started = performance.now();
    const restricted = bounded.restrictContent(fact, "redact");
    expect(performance.now() - started).toBeLessThan(1000);
    expect(restricted.text?.endsWith(" tail ")).toBe(true);
  });

  it("without a privacy service, omits whatever must be lowered", () => {
    const fact = rawPrivacy.describeContent({ kind: "prompt", text: "hello" });
    expect(omitRestrictedContent(fact, "mask")).toMatchObject({ disclosure: "omitted" });
    expect(omitRestrictedContent(fact, "mask").text).toBeUndefined();
    expect(omitRestrictedContent(fact, "raw")).toBe(fact);
  });

  it("judges a span's start edge by its end edge in the same batch", () => {
    const start = build(
      { type: "tool.start", toolCallId: "call-1", toolName: "Bash", toolKind: "execute" },
      REPO_B,
    );
    const end = build({ type: "tool.end", toolCallId: "call-1", toolName: "Bash", outcome: "ok" }, REPO_A);
    const loneStart = build(
      { type: "tool.start", toolCallId: "call-2", toolName: "Bash", toolKind: "execute" },
      REPO_B,
    );
    const routed = routeEventsToScopes([start, end, loneStart], scopesOf([{ repositories: [REPO_A] }]), {
      restrict,
    });
    expect(routed.traces.map((event) => event.eventId)).toEqual([start.eventId, end.eventId]);
  });
});

describe("routeEventsToScopes: the session workspace's own remote", () => {
  const WORKSPACE_A = "github.com/acme/widget";

  it("routes an unstamped event by the workspace remote: to A's scope, stamped, and not to B's", () => {
    const unstamped = prompt(undefined);
    const options = { restrict, workspaceRepositoryKey: WORKSPACE_A };
    const toA = routeEventsToScopes([unstamped], scopesOf([{ repositories: [REPO_A] }]), options);
    for (const routed of [toA.traces, toA.logs]) {
      expect(routed.map((event) => event.eventId)).toEqual([unstamped.eventId]);
      // The canonical form of the key the scope matched, never the raw remote.
      expect(routed[0]?.contextAttributes).toEqual({ "vcs.repository.url.full": "https://github.com/acme/widget" });
    }
    // The batch handed in is not touched: unscoped destinations keep it as it was.
    expect(unstamped.contextAttributes).toBeUndefined();
    const toB = routeEventsToScopes([unstamped], scopesOf([{ repositories: [REPO_B] }]), options);
    expect(toB.traces).toEqual([]);
    expect(toB.logs).toEqual([]);
  });

  it("lets a context stamp win over the workspace remote", () => {
    const stampedB = prompt(REPO_B);
    const options = { restrict, workspaceRepositoryKey: WORKSPACE_A };
    expect(routeEventsToScopes([stampedB], scopesOf([{ repositories: [REPO_A] }]), options).traces).toEqual([]);
    expect(routeEventsToScopes([stampedB], scopesOf([{ repositories: [REPO_B] }]), options).traces).toEqual([
      stampedB,
    ]);
    // A stamp that names no repository is not replaced by the workspace's either.
    const garbled = prompt("not a url at all");
    expect(routeEventsToScopes([garbled], scopesOf([{ repositories: "*" }]), options).traces).toEqual([]);
  });

  it("keeps a record's own stamp as it is, and stamps a Resource-routed one with its key", () => {
    const stampedA = prompt("git@github.com:Acme/Widget.git");
    const unstamped = prompt(undefined);
    const routed = routeEventsToScopes([stampedA, unstamped], scopesOf([{ repositories: [REPO_A] }]), {
      restrict,
      resourceRepositoryKey: "github.com/acme/widget",
    });
    expect(routed.traces[0]).toBe(stampedA);
    expect(routed.traces[1]?.contextAttributes?.["vcs.repository.url.full"]).toBe("https://github.com/acme/widget");
  });

  it("puts the workspace remote ahead of the Resource's repository", () => {
    const unstamped = prompt(undefined);
    const routed = routeEventsToScopes([unstamped], scopesOf([{ repositories: [REPO_B] }]), {
      restrict,
      workspaceRepositoryKey: WORKSPACE_A,
      resourceRepositoryKey: "github.com/acme/gadget",
    });
    expect(routed.traces).toEqual([]);
  });

  it("drops an unstamped event without a workspace remote", () => {
    const unstamped = prompt(undefined);
    expect(routeEventsToScopes([unstamped], scopesOf([{ repositories: "*" }]), { restrict }).traces).toEqual([]);
  });

  it("judges a span by its end edge with the same fallback", () => {
    const start = build({ type: "tool.start", toolCallId: "call-w", toolName: "Bash", toolKind: "execute" });
    const end = build({ type: "tool.end", toolCallId: "call-w", toolName: "Bash", outcome: "ok" }, REPO_B);
    const routed = routeEventsToScopes([start, end], scopesOf([{ repositories: [REPO_A] }]), {
      restrict,
      workspaceRepositoryKey: WORKSPACE_A,
    });
    // The unstamped start is judged by its stamped end, which names B.
    expect(routed.traces).toEqual([]);
  });
});

describe("routePointsToScopes", () => {
  const point = (repository: string | undefined, sessionId?: string): MetricPoint => ({
    instrument: "otelhook.tool.calls",
    temporality: "delta",
    attributes: {
      ...(repository === undefined ? {} : { "vcs.repository.url.full": repository }),
      ...(sessionId === undefined ? {} : { "session.id": sessionId }),
    },
    startTimeMillis: 1,
    timeMillis: 2,
    value: 1,
  });

  it("splits one callback's points per repository, and drops unknown ones", () => {
    const withSession = [point(REPO_A, "s"), point(REPO_B, "s"), point(undefined, "s")];
    const kept = routePointsToScopes(
      scopesOf([{ repositories: [REPO_A] }]),
      (variant) => (variant ? withSession : undefined),
      { fallbackKey: undefined, includeSessionId: true },
    );
    expect(kept).toEqual([withSession[0]]);
  });

  it("stamps a point routed by the fallback key, on the scoped copy only, and keeps an own stamp", () => {
    const unstamped = point(undefined, "s");
    const stampedA = point(REPO_A, "s");
    const kept = routePointsToScopes(
      scopesOf([{ repositories: [REPO_A] }]),
      (variant) => (variant ? [unstamped, stampedA] : undefined),
      { fallbackKey: "github.com/acme/widget", includeSessionId: true },
    );
    expect(kept[0]?.attributes).toEqual({
      "session.id": "s",
      "vcs.repository.url.full": "https://github.com/acme/widget",
    });
    expect(kept[1]).toBe(stampedA);
    expect(unstamped.attributes).toEqual({ "session.id": "s" });
    // Another repository's fallback reaches no A scope at all.
    expect(
      routePointsToScopes(scopesOf([{ repositories: [REPO_B] }]), (variant) => (variant ? [unstamped] : undefined), {
        fallbackKey: "github.com/acme/widget",
        includeSessionId: true,
      }),
    ).toEqual([]);
  });

  it("takes each point from the session.id variant its scope asks for", () => {
    const withSession = [point(REPO_A, "s"), point(REPO_B, "s")];
    const withoutSession = [point(REPO_A), point(REPO_B)];
    const scopes = scopesOf([
      { repositories: [REPO_A], includeSessionId: false },
      { repositories: [REPO_B] },
    ]);
    expect(sessionIdVariantsFor(scopes, true)).toEqual(new Set([false, true]));
    const kept = routePointsToScopes(scopes, (variant) => (variant ? withSession : withoutSession), {
      fallbackKey: undefined,
      includeSessionId: true,
    });
    expect(kept).toEqual([withSession[1], withoutSession[0]]);

    // A scope cannot turn session.id back on.
    expect(sessionIdVariantsFor(scopes, false)).toEqual(new Set([false]));
  });

  it("drops points for a scope that does not take metrics", () => {
    const points = [point(REPO_A, "s")];
    expect(
      routePointsToScopes(scopesOf([{ repositories: "*", signals: ["traces"] }]), () => points, {
        fallbackKey: undefined,
        includeSessionId: true,
      }),
    ).toEqual([]);
  });
});
