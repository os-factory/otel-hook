import * as path from "node:path";

import type { DetectionPolicy } from "../config/schema.js";
import type { OtelHookErrorInfo } from "../errors/index.js";
import { createHookRuntime, type HookProcessOutcome } from "../integration/hook-runtime.js";
import { createPrivacyService } from "../privacy/service.js";
import type { ProviderAdapter, ProviderContext, ProviderDetectionInput } from "../providers/adapter.js";
import {
  createDefaultProviderRegistry,
  findProviderDescriptor,
  PROVIDER_DESCRIPTORS,
} from "../providers/defaults.js";
import { createProviderRegistry, type ProviderRegistry } from "../providers/registry.js";
import { createSystemClock } from "../runtime/clock.js";
import { createDeterministicIdGenerator } from "../runtime/ids.js";
import type { Logger } from "../runtime/ports.js";
import type { CliRunCommand } from "./args.js";
import {
  createCliLogger,
  readIdentityFile,
  resolveCliConfig,
  resolveInstallationId,
  resolveStateRootDir,
  type CliIo,
} from "./context.js";
import { autoDetectProvider } from "./detection.js";
import { providerVisibleEnvironment } from "./environment-view.js";
import { claimFromIdentityFile, claimFromIdentityFlags } from "./identity.js";
import { readBoundedJson } from "./stdin.js";

const MAX_LOGGED_DIAGNOSTICS = 16;

const logDiagnostics = (logger: Logger, diagnostics: readonly OtelHookErrorInfo[]): void => {
  for (const info of diagnostics.slice(0, MAX_LOGGED_DIAGNOSTICS)) {
    const fields = {
      "error.code": info.code,
      "error.phase": info.phase,
      "error.posture": info.posture,
      ...(info.details ?? {}),
    };
    if (info.severity === "error") {
      logger.error(info.message, fields);
    } else {
      logger.warn(info.message, fields);
    }
  }
  if (diagnostics.length > MAX_LOGGED_DIAGNOSTICS) {
    logger.warn("additional diagnostics were not logged", {
      "diagnostics.total": diagnostics.length,
      "diagnostics.logged": MAX_LOGGED_DIAGNOSTICS,
    });
  }
};

const logNotes = (logger: Logger, notes: readonly string[]): void => {
  for (const note of notes) {
    logger.warn(note, {});
  }
};

type ProviderSelection =
  | {
      readonly status: "selected";
      /** Single-adapter registry: the choice is made here, once, and visibly. */
      readonly registry: ProviderRegistry;
      readonly detectionPolicy: DetectionPolicy;
      /**
       * Present only when the *caller* named the provider. Auto-detection never
       * sets it, so a detected provider's provenance keeps the adapter's own
       * confidence instead of being promoted to `exact` by our own guess.
       */
      readonly providerHint?: string;
      /** Namespace for state and spool directories. Never an identity. */
      readonly namespace: string;
    }
  | { readonly status: "rejected"; readonly reason: string };

/**
 * Resolve `--provider <id>` to a single-adapter registry.
 *
 * The caller's assertion is the strongest signal available: it is the only path
 * that reaches `exact` confidence for a payload with no self-identifying
 * provider field, and it makes ambiguity structurally impossible. The minimum
 * confidence is lowered to `weak` for the same reason — once the caller has named
 * the provider, a payload that only weakly matches that provider's schema is
 * still that provider's payload, and the shape problem surfaces from `parse` as a
 * diagnostic instead of as a silent non-attribution.
 */
const selectExplicitProvider = (
  providerId: string,
  detectionPolicy: DetectionPolicy,
  logger: Logger,
): ProviderSelection => {
  const descriptor = findProviderDescriptor(providerId);
  if (descriptor === undefined) {
    return {
      status: "rejected",
      reason: `unknown provider "${providerId}"; registered providers are ${PROVIDER_DESCRIPTORS.map(
        (entry) => entry.id,
      ).join(", ")}`,
    };
  }
  if (descriptor.maturity === "experimental") {
    logger.warn("selected provider adapter is experimental", {
      "provider.id": descriptor.id,
      "provider.maturity": descriptor.maturity,
      "provider.promotion_gates": descriptor.promotionGates.length,
    });
  }
  return {
    status: "selected",
    registry: createProviderRegistry([descriptor.createAdapter()]),
    detectionPolicy: {
      ...detectionPolicy,
      minimumConfidence: "weak",
      allowAmbiguousFallback: false,
      allowedProviderIds: [descriptor.id],
    },
    providerHint: descriptor.id,
    namespace: descriptor.id,
  };
};

