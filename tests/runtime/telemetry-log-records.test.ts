import { SeverityNumber } from "@opentelemetry/api-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../../src/config/schema.js";
import { parseCanonicalEvent, type CanonicalEvent } from "../../src/model/events.js";
import { CANONICAL_SCHEMA_VERSION } from "../../src/model/version.js";
import { createPrivacyService } from "../../src/privacy/service.js";
import {
  canonicalEventsToLogRecords,
  logSignalOf,
  logSignalsForLifecycleEvents,
  LOG_MAPPING_VERSION,
  MAX_LOG_BODY_CHARACTERS,
  MAX_LOG_RECORDS_PER_BATCH,
  MAX_LOG_RECORDS_PER_EVENT,
  NO_LOG_CONTENT,
  type LogSignal,
} from "../../src/telemetry/log-records.js";
import { canonicalEventTraceIdentities } from "../../src/telemetry/semconv.js";
import { createTestIdentity } from "../../src/testing/index.js";

const identity = createTestIdentity();
const resource = resourceFromAttributes({ "service.name": "test" });

let sequence = 0;
const build = (fields: Record<string, unknown>): CanonicalEvent =>
  parseCanonicalEvent({
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    invocationId: identity.invocationId,
    sessionId: identity.sessionId,
    provenance: identity.provenance,
    workspace: identity.workspace,
    extensions: {},
    eventId: `e${String((sequence += 1))}`,
    sequence,
    occurredAt: 1_700_000_000_000,
    ...fields,
  });

const map = (
  events: readonly CanonicalEvent[],
  content = NO_LOG_CONTENT,
): ReturnType<typeof canonicalEventsToLogRecords> =>
  canonicalEventsToLogRecords(events, { resource, content });

const signals = (events: readonly CanonicalEvent[]): readonly unknown[] =>
  map(events).records.map((record) => record.attributes["otelhook.log.signal"]);

describe("canonical log mapping: content is disabled by default", () => {
  it("omits the body and says why, on the default privacy policy", () => {
    // The default policy is `contentMode: omit`, so the privacy service produces a
    // fact with no text at all — the mapping has nothing to disclose even before its
    // own gate applies.
    const privacy = createPrivacyService(DEFAULT_CONFIG.privacy);
    const event = build({
      type: "prompt.submitted",
      promptSource: "user",
      content: privacy.describeContent({ kind: "prompt", text: "a very secret prompt" }),
    });

    const [record] = map([event]).records;
    expect(record?.body).toBeUndefined();
    expect(record?.attributes["otelhook.content.withheld"]).toBe("privacy-policy");
    expect(record?.attributes["otelhook.content.disclosure"]).toBe("omitted");
    // Measurable without being readable: this is the whole point of a content fact.
    expect(record?.attributes["otelhook.content.character_length"]).toBe(20);
    expect(record?.attributes["otelhook.content.hash"]).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(record)).not.toContain("a very secret prompt");
  });

  it("still withholds a disclosed body while the logs pipeline is not permitted content", () => {
    // The case the second gate exists for: a deployment that turned on `redact` to
    // get lengths and hashes must not start publishing prompts because logs were
    // enabled.
    const privacy = createPrivacyService({ ...DEFAULT_CONFIG.privacy, contentMode: "redact" });
    const event = build({
      type: "prompt.submitted",
      promptSource: "user",
      content: privacy.describeContent({ kind: "prompt", text: "disclosed prompt text" }),
    });

    const [record] = map([event]).records;
    expect(record?.attributes["otelhook.content.disclosure"]).toBe("redacted");
    expect(record?.body).toBeUndefined();
    expect(record?.attributes["otelhook.content.withheld"]).toBe("logs-content-disabled");
    expect(JSON.stringify(record)).not.toContain("disclosed prompt text");
  });

  it("discloses a body only once both gates are open", () => {
    const privacy = createPrivacyService({ ...DEFAULT_CONFIG.privacy, contentMode: "redact" });
    const event = build({
      type: "prompt.submitted",
      promptSource: "user",
      content: privacy.describeContent({ kind: "prompt", text: "disclosed prompt text" }),
    });

    const [record] = map([event], { includeContent: true, allowRawContent: false }).records;
    expect(record?.body).toBe("disclosed prompt text");
    expect(record?.attributes["otelhook.content.withheld"]).toBeUndefined();
    expect(record?.attributes["otelhook.content.body_truncated"]).toBe(false);
  });

  it("refuses a raw body without the pre-existing allowRawContent opt-in", () => {
    // A hand-built fact claiming `raw` disclosure. The privacy service would never
    // produce one without the opt-in, so reaching the mapping with it means the
    // fact came from outside that path — and the wire is the last place to refuse.
    const event = build({
      type: "tool.end",
      toolCallId: "call-1",
      toolName: "Bash",
      outcome: "ok",
      output: {
        kind: "tool-output",
        characterLength: 5,
        byteLength: 5,
        contentHash: `sha256:${"0".repeat(64)}`,
        disclosure: "raw",
        text: "verbatim-output",
        truncated: false,
        secretsRedacted: 0,
      },
    });

    const permitted = map([event], { includeContent: true, allowRawContent: false }).records[0];
    expect(permitted?.body).toBeUndefined();
    expect(permitted?.attributes["otelhook.content.withheld"]).toBe("raw-not-permitted");

    const optedIn = map([event], { includeContent: true, allowRawContent: true }).records[0];
    expect(optedIn?.body).toBe("verbatim-output");
  });
});

