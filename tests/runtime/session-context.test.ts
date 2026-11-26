/**
 * Session context (docs/session-context.md): the file format, the segment
 * choice, the screening of attributes, the directory reader, the core stamping
 * step, and how a stamp lands on spans, log records and metric points.
 *
 * Every session id, attribute and path here is synthetic.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { resourceFromAttributes } from "@opentelemetry/resources";
import { afterEach, describe, expect, it } from "vitest";

import { parseCanonicalEvent, type CanonicalEvent } from "../../src/model/events.js";
import { sessionIdSchema } from "../../src/model/primitives.js";
import { normalizeUsageOrThrow } from "../../src/model/usage.js";
import { CANONICAL_SCHEMA_VERSION } from "../../src/model/version.js";
import { createClaudeCodeAdapter } from "../../src/providers/claude/index.js";
import type { SessionContextReader, SessionContextRequest, SessionContextSegment } from "../../src/runtime/ports.js";
import {
  createDirectorySessionContextReader,
  parseSessionContextFile,
  sanitizeSessionContextAttributes,
  segmentInForce,
  SESSION_CONTEXT_AGENT_TOOLS,
  sessionContextFilePath,
  stampSessionContext,
} from "../../src/runtime/session-context.js";
import { agreedContextAttributes, resourceWithContext } from "../../src/telemetry/exporter-resource.js";
import { canonicalEventsToLogRecords } from "../../src/telemetry/log-records.js";
import { deriveMetricObservations } from "../../src/telemetry/metric-model.js";
import { canonicalEventsToReadableSpans } from "../../src/telemetry/semconv.js";
import { createTestHook, createTestIdentity } from "../../src/testing/index.js";

const T0 = Date.parse("2026-11-25T10:00:00.000Z");
const T1 = Date.parse("2026-11-25T11:00:00.000Z");

const file = (segments: unknown[], extra: Record<string, unknown> = {}) => ({
  version: 1,
  agentTool: "claude_code",
  sessionId: "ses-ctx-1",
  segments,
  ...extra,
});

const ATTEMPT_A = {
  "factory.work_unit.id": "wu-7",
  "factory.attempt.id": "attempt-a",
  "factory.slot.id": "1",
  "vcs.ref.head.name": "feat-a",
};

const twoSegments = file([
  { from: "2026-11-25T10:00:00.000Z", to: "2026-11-25T11:00:00.000Z", reason: "launch", attributes: ATTEMPT_A },
  {
    from: "2026-11-25T11:00:00.000Z",
    to: null,
    reason: "launch",
    attributes: { "factory.attempt.id": "attempt-b", "factory.slot.id": "2" },
  },
]);

describe("parseSessionContextFile and segmentInForce", () => {
  const segments = parseSessionContextFile(twoSegments) ?? [];

  it("parses version 1 and picks from <= ts < to, open-ended when to is null", () => {
    expect(segments).toHaveLength(2);
    expect(segmentInForce(segments, T0 - 1)).toBeUndefined();
    expect(segmentInForce(segments, T0)?.attributes["factory.attempt.id"]).toBe("attempt-a");
    expect(segmentInForce(segments, T1 - 1)?.attributes["factory.attempt.id"]).toBe("attempt-a");
    // `to` is exclusive: at the boundary the next segment is in force.
    expect(segmentInForce(segments, T1)?.attributes["factory.attempt.id"]).toBe("attempt-b");
    expect(segmentInForce(segments, T1 + 86_400_000)?.attributes["factory.attempt.id"]).toBe("attempt-b");
  });

  it("finds nothing after a closed segment's end", () => {
    const closed = parseSessionContextFile(
      file([{ from: "2026-11-25T10:00:00Z", to: "2026-11-25T11:00:00Z", reason: "launch", attributes: ATTEMPT_A }]),
    );
    expect(segmentInForce(closed ?? [], T1)).toBeUndefined();
    expect(segmentInForce(closed ?? [], T1 + 1)).toBeUndefined();
  });

  it("rejects a wrong version, a malformed instant, and a file naming another session", () => {
    expect(parseSessionContextFile({ ...twoSegments, version: 2 })).toBeUndefined();
    expect(parseSessionContextFile({ ...twoSegments, version: "1" })).toBeUndefined();
    expect(
      parseSessionContextFile(file([{ from: "yesterday", to: null, reason: "launch", attributes: {} }])),
    ).toBeUndefined();
    expect(parseSessionContextFile({ segments: [] })).toBeUndefined();
    expect(parseSessionContextFile(twoSegments, { sessionId: "another-session" })).toBeUndefined();
    expect(parseSessionContextFile(twoSegments, { agentTool: "codex" })).toBeUndefined();
    expect(parseSessionContextFile(twoSegments, { agentTool: "claude_code", sessionId: "ses-ctx-1" })).toHaveLength(2);
  });

  it("tolerates unknown extra fields from a later minor revision", () => {
    expect(parseSessionContextFile({ ...twoSegments, writer: "some-harness" })).toHaveLength(2);
  });
});

describe("sanitizeSessionContextAttributes", () => {
  it("keeps primitives and drops factory.local.*, otel-hook's own identity, unsafe keys and non-primitives", () => {
    expect(
      sanitizeSessionContextAttributes({
        "factory.attempt.id": "a",
        "factory.slot.number": 2,
        "factory.flag": true,
        "factory.local": "x",
        "factory.local.work_dir": "/home/dev/wt",
        "otelhook.provider.id": "forged",
        "session.id": "forged",
        trace_id: "forged",
        "service.name": "forged",
        "factory.api_key": "secret-looking",
        "bad key": "x",
        "factory.list": ["a"],
        "factory.object": { a: 1 },
        "factory.nan": Number.NaN,
        "factory.long": "x".repeat(5_000),
      }),
    ).toEqual({ "factory.attempt.id": "a", "factory.slot.number": 2, "factory.flag": true });
  });
});

describe("sessionContextFilePath", () => {
  it("maps provider ids to the agent-tool directories a harness writes", () => {
    expect(SESSION_CONTEXT_AGENT_TOOLS["claude-code"]).toBe("claude_code");
    expect(SESSION_CONTEXT_AGENT_TOOLS.codex).toBe("codex");
    expect(SESSION_CONTEXT_AGENT_TOOLS.cursor).toBe("cursor");
    expect(sessionContextFilePath("/ctx", "claude-code", "8f0c-1")).toBe(path.join("/ctx", "claude_code", "8f0c-1.json"));
  });

  it("never builds a path from an unsafe session id, an unknown provider, or a relative directory", () => {
    for (const sessionId of ["../escape", "a/b", "..", ".hidden", "", "a\\b"]) {
      expect(sessionContextFilePath("/ctx", "codex", sessionId)).toBeUndefined();
    }
    expect(sessionContextFilePath("/ctx", "fixture", "ses-1")).toBeUndefined();
    expect(sessionContextFilePath("relative/ctx", "codex", "ses-1")).toBeUndefined();
  });
});

describe("createDirectorySessionContextReader", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  const writeContext = async (agentTool: string, sessionId: string, content: string): Promise<string> => {
    dir ??= await mkdtemp(path.join(tmpdir(), "otelhook-ctx-"));
    await mkdir(path.join(dir, agentTool), { recursive: true });
    await writeFile(path.join(dir, agentTool, `${sessionId}.json`), content, "utf8");
    return dir;
  };

  it("reads the one file of the session", async () => {
    const root = await writeContext("claude_code", "ses-ctx-1", JSON.stringify(twoSegments));
    const reader = createDirectorySessionContextReader({ dir: root });
    const segments = await reader.read({ providerId: "claude-code", sessionId: "ses-ctx-1" });
    expect(segments).toHaveLength(2);
  });

  it("is a no-op for a missing, unparsable, wrong-version, oversized or misplaced file", async () => {
    const root = await writeContext("claude_code", "broken", "{ not json");
    await writeContext("claude_code", "v2", JSON.stringify({ ...twoSegments, sessionId: "v2", version: 2 }));
    await writeContext("claude_code", "big", JSON.stringify({ ...twoSegments, sessionId: "big", pad: "x".repeat(300_000) }));
    // A Claude Code file under the codex directory does not apply to codex.
    await writeContext("codex", "ses-ctx-1", JSON.stringify(twoSegments));
    await mkdir(path.join(root, "claude_code", "a-directory.json"), { recursive: true });
    const reader = createDirectorySessionContextReader({ dir: root });
    for (const sessionId of ["missing", "broken", "v2", "big", "a-directory"]) {
      await expect(reader.read({ providerId: "claude-code", sessionId })).resolves.toBeUndefined();
    }
    await expect(reader.read({ providerId: "codex", sessionId: "ses-ctx-1" })).resolves.toBeUndefined();
    await expect(
      createDirectorySessionContextReader({ dir: path.join(root, "nowhere") }).read({
        providerId: "claude-code",
        sessionId: "ses-ctx-1",
      }),
    ).resolves.toBeUndefined();
  });
});

const identity = createTestIdentity({ sessionId: sessionIdSchema.parse("ses-ctx-1") });
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
    occurredAt: T0 + 60_000,
    ...fields,
  });

describe("stampSessionContext", () => {
  const segments = parseSessionContextFile(twoSegments) ?? [];

  it("stamps each event from the segment in force at its own time", () => {
    const stamped = stampSessionContext(
      [
        build({ type: "session.start", sessionKind: "interactive", occurredAt: T0 - 1 }),
        build({ type: "session.start", sessionKind: "interactive", occurredAt: T0 + 1 }),
        build({ type: "session.start", sessionKind: "interactive", occurredAt: T1 + 1 }),
      ],
      segments,
    );
    expect(stamped.map((event) => event.contextAttributes?.["factory.attempt.id"])).toEqual([
      undefined,
      "attempt-a",
      "attempt-b",
    ]);
  });

  it("strips a stamp the core did not make", () => {
    const forged = build({
      type: "session.start",
      sessionKind: "interactive",
      contextAttributes: { "factory.attempt.id": "forged" },
    });
    expect(stampSessionContext([forged], undefined)[0]?.contextAttributes).toBeUndefined();
    expect(stampSessionContext([forged], [])[0]?.contextAttributes).toBeUndefined();
  });
});

describe("a stamped event on every signal", () => {
  // The process environment still names the previous attempt.
  const staleResource = resourceFromAttributes({
    "service.name": "test",
    "factory.attempt.id": "stale-attempt",
    "factory.work_unit.id": "wu-7",
    "factory.local.work_dir": "/home/dev/wt",
    "deployment.environment": "dev",
  });
  const context = { "factory.attempt.id": "attempt-a", "factory.slot.id": "1" };
  const model = { modelId: "synthetic-model", vendor: "anthropic" };
  const usage = normalizeUsageOrThrow({ temporality: "delta", inputTokens: 10, outputTokens: 2 });
  const events = [
    build({ type: "session.start", sessionKind: "interactive", contextAttributes: context }),
    build({ type: "tool.end", toolCallId: "t1", toolName: "Read", outcome: "ok", contextAttributes: context }),
    build({
      type: "generation.end",
      generationId: "g1",
      model,
      outcome: "ok",
      durationMillis: 1_000,
      usage,
      contextAttributes: context,
    }),
    build({ type: "prompt.submitted", promptSource: "user", contextAttributes: context }),
  ];

  it("puts the context on spans and log records, over the Resource's same key", () => {
    const resource = resourceWithContext(staleResource, agreedContextAttributes(events));
    expect(resource.attributes["factory.attempt.id"]).toBe("attempt-a");
    // No key is added to the Resource, and the rest is left alone.
    expect(resource.attributes["factory.slot.id"]).toBeUndefined();
    expect(resource.attributes["deployment.environment"]).toBe("dev");

    const spans = canonicalEventsToReadableSpans(events, { resource });
    const { records } = canonicalEventsToLogRecords(events, { resource });
    expect(spans.length).toBeGreaterThan(0);
    expect(records.length).toBeGreaterThan(0);
    for (const attributes of [...spans.map((span) => span.attributes), ...records.map((record) => record.attributes)]) {
      expect(attributes["factory.attempt.id"]).toBe("attempt-a");
      expect(attributes["factory.slot.id"]).toBe("1");
      expect(attributes["factory.work_unit.id"]).toBe("wu-7");
      expect(attributes["session.id"]).toBe("ses-ctx-1");
      expect(Object.keys(attributes).some((key) => key.startsWith("factory.local"))).toBe(false);
    }
  });

  it("wins over the Resource on records even when the Resource is not rewritten", () => {
    const spans = canonicalEventsToReadableSpans(events, { resource: staleResource });
    for (const span of spans) {
      expect(span.attributes["factory.attempt.id"]).toBe("attempt-a");
    }
  });

  it("puts the context on every metric point", () => {
    const observations = deriveMetricObservations({
      events,
      usage: [{ eventId: events[2]?.eventId ?? "", scope: "generation", delta: usage }],
      resource: staleResource,
    });
    expect(observations.length).toBeGreaterThanOrEqual(4);
    for (const observation of observations) {
      expect(observation.attributes["factory.attempt.id"]).toBe("attempt-a");
      expect(observation.attributes["factory.slot.id"]).toBe("1");
    }
  });

  it("leaves records alone when the event carries no context", () => {
    const plain = [build({ type: "prompt.submitted", promptSource: "user" })];
    expect(resourceWithContext(staleResource, agreedContextAttributes(plain))).toBe(staleResource);
    const [span] = canonicalEventsToReadableSpans(plain, { resource: staleResource });
    expect(span?.attributes["factory.attempt.id"]).toBe("stale-attempt");
    expect(span?.attributes["factory.slot.id"]).toBeUndefined();
  });

  it("drops a key from the Resource rewrite when the batch's events disagree on it", () => {
    const mixed = [
      build({ type: "session.start", sessionKind: "interactive", contextAttributes: context }),
      build({
        type: "prompt.submitted",
        promptSource: "user",
        contextAttributes: { ...context, "factory.attempt.id": "attempt-b" },
      }),
    ];
    expect(agreedContextAttributes(mixed)).toEqual({ "factory.slot.id": "1" });
  });
});

describe("the core stamping step", () => {
  const recordingReader = (segments: readonly SessionContextSegment[] | undefined) => {
    const requests: SessionContextRequest[] = [];
    const reader: SessionContextReader = {
      read: (request) => {
        requests.push(request);
        return Promise.resolve(segments);
      },
    };
    return { reader, requests };
  };
  const inForce = [{ from: 0, to: null, attributes: { "factory.attempt.id": "attempt-a" } }];

  it("reads the parent session's context for a subagent event and stamps it", async () => {
    const { reader, requests } = recordingReader(inForce);
    const harness = createTestHook({ adapters: [createClaudeCodeAdapter()], sessionContext: reader });
    const outcome = await harness.hook.ingest({
      transport: "hook-stdin",
      providerHint: "claude-code",
      payload: {
        hook_event_name: "PreToolUse",
        session_id: "parent-session-1",
        agent_id: "subagent-7",
        agent_type: "general-purpose",
        transcript_path: "/tmp/synthetic/transcript.jsonl",
        cwd: "/tmp/synthetic",
        tool_name: "Read",
        tool_use_id: "toolu_synthetic_1",
        tool_input: { file_path: "/tmp/synthetic/a.txt" },
      },
    });
    expect(outcome.attribution).toBe("attributed");
    expect(requests).toEqual([{ providerId: "claude-code", sessionId: "parent-session-1" }]);
    const events = harness.sink.events();
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.subagentId).toBe("subagent-7");
      expect(event.contextAttributes).toEqual({ "factory.attempt.id": "attempt-a" });
    }
  });

  it("stamps nothing and still delivers when the reader finds nothing or throws", async () => {
    const throwing: SessionContextReader = { read: () => Promise.reject(new Error("disk on fire")) };
    for (const reader of [recordingReader(undefined).reader, throwing]) {
      const harness = createTestHook({ adapters: [createClaudeCodeAdapter()], sessionContext: reader });
      const outcome = await harness.hook.ingest({
        transport: "hook-stdin",
        providerHint: "claude-code",
        payload: {
          hook_event_name: "SessionStart",
          session_id: "session-2",
          transcript_path: "/tmp/synthetic/transcript.jsonl",
          cwd: "/tmp/synthetic",
          source: "startup",
        },
      });
      expect(outcome.attribution).toBe("attributed");
      expect(outcome.emitted).toBeGreaterThan(0);
      expect(harness.sink.events().every((event) => event.contextAttributes === undefined)).toBe(true);
    }
  });
});
