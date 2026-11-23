import { resourceFromAttributes } from "@opentelemetry/resources";
import { describe, expect, it } from "vitest";

import { parseEnvironmentConfig } from "../../src/config/environment.js";
import { parseCanonicalEvent, type CanonicalEvent } from "../../src/model/events.js";
import { CANONICAL_SCHEMA_VERSION } from "../../src/model/version.js";
import {
  EXTERNAL_SESSION_KEY_ATTRIBUTES,
  resolveExportedSessionId,
} from "../../src/telemetry/export-identity.js";
import { canonicalEventsToLogRecords } from "../../src/telemetry/log-records.js";
import { canonicalEventsToReadableSpans } from "../../src/telemetry/semconv.js";
import { createTestIdentity } from "../../src/testing/index.js";

/**
 * A launcher supplies the session key through `OTEL_RESOURCE_ATTRIBUTES`:
 * `session.id` (OTel semconv) first, then the legacy `har.session_key`, then the
 * provider's own session id. The provider id always stays on
 * `otelhook.session.id` / `gen_ai.conversation.id`.
 */

const identity = createTestIdentity();
const PROVIDER_SESSION = identity.sessionId;

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

const resourceWith = (attributes: Record<string, string>) =>
  resourceFromAttributes({ "service.name": "test", ...attributes });

/** The resource a CLI process would build from `OTEL_RESOURCE_ATTRIBUTES`. */
const resourceFromEnvironment = (raw: string) => {
  const { patch, warnings } = parseEnvironmentConfig({ OTEL_RESOURCE_ATTRIBUTES: raw });
  expect(warnings).toEqual([]);
  return resourceWith({ ...(patch.exporter?.resourceAttributes as Record<string, string>) });
};

describe("resolveExportedSessionId", () => {
  it("checks session.id before har.session_key", () => {
    expect(EXTERNAL_SESSION_KEY_ATTRIBUTES).toEqual(["session.id", "har.session_key"]);
  });

  it("uses a supplied session.id", () => {
    expect(
      resolveExportedSessionId(PROVIDER_SESSION, resourceWith({ "session.id": "slot-session-1" })),
    ).toEqual({ sessionId: "slot-session-1", providerSessionId: PROVIDER_SESSION });
  });

  it("still uses har.session_key when only the legacy key is supplied", () => {
    expect(
      resolveExportedSessionId(
        PROVIDER_SESSION,
        resourceWith({ "har.session_key": "legacy-session" }),
      ),
    ).toEqual({ sessionId: "legacy-session", providerSessionId: PROVIDER_SESSION });
  });

  it("prefers session.id over har.session_key when both are supplied", () => {
    expect(
      resolveExportedSessionId(
        PROVIDER_SESSION,
        resourceWith({ "session.id": "semconv-session", "har.session_key": "legacy-session" }),
      ).sessionId,
    ).toBe("semconv-session");
  });

  it("falls through a blank session.id to har.session_key", () => {
    expect(
      resolveExportedSessionId(
        PROVIDER_SESSION,
        resourceWith({ "session.id": "   ", "har.session_key": "legacy-session" }),
      ).sessionId,
    ).toBe("legacy-session");
  });

  it("trims a supplied key", () => {
    expect(
      resolveExportedSessionId(PROVIDER_SESSION, resourceWith({ "session.id": "  padded  " }))
        .sessionId,
    ).toBe("padded");
  });

  it("falls back to the provider's own session id when nothing is supplied", () => {
    expect(resolveExportedSessionId(PROVIDER_SESSION, resourceWith({}))).toEqual({
      sessionId: PROVIDER_SESSION,
      providerSessionId: PROVIDER_SESSION,
    });
  });

  it("ignores a non-string session.id", () => {
    const resource = resourceFromAttributes({ "service.name": "test", "session.id": 42 });
    expect(resolveExportedSessionId(PROVIDER_SESSION, resource).sessionId).toBe(PROVIDER_SESSION);
  });
});

describe("session.id from OTEL_RESOURCE_ATTRIBUTES on exported records", () => {
  const events = [
    build({ type: "session.start", sessionKind: "unknown", agentName: "claude-code" }),
    build({
      type: "session.end",
      eventId: "e2",
      sequence: 1,
      occurredAt: 1_700_000_001_000,
      reason: "completed",
    }),
  ];

  it("puts the supplied session.id on spans and keeps the provider id separate", () => {
    const resource = resourceFromEnvironment("session.id=slot-session-7,deployment.environment=dev");
    const [span] = canonicalEventsToReadableSpans(events, { resource });
    expect(span?.attributes["session.id"]).toBe("slot-session-7");
    expect(span?.attributes["otelhook.session.id"]).toBe(PROVIDER_SESSION);
    expect(span?.attributes["gen_ai.conversation.id"]).toBe(PROVIDER_SESSION);
  });

  it("puts the supplied session.id on log records and keeps the provider id separate", () => {
    const resource = resourceFromEnvironment("session.id=slot-session-7");
    const [record] = canonicalEventsToLogRecords(
      [build({ type: "prompt.submitted", promptSource: "user" })],
      { resource },
    ).records;
    expect(record?.attributes["session.id"]).toBe("slot-session-7");
    expect(record?.attributes["otelhook.session.id"]).toBe(PROVIDER_SESSION);
    expect(record?.attributes["gen_ai.conversation.id"]).toBe(PROVIDER_SESSION);
  });

  it("prefers session.id over har.session_key from the same variable", () => {
    const resource = resourceFromEnvironment(
      "har.session_key=legacy-session,session.id=semconv-session",
    );
    const [span] = canonicalEventsToReadableSpans(events, { resource });
    expect(span?.attributes["session.id"]).toBe("semconv-session");
    expect(span?.attributes["otelhook.session.id"]).toBe(PROVIDER_SESSION);
  });

  it("keeps the legacy har.session_key path working", () => {
    const resource = resourceFromEnvironment("har.session_key=legacy-session");
    const [span] = canonicalEventsToReadableSpans(events, { resource });
    expect(span?.attributes["session.id"]).toBe("legacy-session");
    expect(span?.attributes["otelhook.session.id"]).toBe(PROVIDER_SESSION);
  });

  it("uses the provider session id when no key is supplied", () => {
    const resource = resourceFromEnvironment("deployment.environment=dev");
    const [span] = canonicalEventsToReadableSpans(events, { resource });
    expect(span?.attributes["session.id"]).toBe(PROVIDER_SESSION);
    expect(span?.attributes["otelhook.session.id"]).toBe(PROVIDER_SESSION);
    expect(span?.attributes["gen_ai.conversation.id"]).toBe(PROVIDER_SESSION);
  });
});
