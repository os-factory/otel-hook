import { identityClaimSchema, type IdentityClaim } from "../../model/identity.js";
import { invocationIdSchema, sessionIdSchema, type InvocationId } from "../../model/primitives.js";
import { deriveWorkspaceIdentity } from "../../privacy/workspace.js";
import type { ProviderContext, ProviderIdentityInput } from "../adapter.js";
import { CLAUDE_CODE_PROVIDER_ID } from "./detect.js";
import { claudeIdentityFieldsSchema } from "./schema.js";

/**
 * Deterministic, cross-invocation-stable id for a subagent.
 *
 * Derived from only `sessionId` and `agentId` (never a timestamp), so any
 * hook firing that carries the same `agent_id` — the subagent's own
 * `SubagentStart`/`SubagentStop`, or a tool call made from inside it —
 * recomputes the identical id and can link back to it, without the adapter
 * ever persisting state between invocations.
 */
export const subagentInvocationIdFor = (
  context: ProviderContext,
  sessionId: string,
  agentId: string,
): InvocationId =>
  invocationIdSchema.parse(`subagent_${context.ids.newOpaqueId(["claude-subagent", sessionId, agentId])}`);

/**
 * Contribute identity claims for one Claude Code hook invocation.
 *
 * `sessionId` is Claude Code's own `session_id`, stable for the life of the
 * session. `invocationId` identifies this single hook firing and is
 * intentionally allowed to differ between firings in the same session —
 * continuity across firings is carried by `sessionId`, sequence numbers, and
 * (for subagents) `parentInvocationId`, not by a stable `invocationId`.
 */
export const identifyClaudeCode = (
  input: ProviderIdentityInput,
  context: ProviderContext,
): readonly IdentityClaim[] => {
  const parsed = claudeIdentityFieldsSchema.safeParse(input.payload);
  if (!parsed.success) {
    return [];
  }
  const fields = parsed.data;
  const sessionId = sessionIdSchema.parse(fields.session_id);
  const occurredAt = context.clock.now();
  const discriminator = fields.tool_use_id ?? fields.prompt_id ?? fields.agent_id;

  const invocationId = context.ids.newInvocationId({
    providerId: CLAUDE_CODE_PROVIDER_ID,
    sessionId,
    sourceEventName: fields.hook_event_name,
    occurredAt,
    ...(discriminator === undefined ? {} : { discriminator }),
  });

  const isSubagentLifecycleEvent =
    fields.hook_event_name === "SubagentStart" || fields.hook_event_name === "SubagentStop";
  const parentInvocationId =
    fields.agent_id !== undefined && !isSubagentLifecycleEvent
      ? subagentInvocationIdFor(context, sessionId, fields.agent_id)
      : undefined;

  const claim = identityClaimSchema.parse({
    source: `adapter:${CLAUDE_CODE_PROVIDER_ID}`,
    confidence: input.detection.confidence,
    fields: {
      sessionId,
      invocationId,
      startedAt: occurredAt,
      ...(fields.cwd === undefined
        ? {}
        : { workspace: deriveWorkspaceIdentity(context.privacy, { kind: "working-directory", absolutePath: fields.cwd }) }),
      ...(parentInvocationId === undefined ? {} : { parentInvocationId }),
      ...(fields.agent_id === undefined ? {} : { agentInstanceId: fields.agent_id }),
    },
  });

  return [claim];
};
