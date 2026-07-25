import { describe, expect, it } from "vitest";

import {
  createOtelHook,
  createProviderRegistry,
  normalizeUsageOrThrow,
  providerDetectionSchema,
  sessionIdSchema,
  type HookIngestInput,
} from "../src/index.js";
import {
  batchContains,
  createFixtureAdapter,
  createInMemoryStateStore,
  createRecordingTelemetrySink,
  createTestHook,
  createFixedClock,
  findDisclosureViolations,
} from "../src/testing/index.js";

const ingestInput = (payload: unknown, overrides: Partial<HookIngestInput> = {}): HookIngestInput => ({
  payload,
  transport: "hook-stdin",
  ...overrides,
});

const sessionStart = {
  provider: "fixture",
  sessionId: "ses_1",
  event: "session.start",
  occurredAt: 1_700_000_000_000,
};

describe("OtelHook ingest: attributed path", () => {
  it("emits canonical events with resolved identity", async () => {
    const harness = createTestHook({ adapters: [createFixtureAdapter()] });
    const outcome = await harness.hook.ingest(ingestInput(sessionStart));

    expect(outcome.ok).toBe(true);
    expect(outcome.attribution).toBe("attributed");
    expect(outcome.providerId).toBe("fixture");
    expect(outcome.detectionConfidence).toBe("exact");
    expect(outcome.emitted).toBe(1);
    expect(outcome.dropped).toBe(0);
    expect(outcome.identity?.sessionId).toBe("ses_1");
    expect(harness.sink.events()).toHaveLength(1);
    expect(harness.sink.events()[0]?.type).toBe("session.start");
    expect(harness.sink.events()[0]?.provenance).toMatchObject({
      providerId: "fixture",
      adapterId: "fixture",
      adapterVersion: "1.0.0",
      detectionConfidence: "exact",
      transport: "hook-stdin",
    });
  });

  it("numbers sequences consecutively across invocations in one session", async () => {
    const harness = createTestHook({ adapters: [createFixtureAdapter()] });
    await harness.hook.ingest(ingestInput(sessionStart));
    await harness.hook.ingest(
      ingestInput({ ...sessionStart, event: "generation", requestId: "req-1" }),
    );
    await harness.hook.ingest(ingestInput({ ...sessionStart, event: "session.end" }));

    expect(harness.sink.events().map((event) => event.sequence)).toEqual([0, 1, 2, 3]);
    expect(harness.sink.events().map((event) => event.type)).toEqual([
      "session.start",
      "generation.start",
      "generation.end",
      "session.end",
    ]);
  });

  it("keeps separate hooks isolated: no shared module-level identity", async () => {
    const first = createTestHook({ adapters: [createFixtureAdapter()] });
    const second = createTestHook({ adapters: [createFixtureAdapter()] });

    await first.hook.ingest(ingestInput(sessionStart));
    await second.hook.ingest(ingestInput({ ...sessionStart, sessionId: "ses_2" }));

    expect(first.sink.events()[0]?.sessionId).toBe("ses_1");
    expect(second.sink.events()[0]?.sessionId).toBe("ses_2");
    expect(first.sink.events()).toHaveLength(1);
    expect(second.sink.events()).toHaveLength(1);
    // Sequence state is per store, so the second hook starts from zero again.
    expect(second.sink.events()[0]?.sequence).toBe(0);
  });

  it("carries opaque consumer attributes onto identity without interpreting them", async () => {
    const harness = createTestHook({ adapters: [createFixtureAdapter()] });
    const outcome = await harness.hook.ingest(
      ingestInput(sessionStart, {
        consumerAttributes: { "consumer.tenant": "acme", "consumer.token": "s3cret" },
      }),
    );

    expect(outcome.identity?.consumerAttributes["consumer.tenant"]).toBe("acme");
    // Secret-looking consumer keys are redacted by the privacy service.
    expect(outcome.identity?.consumerAttributes["consumer.token"]).toBe("[redacted]");
  });

  it("omits prompt content by default and leaks nothing to the sink", async () => {
    const harness = createTestHook({ adapters: [createFixtureAdapter()] });
    const outcome = await harness.hook.ingest(
      ingestInput({
        ...sessionStart,
        event: "prompt",
        promptText: "refactor the billing module using sk-abcdefghijklmnopqrstuvwx",
      }),
    );

    expect(outcome.attribution).toBe("attributed");
    expect(findDisclosureViolations(harness.sink.events())).toEqual([]);
    expect(batchContains(harness.sink.events(), "billing")).toBe(false);
    expect(batchContains(harness.sink.events(), "sk-abcdefghijklmnopqrstuvwx")).toBe(false);

    const event = harness.sink.events()[0];
    if (event?.type !== "prompt.submitted") {
      throw new Error("expected a prompt event");
    }
    expect(event.content?.characterLength).toBeGreaterThan(0);
    expect(event.content?.contentHash).toMatch(/^sha256:/);
  });

  it("keeps tool inputs out of telemetry while recording their shape", async () => {
    const harness = createTestHook({ adapters: [createFixtureAdapter()] });
    await harness.hook.ingest(
      ingestInput({
        ...sessionStart,
        event: "tool",
        toolName: "bash",
        toolInput: { command: "deploy --token=abc123", api_key: "sk-live-1234567890abcdef" },
      }),
    );

    expect(batchContains(harness.sink.events(), "abc123")).toBe(false);
    expect(batchContains(harness.sink.events(), "sk-live")).toBe(false);
    expect(findDisclosureViolations(harness.sink.events())).toEqual([]);
  });
});

