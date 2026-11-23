import { resourceFromAttributes } from "@opentelemetry/resources";
import { describe, expect, it } from "vitest";

import { parseEnvironmentConfig } from "../../src/config/environment.js";
import { parseCanonicalEvent, type CanonicalEvent } from "../../src/model/events.js";
import { CANONICAL_SCHEMA_VERSION } from "../../src/model/version.js";
import { passthroughResourceAttributes } from "../../src/telemetry/export-identity.js";
import { canonicalEventsToLogRecords } from "../../src/telemetry/log-records.js";
import { canonicalEventsToReadableSpans } from "../../src/telemetry/semconv.js";
import { createTestIdentity } from "../../src/testing/index.js";

/**
 * Profile resource attributes (`har.*`, `factory.*`, `vcs.*`) are copied onto
 * every span and log record so backends that index only record attributes can
 * filter on them. `factory.local.*` is local-only: Resource, never records.
 */

const identity = createTestIdentity();

const build = (fields: Record<string, unknown>): CanonicalEvent =>
  parseCanonicalEvent({
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    invocationId: identity.invocationId,
    sessionId: identity.sessionId,
    provenance: identity.provenance,
    workspace: identity.workspace,
    extensions: {},
    eventId: "e1",
    sequence: 0,
    occurredAt: 1_700_000_000_000,
    ...fields,
  });

const PROFILE =
  "session.id=run-1,factory.work_unit.id=wu-42,factory.slot.id=3," +
  "factory.local.work_dir=%2Fhome%2Fdev%2Fwt,factory.local.repo_path=%2Fhome%2Fdev%2Frepo," +
  "vcs.ref.head.name=feat%2Fexample,vcs.repository.url.full=https%3A%2F%2Fgit.example%2Fr," +
  "har.agent_id=2,deployment.environment=dev";

/** The resource a CLI process would build from `OTEL_RESOURCE_ATTRIBUTES`. */
const resourceFromEnvironment = (raw: string) => {
  const { patch, warnings } = parseEnvironmentConfig({ OTEL_RESOURCE_ATTRIBUTES: raw });
  expect(warnings).toEqual([]);
  return resourceFromAttributes({
    "service.name": "test",
    ...(patch.exporter?.resourceAttributes as Record<string, string>),
  });
};

const expectProfileOnRecord = (attributes: Record<string, unknown> | undefined): void => {
  expect(attributes?.["factory.work_unit.id"]).toBe("wu-42");
  expect(attributes?.["factory.slot.id"]).toBe("3");
  expect(attributes?.["vcs.repository.url.full"]).toBe("https://git.example/r");
  expect(attributes?.["har.agent_id"]).toBe("2");
  expect(attributes?.["session.id"]).toBe("run-1");
  const keys = Object.keys(attributes ?? {});
  expect(keys.filter((key) => key.startsWith("factory.local"))).toEqual([]);
  expect(JSON.stringify(attributes)).not.toContain("/home/dev");
  // Not a passthrough namespace: stays on the Resource.
  expect(attributes?.["deployment.environment"]).toBeUndefined();
};

describe("passthroughResourceAttributes", () => {
  it("copies har.*, factory.* and vcs.* primitives, never factory.local.*", () => {
    const resource = resourceFromAttributes({
      "service.name": "test",
      "session.id": "run-1",
      "har.agent_id": 2,
      "factory.work_unit.id": "wu-42",
      "factory.slot.id": "3",
      "factory.local": "x",
      "factory.local.work_dir": "/home/dev/wt",
      "factory.localish": "kept",
      "vcs.ref.head.name": "feat/example",
      "vcs.change.id": 7,
      "deployment.environment": "dev",
      "factory.list": ["a", "b"],
    });
    expect(passthroughResourceAttributes(resource)).toEqual({
      "har.agent_id": 2,
      "factory.work_unit.id": "wu-42",
      "factory.slot.id": "3",
      "factory.localish": "kept",
      "vcs.ref.head.name": "feat/example",
      "vcs.change.id": 7,
    });
  });
});

describe("profile attributes on exported records", () => {
  it("are on session spans, with factory.local.* left on the Resource", () => {
    const resource = resourceFromEnvironment(PROFILE);
    const events = [
      build({ type: "session.start", sessionKind: "unknown", agentName: "claude-code" }),
      build({ type: "session.end", eventId: "e2", sequence: 1, occurredAt: 1_700_000_001_000, reason: "completed" }),
    ];
    const [span] = canonicalEventsToReadableSpans(events, { resource });
    expectProfileOnRecord(span?.attributes);
    // No target resolved: the launcher's branch is the fallback.
    expect(span?.attributes["vcs.ref.head.name"]).toBe("feat/example");
    expect(span?.resource.attributes["factory.local.work_dir"]).toBe("/home/dev/wt");
  });

  it("are on tool spans and standalone spans", () => {
    const resource = resourceFromEnvironment(PROFILE);
    const spans = canonicalEventsToReadableSpans(
      [
        build({ type: "tool.start", toolCallId: "c1", toolName: "read_file", toolKind: "read" }),
        build({ type: "tool.end", eventId: "e2", sequence: 1, toolCallId: "c1", toolName: "read_file", outcome: "ok" }),
        build({ type: "prompt.submitted", eventId: "e3", sequence: 2, promptSource: "user" }),
      ],
      { resource },
    );
    expect(spans.length).toBeGreaterThanOrEqual(2);
    for (const span of spans) {
      expectProfileOnRecord(span.attributes);
      expect(span.attributes["vcs.ref.head.name"]).toBe("feat/example");
    }
  });

  it("are on log records", () => {
    const resource = resourceFromEnvironment(PROFILE);
    const { records } = canonicalEventsToLogRecords(
      [build({ type: "prompt.submitted", promptSource: "user" })],
      { resource },
    );
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expectProfileOnRecord(record.attributes);
      expect(record.resource.attributes["factory.local.repo_path"]).toBe("/home/dev/repo");
    }
  });

  it("let an event's own resolved target win over the resource branch", () => {
    const resource = resourceFromEnvironment(PROFILE);
    const target = { workspaceId: "sha256:targeted", source: "session-cwd", vcsBranchName: "feat/other" };
    const [span] = canonicalEventsToReadableSpans(
      [build({ type: "prompt.submitted", promptSource: "user", target })],
      { resource },
    );
    expect(span?.attributes["vcs.ref.head.name"]).toBe("feat/other");
    expect(span?.attributes["otelhook.target.source"]).toBe("session-cwd");
    expect(span?.attributes["factory.work_unit.id"]).toBe("wu-42");
    const [record] = canonicalEventsToLogRecords(
      [build({ type: "prompt.submitted", promptSource: "user", target })],
      { resource },
    ).records;
    expect(record?.attributes["vcs.ref.head.name"]).toBe("feat/other");
  });

  it("does not let a resource session.id overwrite the resolved one", () => {
    const resource = resourceFromAttributes({ "service.name": "test", "session.id": "  padded  " });
    const [record] = canonicalEventsToLogRecords(
      [build({ type: "prompt.submitted", promptSource: "user" })],
      { resource },
    ).records;
    expect(record?.attributes["session.id"]).toBe("padded");
  });
});