describe("canonical log mapping: bounds and malformed input", () => {
  it("cuts an oversized body at the record bound and reports that separately", () => {
    // `maxStringLength` raised past the record bound: the privacy policy is happy to
    // disclose 20k characters, and the mapping is not.
    const privacy = createPrivacyService({
      ...DEFAULT_CONFIG.privacy,
      contentMode: "raw",
      allowRawContent: true,
      limits: { ...DEFAULT_CONFIG.privacy.limits, maxStringLength: 65_536 },
    });
    const oversized = "x".repeat(20_000);
    const event = build({
      type: "prompt.submitted",
      promptSource: "user",
      content: privacy.describeContent({ kind: "prompt", text: oversized }),
    });

    const [record] = map([event], { includeContent: true, allowRawContent: true }).records;
    expect(typeof record?.body).toBe("string");
    expect((record?.body as string).length).toBe(MAX_LOG_BODY_CHARACTERS);
    // The fact itself was never truncated by the policy, so the two flags disagree —
    // which is exactly what makes them separately useful.
    expect(record?.attributes["otelhook.content.truncated"]).toBe(false);
    expect(record?.attributes["otelhook.content.body_truncated"]).toBe(true);
    expect(record?.attributes["otelhook.content.character_length"]).toBe(20_000);
  });

  it("counts multi-byte characters by code point, never cutting one in half", () => {
    const privacy = createPrivacyService({
      ...DEFAULT_CONFIG.privacy,
      contentMode: "raw",
      allowRawContent: true,
      limits: { ...DEFAULT_CONFIG.privacy.limits, maxStringLength: 65_536 },
    });
    // Astral-plane characters are two UTF-16 units each; a naive `slice` would split
    // one and emit a lone surrogate.
    const event = build({
      type: "prompt.submitted",
      promptSource: "user",
      content: privacy.describeContent({ kind: "prompt", text: "🙂".repeat(9_000) }),
    });

    const [record] = map([event], { includeContent: true, allowRawContent: true }).records;
    // Exact equality is the strongest form of "no character was split": a body cut
    // mid-character would carry a lone surrogate and could not equal this string.
    expect(record?.body).toBe("🙂".repeat(MAX_LOG_BODY_CHARACTERS));
  });

  it("reports records the batch bound dropped rather than truncating silently", () => {
    // Reachable with validated events, unlike the per-event bound: a caller that saw
    // only "accepted" would otherwise read a clipped batch as a complete one.
    const events = Array.from({ length: MAX_LOG_RECORDS_PER_BATCH + 3 }, () =>
      build({ type: "prompt.submitted", promptSource: "user" }),
    );

    const result = map(events);
    expect(result.records).toHaveLength(MAX_LOG_RECORDS_PER_BATCH);
    expect(result.droppedFacts).toBe(3);
  });

  it("bounds records per event for a batch the canonical schema would have refused", () => {
    // `contentFactsSchema` caps an event at 64 facts, so this shape cannot come from
    // `parseCanonicalEvent` — which is exactly why the per-event bound exists: it is
    // the backstop for a hand-built event reaching the sink, not a routine
    // truncation. Built unvalidated on purpose.
    const privacy = createPrivacyService(DEFAULT_CONFIG.privacy);
    const valid = build({
      type: "generation.end",
      generationId: "gen-1",
      model: { modelId: "test-model" },
      outcome: "ok",
      outputContent: [],
    });
    const overfull = {
      ...valid,
      outputContent: Array.from({ length: MAX_LOG_RECORDS_PER_EVENT + 5 }, (_, index) =>
        privacy.describeContent({ kind: "response", text: `chunk ${String(index)}` }),
      ),
    } as CanonicalEvent;

    const result = map([overfull]);
    expect(result.records).toHaveLength(MAX_LOG_RECORDS_PER_EVENT);
    expect(result.droppedFacts).toBe(5);
  });

  it("keeps a secret-keyed tool input redacted in every mode, including raw", () => {
    // `describeStructured` sanitizes before disclosing, so a secret-keyed value never
    // appears even with both gates open and `raw` permitted.
    const privacy = createPrivacyService({
      ...DEFAULT_CONFIG.privacy,
      contentMode: "raw",
      allowRawContent: true,
    });
    const event = build({
      type: "tool.start",
      toolCallId: "call-1",
      toolName: "Bash",
      toolKind: "execute",
      input: privacy.describeStructured({
        kind: "tool-input",
        value: { command: "deploy", api_key: "sk-live-0123456789abcdef", nested: { token: "ghp_0123456789abcdef" } },
      }),
    });

    const [record] = map([event], { includeContent: true, allowRawContent: true }).records;
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("sk-live-0123456789abcdef");
    expect(serialized).not.toContain("ghp_0123456789abcdef");
    expect(record?.body).toContain("[redacted]");
    // The command itself is not a secret, so it is disclosed: the redaction is
    // targeted, not a blanket refusal.
    expect(record?.body).toContain("deploy");
    expect(record?.attributes["otelhook.content.secrets_redacted"]).toBeGreaterThanOrEqual(2);
  });

  it("redacts secret-looking spans out of free text in redact mode", () => {
    const privacy = createPrivacyService({ ...DEFAULT_CONFIG.privacy, contentMode: "redact" });
    const event = build({
      type: "tool.end",
      toolCallId: "call-1",
      toolName: "Bash",
      outcome: "ok",
      output: privacy.describeContent({
        kind: "tool-output",
        text: "exported AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE then continued",
      }),
    });

    const [record] = map([event], { includeContent: true, allowRawContent: false }).records;
    expect(record?.body).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(record?.body).toContain("[redacted]");
    expect(record?.attributes["otelhook.content.secrets_redacted"]).toBe(1);
  });

  it("emits one record for an event carrying no content at all", () => {
    // Otherwise a delegation or session edge would be silently absent from the
    // stream just because the provider reported no text for it.
    const result = map([
      build({ type: "subagent.start", subagentInvocationId: "sub-1", delegationDepth: 1 }),
    ]);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.body).toBeUndefined();
    expect(result.records[0]?.attributes["otelhook.delegation_depth"]).toBe(1);
  });
});