describe("OtelHook ingest: fail-closed attribution", () => {
  it("declines attribution for an unknown provider", async () => {
    const harness = createTestHook({ adapters: [createFixtureAdapter()] });
    const outcome = await harness.hook.ingest(ingestInput({ unrelated: "payload" }));

    expect(outcome.ok).toBe(true);
    expect(outcome.attribution).toBe("declined");
    expect(outcome.attributionReason).toBe("provider-unknown");
    expect(outcome.providerId).toBe("unknown");
    expect(outcome.events).toEqual([]);
    expect(harness.sink.events()).toEqual([]);
    expect(outcome.hookResponse.exitCode).toBe(0);
    expect(outcome.hookResponse.stdout).toBeUndefined();
    expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain("provider-unknown");
  });

  it("declines attribution when two adapters claim the payload equally", async () => {
    const twinA = createFixtureAdapter({ id: "twin-a" });
    const twinB = createFixtureAdapter({
      id: "twin-b",
      detect: () =>
        providerDetectionSchema.parse({
          providerId: "twin-b",
          confidence: "exact",
          reasons: ["claims everything"],
        }),
    });
    const harness = createTestHook({ adapters: [twinA, twinB] });
    const outcome = await harness.hook.ingest(
      ingestInput({ ...sessionStart, provider: "twin-a" }),
    );

    expect(outcome.attribution).toBe("declined");
    expect(outcome.attributionReason).toBe("provider-detection-ambiguous");
    expect(outcome.providerId).toBe("unknown");
    expect(harness.sink.events()).toEqual([]);
  });

  it("declines attribution when identity claims conflict", async () => {
    const adapter = createFixtureAdapter({
      extraClaims: [
        {
          source: "test:conflicting",
          confidence: "exact",
          fields: { sessionId: "ses_other" },
        } as never,
      ],
    });
    const harness = createTestHook({ adapters: [adapter] });
    const outcome = await harness.hook.ingest(ingestInput(sessionStart));

    expect(outcome.attribution).toBe("declined");
    expect(outcome.attributionReason).toBe("identity-conflict");
    expect(outcome.events).toEqual([]);
    expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain("identity-conflict");
  });

  it("declines attribution when identity is incomplete", async () => {
    const adapter = createFixtureAdapter({
      detect: () =>
        providerDetectionSchema.parse({
          providerId: "fixture",
          confidence: "exact",
          reasons: ["matches"],
        }),
    });
    const harness = createTestHook({ adapters: [adapter] });
    // A payload the adapter detects but cannot identify: no session id.
    const outcome = await harness.hook.ingest(ingestInput({ provider: "fixture" }));

    expect(outcome.attribution).toBe("declined");
    expect(outcome.attributionReason).toBe("identity-incomplete");
  });
});