const selectDetectedProvider = (
  adapter: ProviderAdapter,
  detectionPolicy: DetectionPolicy,
): ProviderSelection => ({
  status: "selected",
  registry: createProviderRegistry([adapter]),
  detectionPolicy: { ...detectionPolicy, allowedProviderIds: [adapter.id] },
  namespace: adapter.id,
});

/**
 * Process one hook payload.
 *
 * Always resolves to exit code 0. A telemetry hook that can fail its host will
 * be uninstalled, so every failure mode here — unreadable stdin, malformed JSON,
 * an unknown provider, an ambiguous detection, conflicting identity, an
 * unreachable collector, an unwritable state directory — becomes a stderr
 * diagnostic and an exit code of 0 (ADR 0004).
 */
export const runHookCommand = async (command: CliRunCommand, io: CliIo): Promise<number> => {
  const resolved = await resolveCliConfig(command.policy, io);
  const logger = createCliLogger(io, resolved.config.diagnostics.logLevel);
  logDiagnostics(logger, resolved.warnings);
  for (const note of resolved.notes) {
    logger.info(note, {});
  }
  if (resolved.usedDefaults) {
    logger.warn("configuration could not be resolved; falling back to defaults", {});
  }

  const decoded = await readBoundedJson(io.stdin, command.maxInputBytes);
  if (decoded.status === "error") {
    logger.warn(decoded.detail, {
      "input.code": decoded.code,
      ...(decoded.byteLength === undefined ? {} : { "input.byte_length": decoded.byteLength }),
    });
    return 0;
  }

  const privacy = createPrivacyService(resolved.config.privacy);
  logNotes(logger, privacy.policyNotes);
  const clock = createSystemClock();
  const ids = createDeterministicIdGenerator();
  const environment = providerVisibleEnvironment(io.env, privacy);
  const providerContext: ProviderContext = {
    privacy,
    clock,
    ids,
    logger,
    limits: privacy.policy.limits,
  };

  let selection: ProviderSelection;
  if (command.providerId !== undefined) {
    selection = selectExplicitProvider(command.providerId, resolved.config.detection, logger);
  } else {
    const detectionInput: ProviderDetectionInput = {
      payload: decoded.value,
      transport: command.transport,
      environment,
    };
    const detected = autoDetectProvider(
      createDefaultProviderRegistry({
        includeExperimental: command.policy.includeExperimental ?? true,
      }),
      detectionInput,
      providerContext,
      resolved.config.detection,
    );
    if (detected.status === "resolved") {
      logger.info("provider auto-detected", {
        "provider.id": detected.adapter.id,
        "detection.confidence": detected.confidence,
      });
      selection = selectDetectedProvider(detected.adapter, resolved.config.detection);
    } else if (detected.status === "ambiguous") {
      selection = {
        status: "rejected",
        reason:
          `auto-detection refused: ${String(detected.candidates.length)} adapters recognize this payload ` +
          `(${detected.candidates.map((candidate) => `${candidate.providerId}:${candidate.confidence}`).join(", ")}). ` +
          "Pass --provider <id> to state which one it is; nothing is attributed by guessing.",
      };
    } else {
      selection = {
        status: "rejected",
        reason: `auto-detection refused: no registered adapter recognized this payload (${detected.reasons
          .join("; ")
          .slice(0, 240)}). Pass --provider <id> if you know which provider sent it.`,
      };
    }
  }

  if (selection.status === "rejected") {
    // No provider means no known stdout contract, so the response is silence —
    // the same posture as SILENT_HOOK_RESPONSE (ADR 0004).
    logger.error(selection.reason, {});
    return 0;
  }

  const identityClaims = [];
  if (command.identity.identityFile !== undefined) {
    const read = await readIdentityFile(path.resolve(command.identity.identityFile));
    if ("error" in read) {
      logDiagnostics(logger, [read.error]);
    } else {
      const fromFile = claimFromIdentityFile(
        read.value,
        path.basename(command.identity.identityFile),
      );
      logDiagnostics(logger, fromFile.errors);
      identityClaims.push(...fromFile.claims);
    }
  }
  const fromFlags = claimFromIdentityFlags(command.identity);
  logDiagnostics(logger, fromFlags.errors);
  identityClaims.push(...fromFlags.claims);

  const runtime = createHookRuntime({
    // Detection policy narrowed to the selected adapter; everything else is the
    // resolved configuration exactly as it stands.
    config: { ...resolved.config, detection: selection.detectionPolicy },
    registry: selection.registry,
    stateRootDir: resolveStateRootDir(command.policy, io),
    installationId: resolveInstallationId(command.policy, io),
    providerNamespace: selection.namespace,
    ...(Object.keys(command.policy.headers).length === 0
      ? {}
      : { headers: command.policy.headers }),
    clock,
    ids,
    logger,
    privacy,
    ...(command.policy.flushTimeoutMillis === undefined
      ? {}
      : { flushTimeoutMillis: command.policy.flushTimeoutMillis }),
    ...(command.policy.spoolDisabled === true ? { enableSpool: false } : {}),
    ...(command.requireCallbackId === true ? { requireCallbackId: true } : {}),
    ...(command.noDeriveCallbackId === true ? { deriveDeliveryIdentity: false } : {}),
  });

  let outcome: HookProcessOutcome | undefined;
  try {
    outcome = await runtime.process({
      payload: decoded.value,
      transport: command.transport,
      environment,
      ...(selection.providerHint === undefined ? {} : { providerHint: selection.providerHint }),
      ...(identityClaims.length === 0 ? {} : { identityClaims }),
      ...(Object.keys(command.consumerAttributes).length === 0
        ? {}
        : { consumerAttributes: command.consumerAttributes }),
      ...(command.callbackId === undefined
        ? {}
        : {
            delivery: {
              callbackId: command.callbackId,
              ...(command.callbackScope === undefined ? {} : { scope: command.callbackScope }),
            },
          }),
    });
  } catch (thrown) {
    // `process` is contractually non-throwing; this is the belt to its braces.
    logger.error("hook processing contained an unexpected failure", {
      "error.name": thrown instanceof Error ? thrown.name : typeof thrown,
    });
  }

  if (outcome !== undefined) {
    const { hookResponse } = outcome.ingest;
    if (hookResponse.stderr !== undefined) {
      io.stderr.write(hookResponse.stderr);
    }
    // The only write to stdout in the whole run path, and only when the
    // provider's own protocol asks for one (ADR 0004).
    if (hookResponse.stdout !== undefined) {
      io.stdout.write(hookResponse.stdout);
    }
    logDiagnostics(logger, [...outcome.ingest.diagnostics, ...outcome.diagnostics]);
    logger.info("hook processed", {
      "provider.id": outcome.ingest.providerId,
      "attribution.outcome": outcome.ingest.attribution,
      ...(outcome.ingest.attributionReason === undefined
        ? {}
        : { "attribution.reason": outcome.ingest.attributionReason }),
      "events.emitted": outcome.ingest.emitted,
      "events.dropped": outcome.ingest.dropped,
      "delivery.duplicate": outcome.duplicateDelivery,
      "delivery.deduplicated": outcome.delivery.deduplicated,
      ...(outcome.delivery.origin === undefined
        ? {}
        : { "delivery.origin": outcome.delivery.origin }),
      ...(outcome.delivery.outcome === undefined
        ? {}
        : { "delivery.outcome": outcome.delivery.outcome }),
      ...(outcome.delivery.reason === undefined
        ? {}
        : { "delivery.unavailable_reason": outcome.delivery.reason }),
      "usage.rollups": outcome.usageRollups.length,
      "hook_response.contract": hookResponse.contract,
    });
  }

  const shutdown = await runtime.shutdown();
  if (!shutdown.flushCompleted) {
    logger.warn("telemetry flush did not complete within its bound", {
      "shutdown.flush_timeout_millis": shutdown.flushTimeoutMillis,
    });
  }
  return 0;
};
