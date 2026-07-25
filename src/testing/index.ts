import {
  DEFAULT_CONFIG,
  otelHookConfigSchema,
  type OtelHookConfig,
  type OtelHookConfigPatch,
} from "../config/schema.js";
import type { CanonicalEvent } from "../model/events.js";
import {
  invocationIdentitySchema,
  sourceProvenanceSchema,
  unknownWorkspaceIdentity,
  type InvocationIdentity,
  type SourceProvenance,
} from "../model/identity.js";
import { createPrivacyService, type PrivacyService } from "../privacy/service.js";
import { createProviderRegistry, type ProviderAdapter, type ProviderRegistry } from "../providers/index.js";
import { createFixedClock, type FixedClock } from "../runtime/clock.js";
import { createOtelHook, type OtelHook } from "../runtime/hook.js";
import { createDeterministicIdGenerator } from "../runtime/ids.js";
import {
  createInMemoryStateStore,
  createRecordingLogger,
  createRecordingTelemetrySink,
  type InMemoryStateStore,
  type RecordingLogger,
  type RecordingTelemetrySink,
} from "../runtime/memory.js";
import type { IdGenerator } from "../runtime/ports.js";

export * from "./fixture-adapter.js";
export * from "./assertions.js";
export {
  createFixedClock,
  createInMemoryStateStore,
  createRecordingLogger,
  createRecordingTelemetrySink,
  createDeterministicIdGenerator,
};
export type { FixedClock, InMemoryStateStore, RecordingLogger, RecordingTelemetrySink };

/** Deterministic provenance for hand-built events. */
export const createTestProvenance = (
  overrides: Partial<SourceProvenance> = {},
): SourceProvenance =>
  sourceProvenanceSchema.parse({
    providerId: "fixture",
    adapterId: "fixture",
    adapterVersion: "1.0.0",
    detectionConfidence: "exact",
    transport: "test-fixture",
    ...overrides,
  });

/** Deterministic identity for hand-built events. */
export const createTestIdentity = (
  overrides: Partial<InvocationIdentity> = {},
): InvocationIdentity =>
  invocationIdentitySchema.parse({
    invocationId: "inv_test_0000000000000001",
    sessionId: "ses_test_0000000000000001",
    provenance: createTestProvenance(),
    workspace: unknownWorkspaceIdentity(),
    startedAt: 1_700_000_000_000,
    consumerAttributes: {},
    ...overrides,
  });

export const createTestPrivacyService = (
  patch: Partial<OtelHookConfig["privacy"]> = {},
): PrivacyService => createPrivacyService({ ...DEFAULT_CONFIG.privacy, ...patch });

export type TestHarnessOptions = {
  readonly adapters?: readonly ProviderAdapter[];
  readonly registry?: ProviderRegistry;
  /** Shallow-merged over {@link DEFAULT_CONFIG}, then validated. */
  readonly config?: OtelHookConfigPatch;
  readonly clock?: FixedClock;
  readonly ids?: IdGenerator;
  readonly startMillis?: number;
  readonly tickMillis?: number;
};

export type TestHarness = {
  readonly hook: OtelHook;
  readonly sink: RecordingTelemetrySink;
  readonly stateStore: InMemoryStateStore;
  readonly clock: FixedClock;
  readonly ids: IdGenerator;
  readonly privacy: PrivacyService;
  readonly logger: RecordingLogger;
  readonly registry: ProviderRegistry;
  readonly config: OtelHookConfig;
};

const mergeConfig = (patch: OtelHookConfigPatch | undefined): OtelHookConfig => {
  if (patch === undefined) {
    return DEFAULT_CONFIG;
  }
  return otelHookConfigSchema.parse({
    exporter: { ...DEFAULT_CONFIG.exporter, ...patch.exporter },
    privacy: {
      ...DEFAULT_CONFIG.privacy,
      ...patch.privacy,
      limits: { ...DEFAULT_CONFIG.privacy.limits, ...patch.privacy?.limits },
    },
    detection: { ...DEFAULT_CONFIG.detection, ...patch.detection },
    diagnostics: { ...DEFAULT_CONFIG.diagnostics, ...patch.diagnostics },
  });
};

/**
 * Fully wired hook backed by in-memory doubles and a deterministic clock.
 *
 * Nothing here reads the process environment, the filesystem, or the wall clock,
 * so a provider test is reproducible on any machine.
 */
export const createTestHook = (options: TestHarnessOptions = {}): TestHarness => {
  const config = mergeConfig(options.config);
  const clock =
    options.clock ??
    createFixedClock({
      startMillis: options.startMillis ?? 1_700_000_000_000,
      tickMillis: options.tickMillis ?? 0,
    });
  const ids = options.ids ?? createDeterministicIdGenerator({ namespace: "test" });
  const privacy = createPrivacyService(config.privacy);
  const logger = createRecordingLogger("debug");
  const sink = createRecordingTelemetrySink();
  const stateStore = createInMemoryStateStore({ clock });
  const registry = options.registry ?? createProviderRegistry(options.adapters ?? []);

  const hook = createOtelHook({
    sink,
    stateStore,
    config,
    registry,
    clock,
    ids,
    privacy,
    logger,
  });

  return { hook, sink, stateStore, clock, ids, privacy, logger, registry, config };
};

/** Convenience re-export so provider suites can type their own helpers. */
export type { CanonicalEvent };