describe("OtelHook ingest: fail-open hook behaviour", () => {
  it("contains an adapter that throws while parsing", async () => {
    const harness = createTestHook({ adapters: [createFixtureAdapter({ throwOn: "parse" })] });
    const outcome = await harness.hook.ingest(ingestInput(sessionStart));

    expect(outcome.ok).toBe(true);
    expect(outcome.attribution).toBe("failed");
    expect(outcome.attributionReason).toBe("adapter-failure");
    expect(outcome.hookResponse.exitCode).toBe(0);
    expect(outcome.diagnostics[0]?.code).toBe("provider-adapter-failure");
    expect(JSON.stringify(outcome.diagnostics)).not.toContain("parse failure");
  });

  it("contains an adapter that throws while identifying and still declines cleanly", async () => {
    const harness = createTestHook({ adapters: [createFixtureAdapter({ throwOn: "identify" })] });
    const outcome = await harness.hook.ingest(ingestInput(sessionStart));

    expect(outcome.ok).toBe(true);
    expect(outcome.attribution).toBe("declined");
    expect(outcome.attributionReason).toBe("identity-incomplete");
  });

  it("falls back to a silent response when the adapter cannot build one", async () => {
    const harness = createTestHook({
      adapters: [createFixtureAdapter({ throwOn: "hookResponse" })],
    });
    const outcome = await harness.hook.ingest(ingestInput(sessionStart));

    expect(outcome.hookResponse.contract).toBe("silent");
    expect(outcome.hookResponse.exitCode).toBe(0);
  });

  it("reports an adapter that returns a failure result", async () => {
    const harness = createTestHook({ adapters: [createFixtureAdapter()] });
    const outcome = await harness.hook.ingest(
      ingestInput({ ...sessionStart, event: "session.start", sessionId: "ses_1" }),
    );
    expect(outcome.attribution).toBe("attributed");

    const ignored = await harness.hook.ingest(ingestInput({ ...sessionStart, event: "noop" }));
    expect(ignored.attribution).toBe("not-applicable");
    expect(ignored.attributionReason).toBe("adapter-ignored-input");
    expect(ignored.events).toEqual([]);
  });

  it("survives a rejecting telemetry sink", async () => {
    const harness = createTestHook({ adapters: [createFixtureAdapter()] });
    harness.sink.failNext(1);
    const outcome = await harness.hook.ingest(ingestInput(sessionStart));

    expect(outcome.ok).toBe(true);
    expect(outcome.attribution).toBe("attributed");
    expect(outcome.emitted).toBe(0);
    expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "telemetry-export-failure",
    );
  });

  it("survives an unavailable state store", async () => {
    const harness = createTestHook({ adapters: [createFixtureAdapter()] });
    harness.stateStore.failNext(2);
    const outcome = await harness.hook.ingest(ingestInput(sessionStart));

    expect(outcome.ok).toBe(true);
    expect(outcome.attribution).toBe("attributed");
    expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "state-store-failure",
    );
  });

  it("never rejects, even when the sink throws instead of returning", async () => {
    const clock = createFixedClock();
    const hook = createOtelHook({
      sink: {
        emit: () => {
          throw new Error("sink exploded");
        },
        flush: () => {
          throw new Error("flush exploded");
        },
        shutdown: () => {
          throw new Error("shutdown exploded");
        },
      },
      stateStore: createInMemoryStateStore({ clock }),
      registry: createProviderRegistry([createFixtureAdapter()]),
      clock,
    });

    const outcome = await hook.ingest(ingestInput(sessionStart));
    expect(outcome.ok).toBe(true);
    expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "telemetry-export-failure",
    );
    await expect(hook.flush()).resolves.toBeUndefined();
    await expect(hook.shutdown()).resolves.toBeUndefined();
  });

  it("emits diagnostic error events when configured to", async () => {
    const harness = createTestHook({
      adapters: [createFixtureAdapter()],
      config: { diagnostics: { emitErrorEvents: true } },
    });
    harness.stateStore.failNext(1);
    const outcome = await harness.hook.ingest(ingestInput(sessionStart));

    const errorEvents = outcome.events.filter((event) => event.type === "error.raised");
    expect(errorEvents.length).toBeGreaterThan(0);
    expect(errorEvents[0]?.type === "error.raised" && errorEvents[0].errorCode).toBe(
      "state-store-failure",
    );
    expect(findDisclosureViolations(outcome.events)).toEqual([]);
  });

  it("suppresses diagnostic error events when configured off", async () => {
    const harness = createTestHook({
      adapters: [createFixtureAdapter()],
      config: { diagnostics: { emitErrorEvents: false } },
    });
    harness.stateStore.failNext(1);
    const outcome = await harness.hook.ingest(ingestInput(sessionStart));

    expect(outcome.events.filter((event) => event.type === "error.raised")).toEqual([]);
  });
});

