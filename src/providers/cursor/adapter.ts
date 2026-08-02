import { createErrorInfo } from "../../errors/index.js";
import type { EventOutcome, ModelDescriptor } from "../../model/events.js";
import { identityClaimSchema, type IdentityClaim } from "../../model/identity.js";
import { deriveWorkspaceIdentity } from "../../privacy/workspace.js";
import {
  asProviderId,
  providerDetectionSchema,
  SILENT_HOOK_RESPONSE,
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
import { CURSOR_DELIVERY_GAPS, cursorDeliveryIdentity } from "./delivery.js";
import {
  CURSOR_DECISION_EVENTS,
  CURSOR_PROVIDER_ID,
  cursorSessionId,
  recognizeCursorPayload,
  type CursorPayload,
} from "./payload.js";
import { normalizeCursorUsage } from "./usage.js";

/**
 * Provider adapter for Cursor's agent hooks.
 *
 * `./payload.ts` carries the full provenance note: the contract is derived from
 * Cursor's published hooks reference plus four real redacted capture runs, and
 * this module maps only what those establish. Three lifecycle decisions follow
 * from that evidence rather than from convenience, and each is stated where it
 * is made below:
 *
 * - `generation.end` comes from `stop`, not `afterAgentResponse`.
 * - The shell and MCP tool ends report outcome `unknown`, because Cursor sends
 *   no exit status on those callbacks.
 * - Both subagent callbacks are ignored, because `subagentStop` carries no
 *   subagent identifier to pair with `subagentStart`.
 */

export const CURSOR_CAPABILITIES: ProviderCapabilities = Object.freeze({
  lifecycleEvents: Object.freeze([
    "session.start",
    "session.end",
    "prompt.submitted",
    "generation.start",
    "generation.end",
    "tool.start",
    "tool.end",
    "compaction.performed",
  ] as const),
  usageTemporality: "delta",
  // Cursor's `cache_read_tokens` is read as a subset of `input_tokens`; see
  // `./usage.ts` for the captured evidence and the guard when a payload
  // contradicts it.
  reportsCachedInput: true,
  // `cache_write_tokens` is reported by Cursor but its accounting is
  // undocumented, so it is surfaced as an extension rather than folded into a
  // canonical total. See `./usage.ts`.
  reportsCacheCreation: false,
  cacheCreationAccounting: "not-reported",
  reportsReasoningOutput: false,
  reportsProviderTotal: false,
  reportsCost: false,
  // `subagentStop` carries no subagent id, so no pairable subagent lifecycle can
  // be produced. See the `ignored` branch below.
  emitsSubagentEvents: false,
  emitsCompactionEvents: true,
  requiresHookResponse: true,
  // Tool and generation callbacks carry a replay-stable id; the dedicated
  // shell/MCP/file callbacks and `preCompact` do not. See `./delivery.ts`.
  deliveryIdentifier: "partial",
});

/** Sentinel used when a payload names no model at all. */
const UNKNOWN_MODEL: ModelDescriptor = Object.freeze({ modelId: "unknown" });

/**
 * Cursor reports a model *variant* in `model` and its base in `model_id` — the
 * captures show `model: "composer-2.5-fast"` beside `model_id: "composer-2.5"`.
 * The variant is the identifier of what ran, so it becomes `modelId`; the base
 * becomes `family`, and is dropped when it merely repeats the variant. Vendor is
 * never guessed: Cursor names no vendor anywhere in the payload.
 */
const toModelDescriptor = (payload: CursorPayload): ModelDescriptor => {
  const modelId = payload.model;
  if (modelId === undefined || modelId.length === 0) {
    return UNKNOWN_MODEL;
  }
  const family = payload.model_id;
  return {
    modelId,
    ...(family === undefined || family.length === 0 || family === modelId ? {} : { family }),
  };
};

const SESSION_END_REASONS: Readonly<
  Record<string, "completed" | "aborted" | "error" | "timeout" | "unknown">
> = Object.freeze({
  completed: "completed",
  aborted: "aborted",
  error: "error",
  // Both documented "the window/user closed it" reasons are an abort from the
  // agent's point of view: work stopped without finishing.
  window_close: "aborted",
  user_close: "aborted",
});

/** `stop.status` and `subagentStop.status` share this vocabulary. */
const STOP_STATUS_TO_OUTCOME: Readonly<Record<string, EventOutcome>> = Object.freeze({
  completed: "ok",
  aborted: "cancelled",
  error: "error",
});

const COMPACT_TRIGGERS: Readonly<Record<string, "automatic" | "manual">> = Object.freeze({
  auto: "automatic",
  manual: "manual",
});

/**
 * Derive privacy-safe workspace identity from the payload's own directory facts.
 *
 * `workspace_roots` first, `cwd` only as a fallback — and never a process cwd:
 * an absent or empty list simply contributes no workspace claim, letting the
 * core's `unknown` fallback apply. The CLI captures report `cwd: ""`, which is
 * treated as absent rather than as the filesystem root.
 */
const deriveWorkspace = (
  context: ProviderContext,
  payload: CursorPayload,
): ReturnType<typeof deriveWorkspaceIdentity> | undefined => {
  const roots = (payload.workspace_roots ?? []).filter((root) => root.length > 0);
  if (roots.length === 1) {
    return deriveWorkspaceIdentity(context.privacy, {
      kind: "working-directory",
      absolutePath: roots[0] ?? "",
    });
  }
  if (roots.length > 1) {
    return deriveWorkspaceIdentity(context.privacy, {
      kind: "explicit",
      value: [...roots].sort().join("\n"),
    });
  }
  if (payload.cwd !== undefined && payload.cwd.length > 0) {
    return deriveWorkspaceIdentity(context.privacy, {
      kind: "working-directory",
      absolutePath: payload.cwd,
    });
  }
  return undefined;
};

/**
 * Stable per-call uniqueness fed into the invocation id hash. Every value comes
 * from the payload itself, never from process state, so replaying a payload
 * reproduces the same id.
 */
const invocationDiscriminator = (payload: CursorPayload): string | undefined => {
  switch (payload.hook_event_name) {
    case "sessionStart":
    case "sessionEnd":
      return undefined;
    case "preToolUse":
    case "postToolUse":
    case "postToolUseFailure":
      return payload.tool_use_id ?? payload.tool_name;
    case "beforeShellExecution":
    case "afterShellExecution":
      return payload.generation_id;
    case "beforeMCPExecution":
    case "afterMCPExecution":
      return payload.tool_name;
    case "beforeReadFile":
    case "afterFileEdit":
      return payload.generation_id;
    case "subagentStart":
      return payload.subagent_id;
    case "subagentStop":
      return payload.subagent_type;
    case "preCompact":
      return payload.trigger;
    default:
      return payload.generation_id;
  }
};

/**
 * A tool call id for a callback that carries none.
 *
 * `beforeShellExecution`/`afterShellExecution` and the MCP pair report no
 * `tool_use_id`, so the pair is joined on the fields that *are* stable across
 * it: the generation and the command (or server-qualified tool name). Both
 * halves of a pair derive the same id from the same payload facts, which is what
 * lets the span correlator match them — and none of it is a clock or process
 * read, so a replay derives the same id again.
 */
const derivedToolCallId = (
  context: ProviderContext,
  sessionId: string,
  parts: readonly string[],
): string => context.ids.newOpaqueId([sessionId, ...parts]);

/** The validated payload, or `undefined` for anything this adapter cannot map. */
const asModelled = (payload: unknown): CursorPayload | undefined => {
  const recognized = recognizeCursorPayload(payload);
  return recognized?.status === "modelled" ? recognized.payload : undefined;
};

/** Longest detection reason the contract accepts. */
const MAX_DETECTION_REASON_LENGTH = 160;

const bounded = (reason: string): string =>
  reason.length <= MAX_DETECTION_REASON_LENGTH
    ? reason
    : `${reason.slice(0, MAX_DETECTION_REASON_LENGTH - 1)}…`;

export type CursorAdapterOptions = {
  readonly version?: string;
};

export const CURSOR_ADAPTER_VERSION = "2.0.0";

export const createCursorAdapter = (options: CursorAdapterOptions = {}): ProviderAdapter => {
  const id = asProviderId(CURSOR_PROVIDER_ID);
  const version = options.version ?? CURSOR_ADAPTER_VERSION;
  const capabilities = CURSOR_CAPABILITIES;

  const detect = (input: ProviderDetectionInput): ProviderDetection => {
    const recognized = recognizeCursorPayload(input.payload);
    if (recognized === undefined) {
      return unknownDetection(["payload does not match the cursor hook contract"]);
    }
    // Detection reasons are bounded at 160 characters, and both branches below
    // interpolate a provider-supplied string, so each is trimmed to fit rather
    // than thrown away by the schema.
    if (recognized.status === "unmodelled") {
      return unknownDetection([
        bounded(`cursor documents "${recognized.eventName}" but this adapter does not model it`),
      ]);
    }
    if (recognized.status === "invalid") {
      return unknownDetection([
        bounded(
          `cursor "${recognized.eventName}" payload does not satisfy its contract: ${recognized.detail}`,
        ),
      ]);
    }
    const { payload } = recognized;
    return providerDetectionSchema.parse({
      providerId: id,
      confidence: "exact",
      reasons: [`payload.hook_event_name "${payload.hook_event_name}" recognized`],
      ...(payload.cursor_version === undefined || payload.cursor_version.length === 0
        ? {}
        : { providerVersion: payload.cursor_version }),
      sourceEventName: payload.hook_event_name,
    });
  };

  const identify = (
    input: ProviderIdentityInput,
    context: ProviderContext,
  ): readonly IdentityClaim[] => {
    const payload = asModelled(input.payload);
    if (payload === undefined) {
      return [];
    }
    const workspace = deriveWorkspace(context, payload);
    const discriminator = invocationDiscriminator(payload);
    // Cursor's own conversation id, used exactly as reported: never
    // normalized, parent/child matched, or substituted for a derived value.
    // `session_id` repeats it in every capture, and is the fallback
    // `recognizeCursorPayload` guarantees is present when `conversation_id`
    // is not — see `cursorSessionId`.
    const sessionId = cursorSessionId(payload);
    if (sessionId === undefined) {
      return [];
    }
    // Cursor sends no timestamp on any hook — see `./payload.ts`. The clock is
    // the only available reading, as it is for Claude Code.
    const occurredAt = context.clock.now();
    const invocationId = context.ids.newInvocationId({
      providerId: id,
      sessionId,
      sourceEventName: payload.hook_event_name,
      occurredAt,
      ...(discriminator === undefined ? {} : { discriminator }),
    });
    const claim = identityClaimSchema.parse({
      source: `adapter:${id}`,
      confidence: input.detection.confidence,
      fields: {
        sessionId,
        invocationId,
        startedAt: occurredAt,
        ...(workspace === undefined ? {} : { workspace }),
      },
    });
    return [claim];
  };

  const parse = (input: ProviderParseInput, context: ProviderContext): ProviderParseResult => {
    const recognized = recognizeCursorPayload(input.payload);
    if (recognized === undefined) {
      return {
        status: "failed",
        error: createErrorInfo({
          code: "invalid-input",
          phase: "parsing",
          detail: "payload does not match the cursor hook contract",
        }),
      };
    }
    if (recognized.status === "unmodelled") {
      return {
        status: "ignored",
        reason: `cursor "${recognized.eventName}" is not modelled: ${recognized.reason}`,
      };
    }
    if (recognized.status === "invalid") {
      return {
        status: "failed",
        error: createErrorInfo({
          code: "invalid-input",
          phase: "parsing",
          detail: `cursor "${recognized.eventName}" payload is malformed (${recognized.detail})`,
        }),
      };
    }

    const { payload } = recognized;

    if (payload.hook_event_name === "afterAgentResponse") {
      return {
        status: "ignored",
        reason:
          "the generation's terminal outcome is reported from stop, which carries a status field and the " +
          "identical token snapshot (captured: 43859/1076/28384/0 on both callbacks of one generation); " +
          "emitting generation.end from both would double-count usage, and this adapter holds no " +
          "cross-invocation state to deduplicate them",
      };
    }

    if (payload.hook_event_name === "afterAgentThought") {
      return {
        status: "ignored",
        reason:
          "afterAgentThought is a reasoning notification, not a generation lifecycle event; no canonical " +
          "event type represents it and thought text is never exported",
      };
    }

    if (payload.hook_event_name === "beforeReadFile") {
      return {
        status: "ignored",
        reason:
          "beforeReadFile has no completion callback in the cursor hook protocol, so emitting tool.start " +
          "here would leave a tool lifecycle that never closes",
      };
    }

    if (payload.hook_event_name === "subagentStart" || payload.hook_event_name === "subagentStop") {
      return {
        status: "ignored",
        reason:
          "cursor's subagentStop payload carries no subagent identifier — the reference gives subagent_id to " +
          "subagentStart only — so the two callbacks cannot be paired; emitting subagent.start alone would " +
          "leave a delegation that never closes, and minting an id for the end would produce an unpairable one",
      };
    }

    const factory = createEventFactory({
      identity: input.identity,
      sequenceBase: input.sequenceBase,
      context,
    });
    const warnings: string[] = [];
    const sessionId = input.identity.sessionId;
    const model = toModelDescriptor(payload);

    switch (payload.hook_event_name) {
      case "sessionStart":
        factory.build({
          type: "session.start",
          // A background agent runs unattended; an interactive session is the
          // only other state Cursor reports here.
          sessionKind:
            payload.is_background_agent === undefined
              ? "unknown"
              : payload.is_background_agent
                ? "non-interactive"
                : "interactive",
          agentName: "cursor",
          ...(payload.cursor_version === undefined || payload.cursor_version.length === 0
            ? {}
            : { agentVersion: payload.cursor_version }),
          ...(model === UNKNOWN_MODEL ? {} : { model }),
          ...(payload.composer_mode === undefined
            ? {}
            : { extensions: { "cursor.composer_mode": payload.composer_mode } }),
        });
        break;

      case "sessionEnd":
        factory.build({
          type: "session.end",
          reason:
            payload.reason === undefined ? "unknown" : (SESSION_END_REASONS[payload.reason] ?? "unknown"),
          ...(payload.duration_ms === undefined ? {} : { durationMillis: payload.duration_ms }),
          ...(payload.final_status === undefined
            ? {}
            : { extensions: { "cursor.final_status": payload.final_status } }),
        });
        break;

      case "beforeSubmitPrompt": {
        factory.build({
          type: "prompt.submitted",
          // Cursor reports no prompt provenance. `user` would be a guess: this
          // hook also fires for an automation-driven or resumed turn.
          promptSource: "unknown",
          ...(payload.prompt === undefined
            ? {}
            : {
                content: context.privacy.describeContent({
                  kind: "prompt",
                  role: "user",
                  text: payload.prompt,
                }),
              }),
          ...(payload.attachments === undefined
            ? {}
            : { extensions: { "cursor.attachment_count": payload.attachments.length } }),
        });
        // `generation_id` is present on every captured agent payload, but the
        // reference does not mark it required, so an absent one degrades to a
        // prompt with no generation rather than to a fabricated id.
        if (payload.generation_id !== undefined && payload.generation_id.length > 0) {
          factory.build({
            type: "generation.start",
            generationId: payload.generation_id,
            model,
          });
        } else {
          warnings.push(
            "beforeSubmitPrompt carried no generation_id, so no generation.start was emitted",
          );
        }
        break;
      }

      case "preToolUse":
        factory.build({
          type: "tool.start",
          toolCallId:
            payload.tool_use_id ??
            derivedToolCallId(context, sessionId, [
              "tool",
              payload.generation_id ?? "",
              payload.tool_name,
            ]),
          toolName: payload.tool_name,
          // Cursor names its tools but does not classify them, and the names are
          // not a closed set. `unknown` says so; `other` would claim a lookup
          // happened and found nothing.
          toolKind: "unknown",
          ...(payload.generation_id === undefined || payload.generation_id.length === 0
            ? {}
            : { generationId: payload.generation_id }),
          ...(payload.tool_input === undefined
            ? {}
            : {
                input: context.privacy.describeStructured({
                  kind: "tool-input",
                  value: payload.tool_input,
                  label: payload.tool_name,
                }),
              }),
        });
        break;

      case "postToolUse":
        factory.build({
          type: "tool.end",
          toolCallId:
            payload.tool_use_id ??
            derivedToolCallId(context, sessionId, [
              "tool",
              payload.generation_id ?? "",
              payload.tool_name,
            ]),
          toolName: payload.tool_name,
          // Cursor routes failures to the separate postToolUseFailure callback,
          // so reaching this one *is* the success signal.
          outcome: "ok",
          ...(payload.duration === undefined ? {} : { durationMillis: payload.duration }),
          ...(payload.tool_output === undefined
            ? {}
            : {
                output: context.privacy.describeStructured({
                  kind: "tool-output",
                  value: payload.tool_output,
                  label: payload.tool_name,
                }),
              }),
        });
        break;

      case "postToolUseFailure":
        factory.build({
          type: "tool.end",
          toolCallId:
            payload.tool_use_id ??
            derivedToolCallId(context, sessionId, [
              "tool",
              payload.generation_id ?? "",
              payload.tool_name,
            ]),
          toolName: payload.tool_name,
          outcome:
            payload.failure_type === "timeout"
              ? "timeout"
              : payload.failure_type === "permission_denied"
                ? "denied"
                : payload.is_interrupt === true
                  ? "cancelled"
                  : "error",
          ...(payload.failure_type === "permission_denied"
            ? { permissionDecision: "denied" as const }
            : {}),
          ...(payload.duration === undefined ? {} : { durationMillis: payload.duration }),
          ...(payload.error_message === undefined
            ? {}
            : {
                output: context.privacy.describeContent({
                  kind: "error-message",
                  text: payload.error_message,
                }),
              }),
        });
        break;

      case "beforeShellExecution":
        factory.build({
          type: "tool.start",
          toolCallId: derivedToolCallId(context, sessionId, [
            "shell",
            payload.generation_id ?? "",
            payload.command,
          ]),
          toolName: "shell",
          toolKind: "execute",
          ...(payload.generation_id === undefined || payload.generation_id.length === 0
            ? {}
            : { generationId: payload.generation_id }),
          input: context.privacy.describeContent({
            kind: "tool-input",
            text: payload.command,
            label: "shell",
          }),
          ...(payload.sandbox === undefined ? {} : { extensions: { "cursor.sandbox": payload.sandbox } }),
        });
        break;

      case "afterShellExecution":
        factory.build({
          type: "tool.end",
          toolCallId: derivedToolCallId(context, sessionId, [
            "shell",
            payload.generation_id ?? "",
            payload.command,
          ]),
          toolName: "shell",
          // No exit code and no status field on this callback, in the reference
          // or in the captures. Reporting `ok` would assert a success Cursor
          // never claimed.
          outcome: "unknown",
          ...(payload.duration === undefined ? {} : { durationMillis: payload.duration }),
          ...(payload.output === undefined
            ? {}
            : {
                output: context.privacy.describeContent({
                  kind: "tool-output",
                  text: payload.output,
                  label: "shell",
                }),
              }),
          ...(payload.sandbox === undefined ? {} : { extensions: { "cursor.sandbox": payload.sandbox } }),
        });
        break;

      case "beforeMCPExecution":
        factory.build({
          type: "tool.start",
          toolCallId: derivedToolCallId(context, sessionId, [
            "mcp",
            payload.generation_id ?? "",
            payload.tool_name,
          ]),
          toolName: payload.tool_name,
          toolKind: "network",
          ...(payload.generation_id === undefined || payload.generation_id.length === 0
            ? {}
            : { generationId: payload.generation_id }),
          ...(payload.tool_input === undefined
            ? {}
            : {
                input: context.privacy.describeStructured({
                  kind: "tool-input",
                  value: payload.tool_input,
                  label: payload.tool_name,
                }),
              }),
        });
        break;

      case "afterMCPExecution":
        factory.build({
          type: "tool.end",
          toolCallId: derivedToolCallId(context, sessionId, [
            "mcp",
            payload.generation_id ?? "",
            payload.tool_name,
          ]),
          toolName: payload.tool_name,
          // As with the shell pair: `result_json` is opaque and there is no
          // status field to read an outcome from.
          outcome: "unknown",
          ...(payload.duration === undefined ? {} : { durationMillis: payload.duration }),
          ...(payload.result_json === undefined
            ? {}
            : {
                output: context.privacy.describeContent({
                  kind: "tool-output",
                  text: payload.result_json,
                  label: payload.tool_name,
                }),
              }),
        });
        break;

      case "afterFileEdit": {
        const toolCallId = derivedToolCallId(context, sessionId, [
          "file-edit",
          payload.generation_id ?? "",
          payload.file_path,
        ]);
        // Cursor exposes no "before edit" callback, so the pair is emitted from
        // this one firing: an edit that reached this hook has completed.
        factory.build({
          type: "tool.start",
          toolCallId,
          toolName: "edit_file",
          toolKind: "write",
          ...(payload.generation_id === undefined || payload.generation_id.length === 0
            ? {}
            : { generationId: payload.generation_id }),
          input: context.privacy.describeContent({
            kind: "tool-input",
            text: payload.file_path,
            label: "edit_file",
          }),
        });
        factory.build({
          type: "tool.end",
          toolCallId,
          toolName: "edit_file",
          outcome: "ok",
          // `edits[].old_string`/`new_string` are file content and are never
          // exported, in described form or otherwise. Only how many edits landed.
          ...(payload.edits === undefined
            ? {}
            : { extensions: { "cursor.edit_count": payload.edits.length } }),
        });
        break;
      }

      case "preCompact":
        factory.build({
          type: "compaction.performed",
          trigger:
            payload.trigger === undefined ? "unknown" : (COMPACT_TRIGGERS[payload.trigger] ?? "unknown"),
          // Cursor exposes no post-compaction callback, so `contextTokensAfter`
          // is structurally unavailable and is never estimated.
          ...(payload.context_tokens === undefined
            ? {}
            : { contextTokensBefore: payload.context_tokens }),
          ...(payload.messages_to_compact === undefined
            ? {}
            : { droppedMessageCount: payload.messages_to_compact }),
          extensions: {
            ...(payload.context_window_size === undefined
              ? {}
              : { "cursor.context_window_size": payload.context_window_size }),
            ...(payload.message_count === undefined
              ? {}
              : { "cursor.message_count": payload.message_count }),
            ...(payload.is_first_compaction === undefined
              ? {}
              : { "cursor.is_first_compaction": payload.is_first_compaction }),
          },
        });
        break;

      case "stop": {
        const usage = normalizeCursorUsage(payload);
        warnings.push(...usage.warnings);
        const generationId = payload.generation_id;
        if (generationId === undefined || generationId.length === 0) {
          return {
            status: "ignored",
            reason:
              "stop carried no generation_id, so the generation it ends cannot be named; " +
              "generation.end requires one and this adapter will not mint it",
          };
        }
        factory.build({
          type: "generation.end",
          generationId,
          model,
          outcome:
            payload.status === undefined ? "unknown" : (STOP_STATUS_TO_OUTCOME[payload.status] ?? "unknown"),
          ...(payload.status === undefined ? {} : { stopReason: payload.status }),
          ...(usage.usage === undefined ? {} : { usage: usage.usage }),
          ...(payload.loop_count === undefined
            ? {}
            : { extensions: { "cursor.loop_count": payload.loop_count } }),
        });
        break;
      }

      // Every remaining event name returned early above.
    }

    return {
      status: "parsed",
      events: factory.events(),
      ...(warnings.length === 0 ? {} : { warnings }),
    };
  };

  /**
   * Answer the decision callbacks in their own vocabulary.
   *
   * Cursor reads a JSON object from stdout for six events, keyed `permission`
   * for five of them and `continue` for `beforeSubmitPrompt`. Writing nothing
   * would rely on Cursor's default; writing the wrong key would be silently
   * ignored, which is the same thing while looking deliberate. So the answer is
   * always "proceed", spelled the way each event spells it. Never `"ask"` — a
   * telemetry hook must not open a prompt — and never `"deny"`: ADR 0004 forbids
   * this hook from being able to block the host agent, and the response type
   * pins `exitCode` to 0 for the same reason.
   */
  const hookResponse = (input: ProviderHookResponseInput): ProviderHookResponse => {
    const sourceEventName = input.detection?.sourceEventName;
    const decisionKey =
      sourceEventName === undefined ? undefined : CURSOR_DECISION_EVENTS[sourceEventName];
    if (decisionKey === undefined) {
      return SILENT_HOOK_RESPONSE;
    }
    return {
      exitCode: 0,
      contract: "provider-protocol",
      stdout: JSON.stringify(
        decisionKey === "continue" ? { continue: true } : { permission: "allow" },
      ),
    };
  };

  return {
    id,
    version,
    capabilities,
    detect,
    identify,
    deliveryIdentity: cursorDeliveryIdentity,
    deliveryGaps: CURSOR_DELIVERY_GAPS,
    parse,
    hookResponse,
  };
};