describe("canonical log mapping: signal classification", () => {
  const toolEvent = (toolName: string, toolKind: string): CanonicalEvent =>
    build({ type: "tool.start", toolCallId: "call-1", toolName, toolKind });

  it("routes shell, file, and MCP tool calls to their own signals", () => {
    expect(signals([toolEvent("Bash", "execute")])).toEqual(["shell"]);
    expect(signals([toolEvent("Read", "read")])).toEqual(["file-operation"]);
    expect(signals([toolEvent("Write", "write")])).toEqual(["file-operation"]);
    expect(signals([toolEvent("Task", "delegate")])).toEqual(["delegation"]);
    expect(signals([toolEvent("Glob", "search")])).toEqual(["tool"]);
    expect(signals([toolEvent("mcp__acme-server__lookup", "unknown")])).toEqual(["mcp"]);
  });

  it("prefers the MCP convention over the tool kind, because the server owns the behavior", () => {
    // An `mcp__*` tool an adapter happened to classify as `execute` is still an MCP
    // call: what it does is defined by the connected server, not by the host agent.
    expect(signals([toolEvent("mcp__acme__run_shell", "execute")])).toEqual(["mcp"]);
  });

  it("separates reasoning from response within one generation.end", () => {
    const privacy = createPrivacyService(DEFAULT_CONFIG.privacy);
    const event = build({
      type: "generation.end",
      generationId: "gen-1",
      model: { modelId: "test-model" },
      outcome: "ok",
      outputContent: [
        privacy.describeContent({ kind: "response", text: "the answer" }),
        privacy.describeContent({ kind: "reasoning", text: "the thinking" }),
      ],
    });
    expect(signals([event])).toEqual(["response", "reasoning"]);
  });

  it("classifies every canonical event type into a signal", () => {
    // A new event type must not silently fall through to a default.
    const every: readonly CanonicalEvent[] = [
      build({ type: "session.start", sessionKind: "interactive" }),
      build({ type: "session.end", reason: "completed" }),
      build({ type: "prompt.submitted", promptSource: "user" }),
      build({ type: "generation.start", generationId: "g1", model: { modelId: "m" } }),
      build({ type: "generation.end", generationId: "g1", model: { modelId: "m" }, outcome: "ok" }),
      build({ type: "tool.start", toolCallId: "c1", toolName: "Bash", toolKind: "execute" }),
      build({ type: "tool.end", toolCallId: "c1", toolName: "Bash", outcome: "ok" }),
      build({ type: "subagent.start", subagentInvocationId: "s1", delegationDepth: 1 }),
      build({ type: "subagent.end", subagentInvocationId: "s1", outcome: "ok" }),
      build({ type: "compaction.performed", trigger: "automatic" }),
      build({
        type: "error.raised",
        errorCode: "internal-error",
        severity: "error",
        phase: "parsing",
        retryable: false,
      }),
    ];
    expect(every.map((event) => logSignalOf(event))).toEqual([
      "session",
      "session",
      "prompt",
      "prompt",
      "response",
      "shell",
      // `tool.end` carries no `toolKind` — only the start edge does — so the same
      // `Bash` call refines to `shell` on its start and stays `tool` on its end. The
      // span for that scope is where the kind is authoritative, because the
      // correlator recovered it from state.
      "tool",
      "delegation",
      "delegation",
      "compaction",
      "error",
    ]);
  });

  it("refines a tool end only as far as the canonical event permits", () => {
    // Stated as its own case so the asymmetry above reads as a documented
    // consequence of the model rather than an inconsistency.
    expect(signals([build({ type: "tool.end", toolCallId: "c", toolName: "Bash", outcome: "ok" })])).toEqual(
      ["tool"],
    );
    // An MCP end still refines, because the name alone carries the convention.
    expect(
      signals([build({ type: "tool.end", toolCallId: "c", toolName: "mcp__acme__x", outcome: "ok" })]),
    ).toEqual(["mcp"]);
  });

  it("derives an adapter's signal coverage from the lifecycle events it declares", () => {
    // Derived rather than declared twice: a hand-maintained second list can go
    // stale, and a stale capability declaration is worse than none.
    expect(logSignalsForLifecycleEvents(["tool.start", "tool.end"])).toEqual([
      "tool",
      "shell",
      "file-operation",
      "mcp",
      "delegation",
    ] satisfies readonly LogSignal[]);
    expect(logSignalsForLifecycleEvents(["prompt.submitted", "generation.end"])).toEqual([
      "prompt",
      "response",
      "reasoning",
    ]);
    expect(logSignalsForLifecycleEvents([])).toEqual([]);
  });
});

