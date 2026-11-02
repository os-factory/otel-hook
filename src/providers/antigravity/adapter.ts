import { createErrorInfo } from "../../errors/index.js";
import { identityClaimSchema, unknownWorkspaceIdentity, type IdentityClaim } from "../../model/identity.js";
import { providerIdSchema, sessionIdSchema, type ProviderId } from "../../model/primitives.js";
import { deriveWorkspaceIdentity } from "../../privacy/workspace.js";
import {
  providerDetectionSchema,
  unknownDetection,
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
} from "../adapter.js";
import { createEventFactory } from "../builder.js";
import { ANTIGRAVITY_DELIVERY_GAPS, antigravityDeliveryIdentity } from "./delivery.js";
import {
  classifyAntigravityPayload,
  type AntigravityClassification,
} from "./payload.js";

export const ANTIGRAVITY_PROVIDER_ID = "antigravity" as const;

/**
 * What stdin can actually support.
 *
 * `SessionStart` is the one documented session boundary, and it is disjoint
 * from every other event. `tool.end` is emitted only for `PostToolUse` once
 * `error` is present — the field `PreToolUse` does not have. Generation,
 * session end, subagent lifecycle, and `tool.start` are absent on purpose;
 * see `./maturity.ts`.
 */
export const ANTIGRAVITY_CAPABILITIES: ProviderCapabilities = Object.freeze({
  lifecycleEvents: Object.freeze(["session.start", "tool.end"] as const),
  usageTemporality: "delta",
  reportsCachedInput: false,
  reportsCacheCreation: false,
  cacheCreationAccounting: "not-reported",
  reportsReasoningOutput: false,
  reportsProviderTotal: false,
  reportsCost: false,
  emitsSubagentEvents: false,
  emitsCompactionEvents: false,
  // PreToolUse requires a decision, PostToolUse returns `{}`, and Stop
  // requires a decision that is not `continue`. Silence would be a malformed
  // response on a host that fail-closes.
  requiresHookResponse: true,
  deliveryIdentifier: "partial",
});

export type AntigravityAdapterOptions = {
  readonly id?: string;
  readonly version?: string;
};

const ALLOW_DECISION = '{"decision":"allow"}';
const EMPTY_OBJECT = "{}";

const protocolResponse = (stdout: string): ProviderHookResponse => ({
  exitCode: 0,
  contract: "provider-protocol",
  stdout,
});

const sourceEventNameOf = (
  classification: Extract<AntigravityClassification, { status: "exact" }>,
): string | undefined =>
  "sourceEventName" in classification ? classification.sourceEventName : undefined;

/**
 * Antigravity adapter, still experimental.
 *
 * Maps the published camelCase hooks onto canonical events only where the
 * stdin shape belongs to one event. `modelName` is copied onto `session.start`
 * when the payload has it. Usage, a session end, a generation, and a subagent
 * lifecycle are not inferred. See `./maturity.ts`.
 */
