import { z } from "zod";

import { createErrorInfo } from "../errors/index.js";
import { identityClaimSchema, type IdentityClaim } from "../model/identity.js";
import { providerIdSchema, sessionIdSchema, type ProviderId } from "../model/primitives.js";
import { normalizeUsage, usageReportSchema } from "../model/usage.js";
import { deriveWorkspaceIdentity } from "../privacy/workspace.js";
import {
  providerDetectionSchema,
  SILENT_HOOK_RESPONSE,
  type ProviderAdapter,
  type ProviderCapabilities,
  type ProviderContext,
  type ProviderDetection,
  type ProviderDetectionInput,
  type ProviderHookResponse,
  type ProviderHookResponseInput,
  type ProviderIdentityInput,
  type ProviderParseInput,
  type ProviderParseResult,
} from "../providers/adapter.js";
import { createEventFactory } from "../providers/builder.js";

/**
 * Synthetic hook payload used by the reference adapter.
 *
 * Provenance: invented for this repository. It resembles no real provider's
 * protocol and contains no captured transcript, path, or credential.
 */
export const syntheticPayloadSchema = z.object({
  provider: z.string().min(1),
  sessionId: z.string().min(1),
  event: z.enum([
    "session.start",
    "prompt",
    "generation",
    "tool",
    "subagent",
    "compaction",
    "session.end",
    "noop",
  ]),
  requestId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  promptText: z.string().optional(),
  toolName: z.string().min(1).optional(),
  toolInput: z.unknown().optional(),
  workspaceKey: z.string().min(1).optional(),
  occurredAt: z.number().int().min(0).optional(),
  usage: usageReportSchema.optional(),
  agentVersion: z.string().min(1).optional(),
});
export type SyntheticPayload = z.infer<typeof syntheticPayloadSchema>;

export const SYNTHETIC_PROVIDER_ID = "fixture" as const;

export const DEFAULT_FIXTURE_CAPABILITIES: ProviderCapabilities = Object.freeze({
  lifecycleEvents: Object.freeze([
    "session.start",
    "session.end",
    "prompt.submitted",
    "generation.start",
    "generation.end",
    "tool.start",
    "tool.end",
    "subagent.start",
    "subagent.end",
    "compaction.performed",
  ] as const),
  usageTemporality: "delta",
  reportsCachedInput: true,
  reportsCacheCreation: true,
  cacheCreationAccounting: "disjoint-from-input",
  reportsReasoningOutput: true,
  reportsProviderTotal: true,
  reportsCost: false,
  emitsSubagentEvents: true,
  emitsCompactionEvents: true,
  requiresHookResponse: false,
});

export type FixtureAdapterOptions = {
  readonly id?: string;
  readonly version?: string;
  readonly capabilities?: Partial<ProviderCapabilities>;
  /** Confidence reported when the payload matches this adapter's provider id. */
  readonly confidence?: ProviderDetection["confidence"];
  /** Replace detection entirely, e.g. to simulate an ambiguous registry. */
  readonly detect?: (input: ProviderDetectionInput, context: ProviderContext) => ProviderDetection;
  /** Extra claims merged after the adapter's own, e.g. to force a conflict. */
  readonly extraClaims?: readonly IdentityClaim[];
  /** Throw from the named method, to exercise containment. */
  readonly throwOn?: "detect" | "identify" | "parse" | "hookResponse";
  /** Emit a provider-protocol stdout response instead of staying silent. */
  readonly hookResponse?: (
    input: ProviderHookResponseInput,
    context: ProviderContext,
  ) => ProviderHookResponse;
};

/**
 * Reference adapter over the synthetic payload above.
 *
 * Provider agents can use it to exercise the core contract — registry
 * arbitration, identity resolution, privacy screening, usage derivation — without
 * depending on any real provider protocol.
 */
