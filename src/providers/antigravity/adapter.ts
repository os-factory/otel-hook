import { createErrorInfo } from "../../errors/index.js";
import { identityClaimSchema, unknownWorkspaceIdentity, type IdentityClaim } from "../../model/identity.js";
import { providerIdSchema, sessionIdSchema, type ProviderId } from "../../model/primitives.js";
import { deriveWorkspaceIdentity } from "../../privacy/workspace.js";
import {
  providerDetectionSchema,
  SILENT_HOOK_RESPONSE,
  unknownDetection,
  type ProviderAdapter,
  type ProviderCapabilities,
  type ProviderContext,
  type ProviderDetection,
  type ProviderDetectionInput,
  type ProviderHookResponse,
  type ProviderIdentityInput,
  type ProviderParseInput,
  type ProviderParseResult,
} from "../adapter.js";
import { createEventFactory } from "../builder.js";
import {
  ANTIGRAVITY_SUBAGENT_TOOL_NAME,
  antigravityHookPayloadSchema,
  antigravityWeakShapeSchema,
} from "./payload.js";

export const ANTIGRAVITY_PROVIDER_ID = "antigravity" as const;

/**
 * What this adapter can honestly observe from the five documented command
 * hooks. Token/cache accounting and a stable subagent lifecycle are both
 * undocumented for Antigravity, so both are declared unavailable rather than
 * approximated (see `./maturity.ts`).
 */
export const ANTIGRAVITY_CAPABILITIES: ProviderCapabilities = Object.freeze({
  lifecycleEvents: Object.freeze(["session.start", "session.end", "tool.start", "tool.end"] as const),
  usageTemporality: "delta",
  reportsCachedInput: false,
  reportsCacheCreation: false,
  cacheCreationAccounting: "not-reported",
  reportsReasoningOutput: false,
  reportsProviderTotal: false,
  reportsCost: false,
  emitsSubagentEvents: false,
  emitsCompactionEvents: false,
  requiresHookResponse: false,
});

export type AntigravityAdapterOptions = {
  readonly id?: string;
  readonly version?: string;
};

/**
 * Experimental Google Antigravity adapter.
 *
 * Maps the five documented camelCase command hooks onto canonical events
 * conservatively: fields the hooks do not expose (model identifiers, usage,
 * a genuine session-start signal) are never fabricated. See ADR 0003 for the
 * adapter contract this implements and `./maturity.ts` for what would need to
 * be verified before this leaves `experimental`.
 */
export const createAntigravityAdapter = (
  options: AntigravityAdapterOptions = {},
): ProviderAdapter => {
  const id: ProviderId = providerIdSchema.parse(options.id ?? ANTIGRAVITY_PROVIDER_ID);
  const version = options.version ?? "0.1.0";

  const detect = (input: ProviderDetectionInput): ProviderDetection => {
    const full = antigravityHookPayloadSchema.safeParse(input.payload);
    if (full.success) {
      return providerDetectionSchema.parse({
        providerId: id,
        confidence: "exact",
        reasons: [`payload matches the documented antigravity ${full.data.hookEventName} hook shape`],
        sourceEventName: full.data.hookEventName,
      });
    }
    const weak = antigravityWeakShapeSchema.safeParse(input.payload);
    if (weak.success) {
      return providerDetectionSchema.parse({
        providerId: id,
        confidence: "weak",
        reasons: [
          `payload.hookEventName=${weak.data.hookEventName} matches antigravity but required fields are missing or invalid`,
        ],
        sourceEventName: weak.data.hookEventName,
      });
    }
    return unknownDetection(["payload does not match any documented antigravity hook shape"]);
  };

  const identify = (input: ProviderIdentityInput, context: ProviderContext): readonly IdentityClaim[] => {
    const parsed = antigravityHookPayloadSchema.safeParse(input.payload);
    if (!parsed.success) {
      return [];
    }
    const payload = parsed.data;
    const sessionId = sessionIdSchema.parse(payload.conversationId);
    // occurredAt is pinned to a constant: the seed is a hash namespace, not a
    // claimed timestamp, and invocationNum is what must stay stable across the
    // separate Pre/Post hook processes that share one Antigravity invocation.
    const invocationId = context.ids.newInvocationId({
      providerId: id,
      sessionId,
      occurredAt: 0,
      discriminator: String(payload.invocationNum),
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
    const parsed = antigravityHookPayloadSchema.safeParse(input.payload);
    if (!parsed.success) {
      return {
        status: "failed",
        error: createErrorInfo({
          code: "invalid-input",
          phase: "parsing",
          detail: "payload does not match the documented antigravity hook contract",
        }),
      };
    }
    const payload = parsed.data;
    const factory = createEventFactory({
      identity: input.identity,
      sequenceBase: input.sequenceBase,
      context,
    });

    switch (payload.hookEventName) {
      case "PreInvocation": {
        if (payload.invocationNum !== 0) {
          return {
            status: "ignored",
            reason: "PreInvocation with invocationNum > 0 carries no additional documented lifecycle fact",
          };
        }
        factory.build({
          type: "session.start",
          sessionKind: "unknown",
          ...(payload.agentVersion === undefined ? {} : { agentVersion: payload.agentVersion }),
          extensions: {
            // Marks that this session.start is inferred from the first
            // observed invocation, not a genuine session-start signal from
            // the provider: Antigravity documents no such hook.
            "antigravity.session-start-inferred": true,
          },
        });
        break;
      }
      case "PostInvocation":
        return {
          status: "ignored",
          reason: "PostInvocation carries no documented lifecycle fact beyond invocation bookkeeping",
        };
      case "PreToolUse": {
        const toolCallId = context.ids.newOpaqueId([
          payload.conversationId,
          "step",
          String(payload.stepIdx),
        ]);
        const toolKind = payload.toolName === ANTIGRAVITY_SUBAGENT_TOOL_NAME ? "delegate" : "unknown";
        factory.build({
          type: "tool.start",
          toolCallId,
          toolName: payload.toolName,
          toolKind,
          ...(payload.toolInput === undefined
            ? {}
            : {
                input: context.privacy.describeStructured({
                  kind: "tool-input",
                  value: payload.toolInput,
                  label: payload.toolName,
                }),
              }),
        });
        break;
      }
      case "PostToolUse": {
        const toolCallId = context.ids.newOpaqueId([
          payload.conversationId,
          "step",
          String(payload.stepIdx),
        ]);
        const outcome = payload.isError === true ? "error" : payload.isError === false ? "ok" : "unknown";
        factory.build({
          type: "tool.end",
          toolCallId,
          toolName: payload.toolName,
          outcome,
          ...(payload.toolResponse === undefined
            ? {}
            : {
                output: context.privacy.describeStructured({
                  kind: "tool-output",
                  value: payload.toolResponse,
                  label: payload.toolName,
                }),
              }),
        });
        break;
      }
      case "Stop": {
        if (!payload.fullyIdle) {
          return {
            status: "ignored",
            reason: "Stop received while the agent is not fully idle; the conversation continues",
          };
        }
        factory.build({ type: "session.end", reason: "completed" });
        break;
      }
    }

    return { status: "parsed", events: factory.events() };
  };

  const hookResponse = (): ProviderHookResponse => SILENT_HOOK_RESPONSE;

  return { id, version, capabilities: ANTIGRAVITY_CAPABILITIES, detect, identify, parse, hookResponse };
};