export const createAntigravityAdapter = (
  options: AntigravityAdapterOptions = {},
): ProviderAdapter => {
  const id: ProviderId = providerIdSchema.parse(options.id ?? ANTIGRAVITY_PROVIDER_ID);
  const version = options.version ?? "0.1.0";

  const detect = (input: ProviderDetectionInput): ProviderDetection => {
    const classified = classifyAntigravityPayload(input.payload);
    if (classified.status === "none") {
      return unknownDetection(["payload does not match any documented antigravity hook shape"]);
    }
    if (classified.status === "weak") {
      return providerDetectionSchema.parse({
        providerId: id,
        confidence: "weak",
        reasons: [
          classified.family === "tool"
            ? "payload has an antigravity conversationId but its tool fields are incomplete"
            : "payload has an antigravity conversationId but does not match a documented hook input",
        ],
      });
    }
    const sourceEventName = sourceEventNameOf(classified);
    const unlabeledTool =
      classified.kind === "tool-ambiguous" ||
      (classified.kind === "tool-absent" && sourceEventName === undefined);
    return providerDetectionSchema.parse({
      providerId: id,
      confidence: "exact",
      reasons: [
        unlabeledTool
          ? "payload matches the antigravity tool envelope but stdin does not name PreToolUse or PostToolUse"
          : classified.kind === "invocation-ambiguous"
            ? "payload matches the antigravity invocation envelope but stdin does not name the edge"
            : `payload matches the documented antigravity ${sourceEventName ?? "input"}`,
      ],
      ...(sourceEventName === undefined ? {} : { sourceEventName }),
    });
  };

  const identify = (input: ProviderIdentityInput, context: ProviderContext): readonly IdentityClaim[] => {
    const classified = classifyAntigravityPayload(input.payload);
    if (classified.status !== "exact") {
      return [];
    }
    const payload = classified.payload;
    const sessionId = sessionIdSchema.parse(payload.conversationId);
    const discriminator =
      classified.kind === "session-start"
        ? "session"
        : classified.kind === "invocation-ambiguous"
          ? `invocation:${String(classified.payload.invocationNum)}`
          : classified.kind === "stop"
            ? `execution:${String(classified.payload.executionNum)}`
            : `step:${String(classified.payload.stepIdx)}`;
    // occurredAt is pinned: the seed is a hash namespace, not a claimed
    // timestamp. Antigravity documents no timestamp field.
    const invocationId = context.ids.newInvocationId({
      providerId: id,
      sessionId,
      occurredAt: 0,
      discriminator,
    });
    const [firstWorkspacePath] = payload.workspacePaths;
    const workspace =
      firstWorkspacePath === undefined
        ? unknownWorkspaceIdentity()
        : deriveWorkspaceIdentity(context.privacy, {
            kind: "working-directory",
            absolutePath: firstWorkspacePath,
          });

    return [
      identityClaimSchema.parse({
        source: `adapter:${id}`,
        confidence: input.detection.confidence,
        fields: { sessionId, invocationId, workspace },
      }),
    ];
  };

  const parse = (input: ProviderParseInput, context: ProviderContext): ProviderParseResult => {
    const classified = classifyAntigravityPayload(input.payload);
    if (classified.status !== "exact") {
      return {
        status: "failed",
        error: createErrorInfo({
          code: "invalid-input",
          phase: "parsing",
          detail: "payload does not match the documented antigravity hook contract",
        }),
      };
    }
    const factory = createEventFactory({
      identity: input.identity,
      sequenceBase: input.sequenceBase,
      context,
    });

    switch (classified.kind) {
      case "session-start": {
        const modelName = classified.payload.modelName;
        factory.build({
          type: "session.start",
          sessionKind: "unknown",
          ...(modelName === undefined ? {} : { model: { modelId: modelName } }),
        });
        break;
      }
      case "tool-after": {
        const tool = classified.payload;
        const outcome = tool.error === undefined || tool.error.length === 0 ? "ok" : "error";
        factory.build({
          type: "tool.end",
          toolCallId: context.ids.newOpaqueId([tool.conversationId, "step", String(tool.stepIdx)]),
          toolName: tool.toolCall.name,
          outcome,
        });
        break;
      }
      case "tool-ambiguous":
        return {
          status: "ignored",
          reason:
            "tool payload has toolCall and stepIdx but no error key, so it is equally PreToolUse or a PostToolUse " +
            "that omitted error; tool.start and tool.end are not emitted, and hookEventName is not consulted",
        };
      case "tool-absent":
        return {
          status: "ignored",
          reason:
            "tool step reported toolCall null, so there is no tool name to record; a subagent or tool lifecycle is not invented",
        };
      case "invocation-ambiguous":
        return {
          status: "ignored",
          reason:
            "PreInvocation and PostInvocation share invocationNum, initialNumSteps, and modelName, and stdin does not " +
            "say which edge arrived, so no generation.start or generation.end is emitted",
        };
      case "stop":
        return {
          status: "ignored",
          reason: classified.payload.fullyIdle
            ? "Stop reports execution-loop termination with fullyIdle true; that is not a documented session end or " +
              "generation end, and neither event is invented"
            : "Stop reports execution-loop termination while the agent is not fully idle; the conversation continues " +
              "and the hook is not a session or generation boundary",
        };
    }

    return { status: "parsed", events: factory.events() };
  };

  // Antigravity fail-closes a PreToolUse that returns an unknown decision.
  // `allow` delegates to the next hook. Stop treats anything but `continue`
  // as permission to stop, so `allow` never forces another loop. A confirmed
  // PostToolUse or SessionStart answers `{}`.
  const hookResponse = (input: ProviderHookResponseInput): ProviderHookResponse => {
    const event = input.detection?.sourceEventName;
    if (event === "PostToolUse" || event === "SessionStart") {
      return protocolResponse(EMPTY_OBJECT);
    }
    if (event === "Stop" || event === "PreToolUse") {
      return protocolResponse(ALLOW_DECISION);
    }
    const unlabeledTool =
      input.detection?.reasons.some(
        (reason) => reason.includes("tool envelope") || reason.includes("tool fields"),
      ) === true;
    return protocolResponse(unlabeledTool ? ALLOW_DECISION : EMPTY_OBJECT);
  };

  return {
    id,
    version,
    capabilities: ANTIGRAVITY_CAPABILITIES,
    detect,
    identify,
    deliveryIdentity: antigravityDeliveryIdentity,
    deliveryGaps: ANTIGRAVITY_DELIVERY_GAPS,
    parse,
    hookResponse,
  };
};