describe("OtelHook ingest: event screening", () => {
  it("drops events beyond the configured per-invocation bound", async () => {
    const harness = createTestHook({
      adapters: [createFixtureAdapter()],
      config: { privacy: { limits: { maxEventsPerInvocation: 1 } } },
    });
    const outcome = await harness.hook.ingest(
      ingestInput({ ...sessionStart, event: "generation", requestId: "req-1" }),
    );

    expect(outcome.events.filter((event) => event.type.startsWith("generation"))).toHaveLength(1);
    expect(outcome.dropped).toBe(1);
    expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain("limit-exceeded");
  });

  it("drops events whose identity does not match the resolved invocation", async () => {
    const harness = createTestHook({ adapters: [createFixtureAdapter()] });
    const rogue = createFixtureAdapter({ id: "rogue" });
    const registry = createProviderRegistry([
      {
        ...rogue,
        parse: (input, context) => {
          const result = rogue.parse(input, context);
          if (result.status !== "parsed") {
            return result;
          }
          return {
            status: "parsed",
            events: result.events.map((event) => ({
              ...event,
              sessionId: sessionIdSchema.parse("ses_hijacked"),
            })),
          };
        },
      },
    ]);
    const hijacked = createTestHook({ registry });
    const outcome = await hijacked.hook.ingest(
      ingestInput({ ...sessionStart, provider: "rogue" }),
    );

    // Only the diagnostic remains; the hijacked event never reaches the sink.
    expect(outcome.events.filter((event) => event.type !== "error.raised")).toEqual([]);
    expect(outcome.dropped).toBe(1);
    expect(hijacked.sink.events().some((event) => event.sessionId === "ses_hijacked")).toBe(false);
    expect(harness.sink.events()).toEqual([]);
  });

  it("drops content that discloses more than the policy allows", async () => {
    const leaky = createFixtureAdapter({ id: "leaky" });
    const registry = createProviderRegistry([
      {
        ...leaky,
        parse: (input, context) => {
          const result = leaky.parse(input, context);
          if (result.status !== "parsed") {
            return result;
          }
          return {
            status: "parsed",
            events: result.events.map((event) =>
              event.type === "prompt.submitted"
                ? {
                    ...event,
                    content: {
                      kind: "prompt" as const,
                      characterLength: 5,
                      byteLength: 5,
                      contentHash: `sha256:${"0".repeat(64)}`,
                      disclosure: "raw" as const,
                      text: "secret prompt text",
                      truncated: false,
                      secretsRedacted: 0,
                    },
                  }
                : event,
            ),
          };
        },
      },
    ]);
    const harness = createTestHook({ registry });
    const outcome = await harness.hook.ingest(
      ingestInput({ ...sessionStart, provider: "leaky", event: "prompt", promptText: "hello" }),
    );

    expect(outcome.events.filter((event) => event.type === "prompt.submitted")).toEqual([]);
    expect(outcome.dropped).toBe(1);
    expect(batchContains(harness.sink.events(), "secret prompt text")).toBe(false);
    expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "privacy-policy-violation",
    );
  });
});

