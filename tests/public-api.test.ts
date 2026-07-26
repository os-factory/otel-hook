import { describe, expect, it } from "vitest";

import * as library from "../src/index.js";
import * as config from "../src/config/index.js";
import * as model from "../src/model/index.js";
import * as providers from "../src/providers/index.js";
import * as testing from "../src/testing/index.js";
import * as diagnostics from "../src/public/diagnostics.js";
import * as lifecycle from "../src/public/lifecycle.js";
import * as state from "../src/public/state.js";
import * as telemetry from "../src/public/telemetry.js";
import * as install from "../src/install/index.js";
import * as integration from "../src/integration/index.js";

describe("public surface", () => {
  it("exports the contract provider agents build against", () => {
    for (const name of [
      "CANONICAL_SCHEMA_VERSION",
      "canonicalEventSchema",
      "canonicalUsageSchema",
      "normalizeUsage",
      "cumulativeToDelta",
      "invocationIdentitySchema",
      "resolveInvocationIdentity",
      "workspaceIdentitySchema",
      "deriveWorkspaceIdentity",
      "extensionsSchema",
      "contentFactSchema",
      "createPrivacyService",
      "createProviderRegistry",
      "createEventFactory",
      "createOtelHook",
      "resolveConfig",
      "parseEnvironmentConfig",
      // Custom OTLP resource attributes: typed, bounded, and parseable from
      // the standard environment variable.
      "resourceAttributesSchema",
      "parseResourceAttributesValue",
      "checkResourceAttributeKey",
      "sanitizeResourceAttributes",
      "describeResourceAttributeNames",
      "RESERVED_RESOURCE_ATTRIBUTE_KEYS",
      "MAX_RESOURCE_ATTRIBUTES",
      "ERROR_TAXONOMY",
      "createErrorInfo",
      "OtelHookError",
      "createDeterministicIdGenerator",
      "createInMemoryStateStore",
      "createRecordingTelemetrySink",
      "SILENT_HOOK_RESPONSE",
      "VERSION",
      // Provider adapters and the default registry factory.
      "createClaudeCodeAdapter",
      "createCursorAdapter",
      "createCodexAdapter",
      "createGeminiCliAdapter",
      "createAntigravityAdapter",
      "createDefaultProviderRegistry",
      "describeProviderCatalog",
      "PROVIDER_DESCRIPTORS",
      // Lifecycle, state, telemetry, diagnostics, and the integration runtime.
      "createCallbackDeduplicator",
      "createSpanCorrelator",
      "createUsageAccumulator",
      "createLifecycleJanitor",
      "createFilesystemStateStore",
      "createFileDurableSpool",
      "createOtlpTraceSink",
      "canonicalEventsToReadableSpans",
      // Cross-process span correlation: the pure classifiers a host needs to
      // write its own resolver, plus the record version its state carries.
      "spanScopeRefOf",
      "parentScopeRefOf",
      "startOnlySpanAttributes",
      "MAX_RECOVERED_START_ATTRIBUTES",
      "SPAN_RECORD_VERSION",
      "createHealthTracker",
      "summarizeHealth",
      "createHookRuntime",
      "planProviderRegistration",
    ]) {
      expect(library, name).toHaveProperty(name);
    }
  });

  it("keeps the model and provider entry points importable on their own", () => {
    expect(model.CANONICAL_SCHEMA_VERSION).toBe(1);
    expect(providers.BUILT_IN_PROVIDERS).toEqual([]);
    expect(typeof testing.createTestHook).toBe("function");
  });

  it("keeps resource attributes typed exporter policy, distinct from consumer attributes", () => {
    // Two separate contracts with no shared name: one describes the emitting
    // deployment (configuration), the other one invocation (identity).
    expect(typeof config.resourceAttributesSchema.parse).toBe("function");
    expect(library.DEFAULT_CONFIG.exporter.resourceAttributes).toEqual({});
    expect(library.otelHookConfigPatchSchema.safeParse({
      exporter: { consumerAttributes: { tenant: "acme" } },
    }).success).toBe(false);
    expect(
      library.invocationIdentitySchema.unwrap().shape.consumerAttributes,
    ).not.toBe(config.resourceAttributesSchema);
    expect(Object.keys(library.exporterPolicySchema.shape)).not.toContain("consumerAttributes");
  });

  it("exposes every curated subpath with its own entry point", () => {
    expect(typeof lifecycle.createLifecycleJanitor).toBe("function");
    expect(typeof state.createFilesystemStateStore).toBe("function");
    expect(typeof telemetry.createOtlpTraceSink).toBe("function");
    expect(typeof diagnostics.summarizeHealth).toBe("function");
    expect(typeof integration.createHookRuntime).toBe("function");
    expect(typeof install.planProviderRegistration).toBe("function");
  });

  it("registers all five providers, keeping the experimental one visibly labelled", () => {
    const catalog = providers.describeProviderCatalog();
    expect(catalog.map((entry) => entry.id)).toEqual([
      "antigravity",
      "claude-code",
      "codex",
      "cursor",
      "gemini-cli",
    ]);
    expect(
      catalog.filter((entry) => entry.maturity === "experimental").map((entry) => entry.id),
    ).toEqual(["antigravity"]);
  });

  it("keeps unstable internals out of the curated subpaths", () => {
    // On-disk key derivation and span re-assembly are how the layers are built,
    // not contracts a host may pin: publishing them would freeze the state
    // layout and give hosts a way around the canonical-event boundary.
    for (const name of ["keyDigest", "sanitizeSegment", "namespaceSegments", "createAsyncLock"]) {
      expect(state, name).not.toHaveProperty(name);
      expect(library, name).not.toHaveProperty(name);
    }
    for (const name of ["spanKey", "dedupKey", "rollupUsageKey", "LIFECYCLE_PREFIX"]) {
      expect(lifecycle, name).not.toHaveProperty(name);
      expect(library, name).not.toHaveProperty(name);
    }
    expect(telemetry).not.toHaveProperty("assembleReadableSpan");
    expect(library).not.toHaveProperty("assembleReadableSpan");
  });

  it("keeps the correlation contract usable without the state layout", () => {
    // A host can classify its own events and build a resolver...
    const event = model.parseCanonicalEvent({
      schemaVersion: model.CANONICAL_SCHEMA_VERSION,
      eventId: "e1",
      invocationId: "inv_1",
      sessionId: "ses_1",
      sequence: 0,
      occurredAt: 1_000,
      provenance: testing.createTestProvenance(),
      workspace: model.unknownWorkspaceIdentity(),
      extensions: {},
      type: "tool.start",
      toolCallId: "call_1",
      toolName: "read_file",
      toolKind: "read",
      generationId: "gen_1",
    });
    expect(telemetry.spanScopeRefOf(event)).toEqual({ family: "tool", scopeKey: "call_1" });
    expect(telemetry.parentScopeRefOf(event)).toEqual({ family: "generation", scopeKey: "gen_1" });
    expect(telemetry.startOnlySpanAttributes(event)).toMatchObject({
      "otelhook.tool.kind": "read",
    });

    // ...without being handed the on-disk key space that carries it.
    expect(lifecycle).not.toHaveProperty("spanKey");
    expect(library).not.toHaveProperty("spanKey");
  });

  it("exposes no mutable module-level identity, session, tracer, or workspace", () => {
    const suspicious = /^(current|active|global|shared|default)?(identity|session|tracer|workspace|invocation)/i;
    const offenders = Object.entries(library).filter(([name, value]) => {
      if (!suspicious.test(name)) {
        return false;
      }
      // Schemas, patterns, and frozen tables are fine; a live mutable value is not.
      return (
        typeof value === "object" &&
        value !== null &&
        !("parse" in value) &&
        !(value instanceof RegExp) &&
        !Object.isFrozen(value)
      );
    });
    expect(offenders.map(([name]) => name)).toEqual([]);
  });

  it("freezes the shared constant tables it does export", () => {
    expect(Object.isFrozen(library.ERROR_TAXONOMY)).toBe(true);
    expect(Object.isFrozen(library.DEFAULT_CONFIG)).toBe(true);
    expect(Object.isFrozen(library.DEFAULT_PRIVACY_POLICY)).toBe(true);
    expect(Object.isFrozen(library.DETECTION_CONFIDENCE_RANK)).toBe(true);
    expect(Object.isFrozen(library.EMPTY_DELTA_USAGE)).toBe(true);
    expect(Object.isFrozen(library.SILENT_HOOK_RESPONSE)).toBe(true);
    expect(Object.isFrozen(library.RESERVED_RESOURCE_ATTRIBUTE_KEYS)).toBe(true);
    expect(Object.isFrozen(library.EMPTY_RESOURCE_ATTRIBUTES)).toBe(true);
  });

  it("describes every error code with a severity and a failure posture", () => {
    for (const [code, descriptor] of Object.entries(library.ERROR_TAXONOMY)) {
      expect(descriptor.code, code).toBe(code);
      expect(["warning", "error"]).toContain(descriptor.severity);
      expect(["fail-open", "fail-closed-attribution"]).toContain(descriptor.posture);
      expect(descriptor.summary.length).toBeGreaterThan(0);
    }
  });

  it("never puts a thrown message into an error info", () => {
    const info = library.errorInfoFromThrown(new TypeError("secret prompt text in message"), {
      phase: "parsing",
    });
    expect(info.code).toBe("internal-error");
    expect(JSON.stringify(info)).not.toContain("secret prompt text");
    expect(info.details?.["error.name"]).toBe("TypeError");
    expect(info.details?.["error.has_message"]).toBe(true);
  });

  it("preserves a typed OtelHookError through the containment helper", () => {
    const original = library.OtelHookError.of({ code: "usage-invalid", phase: "normalization" });
    expect(library.errorInfoFromThrown(original, { phase: "export" })).toEqual(original.info);
    expect(library.isOtelHookError(original)).toBe(true);
    expect(library.isOtelHookError(new Error("plain"))).toBe(false);
  });
});
