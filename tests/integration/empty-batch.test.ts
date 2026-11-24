import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_EXPORTER_POLICY } from "../../src/config/schema.js";
import { parseCanonicalEvent } from "../../src/model/events.js";
import { CANONICAL_SCHEMA_VERSION } from "../../src/model/version.js";
import { createFixedClock } from "../../src/runtime/clock.js";
import { createFileDurableSpool } from "../../src/telemetry/durable-spool.js";
import { createOtlpTraceSink } from "../../src/telemetry/otlp-sink.js";
import { createTestIdentity } from "../../src/testing/index.js";
import { startCapturingCollector } from "../helpers/collector.js";

/**
 * Regression: a batch that maps to no span must not reach the collector.
 *
 * A lone `*.start` edge is held for its end rather than exported, so a start-only
 * callback (Claude Code's `SessionStart` or `PreToolUse`) produces zero spans. The
 * sink used to export that empty chunk anyway: one POST per such callback with an
 * empty protobuf body — the "empty request" seen while dogfooding direct export —
 * and, against a down collector, an empty batch spooled only to be quarantined by
 * the next drain.
 */

const identity = createTestIdentity();
const toolStart = () =>
  parseCanonicalEvent({
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    invocationId: identity.invocationId,
    sessionId: identity.sessionId,
    provenance: identity.provenance,
    workspace: identity.workspace,
    extensions: {},
    eventId: "start-only-1",
    sequence: 1,
    occurredAt: 1_000,
    type: "tool.start",
    toolCallId: "call_start_only",
    toolName: "read_file",
    toolKind: "read",
  });

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("start-only batches", () => {
  it("send no request at all", async () => {
    const collector = await startCapturingCollector();
    cleanups.push(() => collector.close());
    const sink = createOtlpTraceSink({
      exporter: { ...DEFAULT_EXPORTER_POLICY, endpoint: collector.url, timeoutMillis: 2_000 },
      providerId: "acme-cli",
      installationId: "install-1",
      clock: createFixedClock(),
    });

    const result = await sink.emit([toolStart()]);
    await sink.shutdown();

    expect(result).toEqual({ accepted: 0, rejected: 0, errors: [] });
    expect(collector.requests).toHaveLength(0);
  });

  it("spool nothing when the collector is down", async () => {
    const down = await startCapturingCollector(() => ({ status: 503 }));
    cleanups.push(() => down.close());
    const rootDir = await mkdtemp(path.join(tmpdir(), "otel-hook-empty-batch-"));
    cleanups.push(() => rm(rootDir, { recursive: true, force: true }));
    const clock = createFixedClock();
    const spool = createFileDurableSpool({
      rootDir,
      providerId: "acme-cli",
      installationId: "install-1",
      clock,
    });
    const sink = createOtlpTraceSink({
      exporter: { ...DEFAULT_EXPORTER_POLICY, endpoint: down.url, timeoutMillis: 1_000 },
      providerId: "acme-cli",
      installationId: "install-1",
      clock,
      spool,
    });

    const result = await sink.emit([toolStart()]);

    expect(result).toEqual({ accepted: 0, rejected: 0, errors: [] });
    expect(down.requests).toHaveLength(0);
    expect(await spool.size()).toBe(0);
    expect(sink.health().totalRejected).toBe(0);
  });
});