describe("OtelHook usage derivation", () => {
  const cumulativeUsage = (input: number, output: number): Record<string, unknown> => ({
    temporality: "cumulative",
    inputTokens: input,
    outputTokens: output,
  });

  it("passes delta usage through unchanged", async () => {
    const harness = createTestHook({ adapters: [createFixtureAdapter()] });
    const outcome = await harness.hook.ingest(
      ingestInput({
        ...sessionStart,
        event: "generation",
        requestId: "req-1",
        usage: { temporality: "delta", inputTokens: 10, outputTokens: 4 },
      }),
    );

    expect(outcome.usageObservations).toHaveLength(1);
    expect(outcome.usageObservations[0]).toMatchObject({
      scope: "generation",
      scopeKey: "req-1",
      reportedTemporality: "delta",
      resetDetected: false,
    });
    expect(outcome.usageObservations[0]?.delta.inputTokens).toBe(10);
  });

  it("derives deltas from a cumulative session series", async () => {
    const harness = createTestHook({ adapters: [createFixtureAdapter()] });

    const first = await harness.hook.ingest(
      ingestInput({ ...sessionStart, event: "session.end", usage: cumulativeUsage(100, 20) }),
    );
    const second = await harness.hook.ingest(
      ingestInput({ ...sessionStart, event: "session.end", usage: cumulativeUsage(180, 35) }),
    );

    expect(first.usageObservations[0]?.delta.inputTokens).toBe(100);
    expect(first.usageObservations[0]?.reportedTemporality).toBe("cumulative");
    expect(second.usageObservations[0]?.delta.inputTokens).toBe(80);
    expect(second.usageObservations[0]?.delta.outputTokens).toBe(15);
    // The event itself still reports what the provider said.
    const events = harness.sink.events().filter((event) => event.type === "session.end");
    expect(events[1]?.type === "session.end" && events[1].usage?.inputTokens).toBe(180);
  });

  it("is replay-safe: re-ingesting the same cumulative report yields a zero delta", async () => {
    const harness = createTestHook({ adapters: [createFixtureAdapter()] });
    const payload = ingestInput({
      ...sessionStart,
      event: "session.end",
      usage: cumulativeUsage(100, 20),
    });

    await harness.hook.ingest(payload);
    const replay = await harness.hook.ingest(payload);

    expect(replay.usageObservations[0]?.delta.totalTokens).toBe(0);
    expect(replay.usageObservations[0]?.resetDetected).toBe(false);
  });

  it("reports a reset when a cumulative series goes backwards", async () => {
    const harness = createTestHook({ adapters: [createFixtureAdapter()] });
    await harness.hook.ingest(
      ingestInput({ ...sessionStart, event: "session.end", usage: cumulativeUsage(100, 20) }),
    );
    const restarted = await harness.hook.ingest(
      ingestInput({ ...sessionStart, event: "session.end", usage: cumulativeUsage(10, 2) }),
    );

    expect(restarted.usageObservations[0]?.resetDetected).toBe(true);
    expect(restarted.usageObservations[0]?.delta.inputTokens).toBe(10);
  });

  it("scopes cumulative baselines per generation", async () => {
    const harness = createTestHook({ adapters: [createFixtureAdapter()] });
    await harness.hook.ingest(
      ingestInput({
        ...sessionStart,
        event: "generation",
        requestId: "gen-a",
        usage: cumulativeUsage(100, 10),
      }),
    );
    const other = await harness.hook.ingest(
      ingestInput({
        ...sessionStart,
        event: "generation",
        requestId: "gen-b",
        usage: cumulativeUsage(40, 5),
      }),
    );

    expect(other.usageObservations[0]?.scopeKey).toBe("gen-b");
    expect(other.usageObservations[0]?.delta.inputTokens).toBe(40);
    expect([...harness.stateStore.snapshot().keys()].sort()).toEqual([
      "sequence:ses_1",
      "usage:ses_1:generation:gen-a",
      "usage:ses_1:generation:gen-b",
    ]);
  });

  it("skips a usage observation it cannot diff instead of double-counting", async () => {
    const harness = createTestHook({ adapters: [createFixtureAdapter()] });
    await harness.hook.ingest(
      ingestInput({ ...sessionStart, event: "session.end", usage: cumulativeUsage(100, 20) }),
    );
    // Fail the sequence read and the usage read for the next invocation.
    harness.stateStore.failNext(2);
    const outcome = await harness.hook.ingest(
      ingestInput({ ...sessionStart, event: "session.end", usage: cumulativeUsage(150, 25) }),
    );

    expect(outcome.usageObservations).toEqual([]);
    expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "state-store-failure",
    );
  });

  it("rejects an invalid usage report inside the adapter", async () => {
    const harness = createTestHook({ adapters: [createFixtureAdapter()] });
    const outcome = await harness.hook.ingest(
      ingestInput({
        ...sessionStart,
        event: "session.end",
        usage: { temporality: "delta", inputTokens: 5, cachedInputTokens: 50 },
      }),
    );

    // The adapter drops the unusable usage but still reports the lifecycle event.
    expect(outcome.attribution).toBe("attributed");
    const event = outcome.events.find((candidate) => candidate.type === "session.end");
    expect(event?.type === "session.end" && event.usage).toBeUndefined();
  });
});

describe("OtelHook lifecycle", () => {
  it("flushes and shuts down idempotently", async () => {
    const harness = createTestHook({ adapters: [createFixtureAdapter()] });
    await harness.hook.ingest(ingestInput(sessionStart));

    await harness.hook.flush();
    await harness.hook.shutdown();
    await harness.hook.shutdown();

    expect(harness.sink.flushCount()).toBe(2);
    expect(harness.sink.shutdownCount()).toBe(1);
  });

  it("exposes the resolved configuration it is running with", () => {
    const harness = createTestHook({
      adapters: [createFixtureAdapter()],
      config: { privacy: { contentMode: "mask" } },
    });
    expect(harness.hook.config.privacy.contentMode).toBe("mask");
  });

  it("works with hand-assembled dependencies", async () => {
    const clock = createFixedClock({ startMillis: 1_600_000_000_000 });
    const sink = createRecordingTelemetrySink();
    const hook = createOtelHook({
      sink,
      stateStore: createInMemoryStateStore({ clock }),
      registry: createProviderRegistry([createFixtureAdapter()]),
      clock,
    });

    const outcome = await hook.ingest(
      ingestInput({ provider: "fixture", sessionId: "ses_x", event: "session.start" }),
    );

    expect(outcome.attribution).toBe("attributed");
    expect(sink.events()[0]?.occurredAt).toBe(1_600_000_000_000);
  });

  it("accepts pre-normalized usage on events built outside an adapter", () => {
    const usage = normalizeUsageOrThrow({ temporality: "delta", inputTokens: 1 });
    expect(usage.temporality).toBe("delta");
  });
});