export const createFixtureAdapter = (options: FixtureAdapterOptions = {}): ProviderAdapter => {
  const id: ProviderId = providerIdSchema.parse(options.id ?? SYNTHETIC_PROVIDER_ID);
  const version = options.version ?? "1.0.0";
  const capabilities: ProviderCapabilities = {
    ...DEFAULT_FIXTURE_CAPABILITIES,
    ...options.capabilities,
  };
  const confidence = options.confidence ?? "exact";

  const detect = (input: ProviderDetectionInput, context: ProviderContext): ProviderDetection => {
    if (options.throwOn === "detect") {
      throw new Error("fixture adapter detect failure");
    }
    if (options.detect !== undefined) {
      return options.detect(input, context);
    }
    const parsed = syntheticPayloadSchema.safeParse(input.payload);
    if (!parsed.success || parsed.data.provider !== id) {
      return providerDetectionSchema.parse({
        providerId: "unknown",
        confidence: "none",
        reasons: ["payload does not match the synthetic fixture protocol"],
      });
    }
    return providerDetectionSchema.parse({
      providerId: id,
      confidence,
      reasons: ["payload.provider matches the fixture provider id"],
      providerVersion: parsed.data.agentVersion ?? "0.1.0",
      sourceEventName: parsed.data.event,
    });
  };

  const identify = (
    input: ProviderIdentityInput,
    context: ProviderContext,
  ): readonly IdentityClaim[] => {
    if (options.throwOn === "identify") {
      throw new Error("fixture adapter identify failure");
    }
    const parsed = syntheticPayloadSchema.safeParse(input.payload);
    if (!parsed.success) {
      return options.extraClaims ?? [];
    }
    const payload = parsed.data;
    const occurredAt = payload.occurredAt ?? context.clock.now();
    const sessionId = sessionIdSchema.parse(payload.sessionId);
    const claim = identityClaimSchema.parse({
      source: `adapter:${id}`,
      confidence: input.detection.confidence,
      fields: {
        sessionId,
        invocationId: context.ids.newInvocationId({
          providerId: id,
          sessionId,
          sourceEventName: payload.event,
          occurredAt,
          ...(payload.requestId === undefined ? {} : { discriminator: payload.requestId }),
        }),
        startedAt: occurredAt,
        ...(payload.workspaceKey === undefined
          ? {}
          : {
              workspace: deriveWorkspaceIdentity(context.privacy, {
                kind: "explicit",
                value: payload.workspaceKey,
              }),
            }),
      },
    });
    return [claim, ...(options.extraClaims ?? [])];
  };

  const parse = (input: ProviderParseInput, context: ProviderContext): ProviderParseResult => {
    if (options.throwOn === "parse") {
      throw new Error("fixture adapter parse failure");
    }
    const parsed = syntheticPayloadSchema.safeParse(input.payload);
    if (!parsed.success) {
      return {
        status: "failed",
        error: createErrorInfo({
          code: "invalid-input",
          phase: "parsing",
          detail: "payload does not match the synthetic fixture protocol",
        }),
      };
    }
    const payload = parsed.data;
    if (payload.event === "noop") {
      return { status: "ignored", reason: "synthetic noop event carries no telemetry" };
    }

    const factory = createEventFactory({
      identity: input.identity,
      sequenceBase: input.sequenceBase,
      context,
    });
    const occurredAt = payload.occurredAt ?? context.clock.now();
    const model = { modelId: payload.model ?? "synthetic-model-1" };
    const warnings: string[] = [];

    const usage = ((): ReturnType<typeof normalizeUsage> | undefined => {
      if (payload.usage === undefined) {
        return undefined;
      }
      const normalized = normalizeUsage(payload.usage);
      if (normalized.status === "invalid") {
        warnings.push(...normalized.issues.map((issue) => issue.message));
      }
      return normalized;
    })();
    const canonicalUsage = usage?.status === "ok" ? usage.usage : undefined;

    switch (payload.event) {
      case "session.start":
        factory.build({
          type: "session.start",
          sessionKind: "non-interactive",
          agentName: `fixture-${id}`,
          ...(payload.agentVersion === undefined ? {} : { agentVersion: payload.agentVersion }),
          model,
          occurredAt,
        });
        break;
      case "prompt":
        factory.build({
          type: "prompt.submitted",
          promptSource: "user",
          occurredAt,
          ...(payload.promptText === undefined
            ? {}
            : {
                content: context.privacy.describeContent({
                  kind: "prompt",
                  role: "user",
                  text: payload.promptText,
                }),
              }),
        });
        break;
      case "generation": {
        const generationId = payload.requestId ?? context.ids.newOpaqueId([payload.sessionId, "generation"]);
        factory.build({ type: "generation.start", generationId, model, occurredAt });
        factory.build({
          type: "generation.end",
          generationId,
          model,
          outcome: "ok",
          occurredAt,
          ...(canonicalUsage === undefined ? {} : { usage: canonicalUsage }),
        });
        break;
      }
      case "tool": {
        const toolCallId = payload.requestId ?? context.ids.newOpaqueId([payload.sessionId, "tool"]);
        const toolName = payload.toolName ?? "synthetic-tool";
        factory.build({
          type: "tool.start",
          toolCallId,
          toolName,
          toolKind: "other",
          occurredAt,
          ...(payload.toolInput === undefined
            ? {}
            : {
                input: context.privacy.describeStructured({
                  kind: "tool-input",
                  value: payload.toolInput,
                  label: toolName,
                }),
              }),
        });
        factory.build({
          type: "tool.end",
          toolCallId,
          toolName,
          outcome: "ok",
          occurredAt,
        });
        break;
      }
      case "subagent": {
        const subagentInvocationId = context.ids.newInvocationId({
          providerId: id,
          sessionId: payload.sessionId,
          sourceEventName: "subagent",
          occurredAt,
          ...(payload.requestId === undefined ? {} : { discriminator: payload.requestId }),
        });
        factory.build({
          type: "subagent.start",
          subagentInvocationId,
          delegationDepth: 1,
          occurredAt,
        });
        factory.build({
          type: "subagent.end",
          subagentInvocationId,
          outcome: "ok",
          occurredAt,
          ...(canonicalUsage === undefined ? {} : { usage: canonicalUsage }),
        });
        break;
      }
      case "compaction":
        factory.build({
          type: "compaction.performed",
          trigger: "automatic",
          occurredAt,
          ...(canonicalUsage === undefined ? {} : { usage: canonicalUsage }),
        });
        break;
      case "session.end":
        factory.build({
          type: "session.end",
          reason: "completed",
          occurredAt,
          ...(canonicalUsage === undefined ? {} : { usage: canonicalUsage }),
        });
        break;
    }

    return {
      status: "parsed",
      events: factory.events(),
      ...(warnings.length === 0 ? {} : { warnings }),
    };
  };

  const hookResponse = (
    input: ProviderHookResponseInput,
    context: ProviderContext,
  ): ProviderHookResponse => {
    if (options.throwOn === "hookResponse") {
      throw new Error("fixture adapter hookResponse failure");
    }
    if (options.hookResponse !== undefined) {
      return options.hookResponse(input, context);
    }
    return SILENT_HOOK_RESPONSE;
  };

  return { id, version, capabilities, detect, identify, parse, hookResponse };
};