describe("canonical log mapping: severity, identity, and correlation", () => {
  it("raises severity for failed outcomes and keeps successes at INFO", () => {
    const severities = (events: readonly CanonicalEvent[]): readonly (number | undefined)[] =>
      map(events).records.map((record) => record.severityNumber);

    expect(
      severities([build({ type: "tool.end", toolCallId: "c", toolName: "Bash", outcome: "ok" })]),
    ).toEqual([SeverityNumber.INFO]);
    expect(
      severities([build({ type: "tool.end", toolCallId: "c", toolName: "Bash", outcome: "error" })]),
    ).toEqual([SeverityNumber.ERROR]);
    expect(
      severities([build({ type: "tool.end", toolCallId: "c", toolName: "Bash", outcome: "denied" })]),
    ).toEqual([SeverityNumber.WARN]);
    expect(severities([build({ type: "session.end", reason: "timeout" })])).toEqual([
      SeverityNumber.ERROR,
    ]);
    expect(
      severities([
        build({
          type: "error.raised",
          errorCode: "telemetry-export-failure",
          severity: "warning",
          phase: "export",
          retryable: true,
        }),
      ]),
    ).toEqual([SeverityNumber.WARN]);
  });

  it("carries the same identity attributes and mapping version on every record", () => {
    const [record] = map([build({ type: "prompt.submitted", promptSource: "user" })]).records;
    expect(record?.attributes).toMatchObject({
      "session.id": identity.sessionId,
      "otelhook.invocation.id": identity.invocationId,
      "otelhook.provider.id": identity.provenance.providerId,
      "otelhook.workspace.id": identity.workspace.workspaceId,
      "otelhook.log.mapping_version": LOG_MAPPING_VERSION,
      "otelhook.event.type": "prompt.submitted",
    });
    expect(record?.eventName).toBe("otelhook.prompt.submitted");
  });

  it("points every record at the span id the trace mapping derives for the same event", () => {
    const events = [
      build({ type: "tool.start", toolCallId: "call-1", toolName: "Bash", toolKind: "execute" }),
      build({ type: "tool.end", toolCallId: "call-1", toolName: "Bash", outcome: "ok" }),
    ];
    const expected = canonicalEventTraceIdentities(events);
    const records = map(events).records;

    expect(records).toHaveLength(2);
    for (const [index, record] of records.entries()) {
      const event = events[index];
      const identityFor = expected.get(event?.eventId ?? "");
      expect(record.spanContext?.traceId).toBe(identityFor?.traceId);
      expect(record.spanContext?.spanId).toBe(identityFor?.spanId);
    }
    // Both edges of one scope are one span, so both records point at it.
    expect(records[0]?.spanContext?.spanId).toBe(records[1]?.spanContext?.spanId);
  });

  it("never merges two sessions into one trace, even inside a single batch", () => {
    // Cross-session contamination is prevented structurally: the trace id is derived
    // from each event's own session, not from anything batch- or module-scoped.
    const events = [
      build({ type: "prompt.submitted", promptSource: "user" }),
      parseCanonicalEvent({
        schemaVersion: CANONICAL_SCHEMA_VERSION,
        invocationId: identity.invocationId,
        sessionId: "other-session",
        provenance: identity.provenance,
        workspace: identity.workspace,
        extensions: {},
        eventId: "other-1",
        sequence: 0,
        occurredAt: 1_700_000_000_000,
        type: "prompt.submitted",
        promptSource: "user",
      }),
    ];

    const traces = map(events).records.map((record) => record.spanContext?.traceId);
    expect(traces[0]).not.toBe(traces[1]);
    expect(new Set(traces).size).toBe(2);
  });
});
