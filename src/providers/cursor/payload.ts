import { z } from "zod";

/**
 * Cursor agent-hook payload contract.
 *
 * ## Provenance
 *
 * Nothing in this module is invented. Every field, spelling, and unit below is
 * established by one or both of:
 *
 * 1. **Cursor's published hooks reference** — `cursor.com/docs/agent/hooks` and
 *    `cursor.com/docs/hooks.md` (two URLs serving the same reference; both read
 *    2026-07-29). Source of the event-name list, the shared envelope, each
 *    event's input fields, each event's stdout response, the `hooks.json`
 *    schema, exit-code semantics, and the statement that `duration` and
 *    `duration_ms` are milliseconds while `timeout` is seconds.
 * 2. **Real redacted captures** — `colinsurprenant/director`, under
 *    `hack/canary/cursor-cli/findings/`: two Cursor CLI runs (`2026.07.17-3e2a980`,
 *    captured 2026-07-21 and 2026-07-22) and two Cursor IDE runs (`3.12.17`,
 *    captured 2026-07-21), each registering the full agent-hook set and recording
 *    the exact key list of all 54 payload files it saved. Source of the fields
 *    the reference omits, of which keys are actually optional, and of the two
 *    lifecycle facts in "Surface dependence" below.
 *
 * The redacted fixtures under `fixtures/parity/cursor/` restate those captured
 * shapes with synthetic values; their provenance sidecars name this capture set.
 * No real path, email, transcript, prompt, or credential is copied into this
 * repository — see `CLAUDE.md`.
 *
 * ## Envelope
 *
 * Keys are snake_case throughout, and there is exactly one generation of the
 * shape: no camelCase variant and no legacy alias table is documented or
 * observed, so none is modelled. **There is no timestamp field anywhere** — not
 * in the reference, and not in any captured payload's key list — so the adapter
 * reads `occurredAt` from the injected clock, as the Claude Code adapter does.
 *
 * ## Surface dependence (captured, not documented)
 *
 * The same `hooks.json` produces different event subsets on Cursor's two
 * surfaces, which is why the registration planner's default set is chosen the
 * way it is:
 *
 * - `stop` and `afterAgentResponse` fired in the IDE runs and in neither CLI
 *   run; `sessionEnd` fired in both CLI runs and in neither IDE run.
 * - One shell invocation fires **four** hooks. The CLI capture's `fired.log`
 *   records `preToolUse`, `beforeShellExecution`, `afterShellExecution`,
 *   `postToolUse` in that order for a single `printenv` call, with
 *   `afterShellExecution` and `postToolUse` reporting the identical
 *   `duration` of 169.812. Registering both pairs would report one tool call
 *   twice.
 *
 * ## Forward compatibility
 *
 * Event objects are `z.object` (unknown keys stripped), not `z.strictObject`:
 * Cursor adds payload fields between releases — the reference already documents
 * a `preToolUse.agent_message` that no captured payload carries — and a
 * telemetry hook that rejects a payload for gaining a field fails closed on the
 * one thing it should tolerate.
 */

export const CURSOR_PROVIDER_ID = "cursor" as const;

/**
 * Agent-session hook events this adapter interprets, in Cursor's own spelling.
 *
 * The reference groups its hooks as "agent", "tab", and "app lifecycle". Only
 * the agent group is here; see {@link CURSOR_UNMODELLED_HOOK_EVENT_NAMES}.
 */
export const CURSOR_HOOK_EVENT_NAMES = [
  "sessionStart",
  "sessionEnd",
  "beforeSubmitPrompt",
  "afterAgentResponse",
  "afterAgentThought",
  "preToolUse",
  "postToolUse",
  "postToolUseFailure",
  "beforeShellExecution",
  "afterShellExecution",
  "beforeMCPExecution",
  "afterMCPExecution",
  "beforeReadFile",
  "afterFileEdit",
  "subagentStart",
  "subagentStop",
  "preCompact",
  "stop",
] as const;
export type CursorHookEventName = (typeof CURSOR_HOOK_EVENT_NAMES)[number];

/**
 * Event names Cursor documents that this adapter deliberately does not model,
 * each with the reason. Recognized by name so a payload carrying one is
 * reported as "known, unmodelled" rather than as an unrecognized provider.
 */
export const CURSOR_UNMODELLED_HOOK_EVENT_NAMES: Readonly<Record<string, string>> = Object.freeze({
  beforeTabFileRead:
    "a Tab (inline-completion) hook, not an agent-session hook; it belongs to no generation or tool lifecycle this model expresses",
  afterTabFileEdit: "a Tab (inline-completion) hook, as above",
  workspaceOpen:
    "an app-lifecycle hook that the reference states omits conversation_id, generation_id, model, session_id, and transcript_path, so it carries no session to attribute telemetry to",
});

/**
 * Events whose stdout Cursor reads a decision from, and the field it reads.
 *
 * Taken from the reference's per-event "Output" sections. `beforeSubmitPrompt`
 * is the one event keyed `continue` rather than `permission`; the shell and MCP
 * gates additionally accept `"ask"`, which this tool never emits.
 */
export const CURSOR_DECISION_EVENTS: Readonly<Record<string, "permission" | "continue">> =
  Object.freeze({
    preToolUse: "permission",
    beforeShellExecution: "permission",
    beforeMCPExecution: "permission",
    beforeReadFile: "permission",
    subagentStart: "permission",
    beforeSubmitPrompt: "continue",
  });

/** `[{ id, value }]`, per the reference's shared envelope. */
const modelParamSchema = z.object({
  id: z.string(),
  value: z.string(),
});
export type CursorModelParam = z.infer<typeof modelParamSchema>;

const attachmentSchema = z.object({
  type: z.string().optional(),
  file_path: z.string().optional(),
});

/** `{ old_string, new_string }` pairs. Content, never exported — see the adapter. */
const fileEditSchema = z.object({
  old_string: z.string().optional(),
  new_string: z.string().optional(),
});

/**
 * Token counters observed on `afterAgentResponse` and `stop` in the IDE
 * captures. Absent from the published reference, which is why they are all
 * optional and why {@link CURSOR_USAGE_INCLUSIVITY_NOTE} states the one reading
 * the captures do not settle.
 */
const usageFields = {
  input_tokens: z.number().int().min(0).optional(),
  output_tokens: z.number().int().min(0).optional(),
  cache_read_tokens: z.number().int().min(0).optional(),
  cache_write_tokens: z.number().int().min(0).optional(),
};

export const CURSOR_USAGE_INCLUSIVITY_NOTE =
  "Cursor does not document its token counters, so whether input_tokens already includes cache_read_tokens " +
  "cannot be settled from the reference. Every captured sample has cache_read_tokens strictly below " +
  "input_tokens (28384/43859, 7040/21033, 77920/94622) with a stable ~15-17k remainder as the cached prefix " +
  "grows, which is what an inclusive counter looks like; the adapter therefore reads input_tokens as the " +
  "canonical inclusive total and cache_read_tokens as a subset of it. Where a payload contradicts that " +
  "reading, the adapter drops the breakdown rather than reporting a total it cannot justify.";

/**
 * Fields the reference lists as present on every agent hook.
 *
 * `conversation_id` is the session identity every captured agent payload
 * carries, and `session_id` repeats it in every capture — see
 * {@link cursorSessionId} for why the schema no longer hard-requires the
 * former by itself. `cwd` is *not* `.min(1)` — the CLI captures report
 * `"cwd": ""` for a workspace-rooted call, and rejecting an empty string would
 * drop the whole event over a field the adapter never reads for identity.
 *
 * `user_email` and `transcript_path` are declared so they parse rather than
 * being silently stripped, and are then never read by any code path. They are a
 * real address and a real filesystem path; `tests/providers/cursor` asserts
 * neither reaches a sink.
 */
const envelopeShape = {
  // Not `.min(1)`: see `cursorSessionId`. A payload naming neither
  // `conversation_id` nor `session_id` is still rejected — by
  // `recognizeCursorPayload`'s post-parse check — but rejecting it here would
  // fail the whole discriminated union on a field the adapter can source from
  // either name.
  conversation_id: z.string().optional(),
  generation_id: z.string().optional(),
  session_id: z.string().optional(),
  model: z.string().optional(),
  model_id: z.string().optional(),
  model_params: z.array(modelParamSchema).max(64).optional(),
  cursor_version: z.string().optional(),
  workspace_roots: z.array(z.string()).max(64).optional(),
  cwd: z.string().optional(),
  /** Never propagated. */
  user_email: z.string().nullish(),
  /** Never propagated. */
  transcript_path: z.string().nullish(),
};

const event = <TName extends CursorHookEventName, TShape extends z.ZodRawShape>(
  name: TName,
  shape: TShape,
) => z.object({ ...envelopeShape, hook_event_name: z.literal(name), ...shape });

const sessionStartPayloadSchema = event("sessionStart", {
  is_background_agent: z.boolean().optional(),
  composer_mode: z.string().optional(),
});

/**
 * `reason` and `final_status` are free strings rather than enums on purpose.
 * The reference lists five reasons (`completed`, `aborted`, `error`,
 * `window_close`, `user_close`) and the adapter maps exactly those; a sixth
 * Cursor adds later must degrade to `unknown`, not reject the event.
 */
const sessionEndPayloadSchema = event("sessionEnd", {
  reason: z.string().optional(),
  duration_ms: z.number().min(0).optional(),
  is_background_agent: z.boolean().optional(),
  final_status: z.string().optional(),
  error_message: z.string().optional(),
});

const beforeSubmitPromptPayloadSchema = event("beforeSubmitPrompt", {
  prompt: z.string().optional(),
  attachments: z.array(attachmentSchema).max(256).optional(),
  composer_mode: z.string().optional(),
});

const afterAgentResponsePayloadSchema = event("afterAgentResponse", {
  text: z.string().optional(),
  ...usageFields,
});

const afterAgentThoughtPayloadSchema = event("afterAgentThought", {
  text: z.string().optional(),
  duration_ms: z.number().min(0).optional(),
});

const preToolUsePayloadSchema = event("preToolUse", {
  tool_name: z.string().min(1),
  tool_input: z.unknown().optional(),
  tool_use_id: z.string().optional(),
  agent_message: z.string().optional(),
});

/**
 * `tool_output` is `z.unknown()` because both shapes occur: the CLI capture
 * reports an object (`{ output, exitCode }`), the IDE capture a JSON-encoded
 * string, and the reference documents the string. Neither is parsed for meaning.
 */
const postToolUsePayloadSchema = event("postToolUse", {
  tool_name: z.string().min(1),
  tool_input: z.unknown().optional(),
  tool_output: z.unknown().optional(),
  tool_use_id: z.string().optional(),
  duration: z.number().min(0).optional(),
});

const postToolUseFailurePayloadSchema = event("postToolUseFailure", {
  tool_name: z.string().min(1),
  tool_input: z.unknown().optional(),
  tool_use_id: z.string().optional(),
  error_message: z.string().optional(),
  failure_type: z.string().optional(),
  duration: z.number().min(0).optional(),
  is_interrupt: z.boolean().optional(),
});

const beforeShellExecutionPayloadSchema = event("beforeShellExecution", {
  command: z.string(),
  sandbox: z.boolean().optional(),
});

/**
 * No exit status. The reference lists `command`, `output`, `duration`, and
 * `sandbox`, the captures confirm exactly those, and neither carries an exit
 * code — so the adapter reports this tool end with outcome `unknown` rather
 * than assuming success.
 */
const afterShellExecutionPayloadSchema = event("afterShellExecution", {
  command: z.string(),
  output: z.string().optional(),
  duration: z.number().min(0).optional(),
  sandbox: z.boolean().optional(),
});

const beforeMcpExecutionPayloadSchema = event("beforeMCPExecution", {
  tool_name: z.string().min(1),
  tool_input: z.unknown().optional(),
  url: z.string().optional(),
  command: z.string().optional(),
});

/** As with the shell pair: `result_json` is opaque, and there is no status field. */
const afterMcpExecutionPayloadSchema = event("afterMCPExecution", {
  tool_name: z.string().min(1),
  tool_input: z.unknown().optional(),
  result_json: z.string().optional(),
  duration: z.number().min(0).optional(),
});

const beforeReadFilePayloadSchema = event("beforeReadFile", {
  file_path: z.string(),
  content: z.string().optional(),
  attachments: z.array(attachmentSchema).max(256).optional(),
});

const afterFileEditPayloadSchema = event("afterFileEdit", {
  file_path: z.string(),
  edits: z.array(fileEditSchema).max(1024).optional(),
});

const subagentStartPayloadSchema = event("subagentStart", {
  subagent_id: z.string().optional(),
  subagent_type: z.string().optional(),
  task: z.string().optional(),
  parent_conversation_id: z.string().optional(),
  tool_call_id: z.string().optional(),
  subagent_model: z.string().optional(),
  is_parallel_worker: z.boolean().optional(),
  git_branch: z.string().optional(),
});

/**
 * Carries no subagent identifier. The reference gives `subagentStart` a
 * `subagent_id` and gives `subagentStop` only `subagent_type`, so the two
 * cannot be paired — which is why the adapter ignores both rather than emitting
 * a `subagent.start` that nothing can close. No capture contains either event.
 */
const subagentStopPayloadSchema = event("subagentStop", {
  subagent_type: z.string().optional(),
  status: z.string().optional(),
  task: z.string().optional(),
  description: z.string().optional(),
  summary: z.string().optional(),
  duration_ms: z.number().min(0).optional(),
  message_count: z.number().int().min(0).optional(),
  tool_call_count: z.number().int().min(0).optional(),
  loop_count: z.number().int().min(0).optional(),
  modified_files: z.array(z.string()).max(1024).optional(),
  agent_transcript_path: z.string().nullish(),
});

/** `trigger` is `auto | manual` per the reference; mapped in the adapter. */
const preCompactPayloadSchema = event("preCompact", {
  trigger: z.string().optional(),
  context_usage_percent: z.number().optional(),
  context_tokens: z.number().int().min(0).optional(),
  context_window_size: z.number().int().min(0).optional(),
  message_count: z.number().int().min(0).optional(),
  messages_to_compact: z.number().int().min(0).optional(),
  is_first_compaction: z.boolean().optional(),
});

const stopPayloadSchema = event("stop", {
  status: z.string().optional(),
  loop_count: z.number().int().min(0).optional(),
  ...usageFields,
});

export const cursorPayloadSchema = z.discriminatedUnion("hook_event_name", [
  sessionStartPayloadSchema,
  sessionEndPayloadSchema,
  beforeSubmitPromptPayloadSchema,
  afterAgentResponsePayloadSchema,
  afterAgentThoughtPayloadSchema,
  preToolUsePayloadSchema,
  postToolUsePayloadSchema,
  postToolUseFailurePayloadSchema,
  beforeShellExecutionPayloadSchema,
  afterShellExecutionPayloadSchema,
  beforeMcpExecutionPayloadSchema,
  afterMcpExecutionPayloadSchema,
  beforeReadFilePayloadSchema,
  afterFileEditPayloadSchema,
  subagentStartPayloadSchema,
  subagentStopPayloadSchema,
  preCompactPayloadSchema,
  stopPayloadSchema,
]);
export type CursorPayload = z.infer<typeof cursorPayloadSchema>;

export type CursorPayloadOf<TName extends CursorHookEventName> = Extract<
  CursorPayload,
  { hook_event_name: TName }
>;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export type CursorRecognition =
  /** A modelled agent hook that validated against its schema. */
  | { readonly status: "modelled"; readonly payload: CursorPayload }
  /** A documented Cursor event this adapter does not model, with the reason. */
  | { readonly status: "unmodelled"; readonly eventName: string; readonly reason: string }
  /** A modelled event name whose payload does not satisfy its schema. */
  | { readonly status: "invalid"; readonly eventName: string; readonly detail: string };

/**
 * Recognize a raw Cursor hook payload.
 *
 * Three outcomes rather than two, so the adapter can tell "not Cursor at all"
 * (undefined) from "Cursor, but nothing this adapter turns into telemetry"
 * (`unmodelled`) from "Cursor, and malformed" (`invalid`) — the middle case must
 * not be reported as a parse failure, and the last must not be reported as a
 * foreign payload.
 */
export const recognizeCursorPayload = (payload: unknown): CursorRecognition | undefined => {
  if (!isPlainObject(payload)) {
    return undefined;
  }
  const eventName = payload.hook_event_name;
  if (typeof eventName !== "string") {
    return undefined;
  }

  const unmodelled = CURSOR_UNMODELLED_HOOK_EVENT_NAMES[eventName];
  if (unmodelled !== undefined) {
    return { status: "unmodelled", eventName, reason: unmodelled };
  }
  if (!(CURSOR_HOOK_EVENT_NAMES as readonly string[]).includes(eventName)) {
    return undefined;
  }

  const parsed = cursorPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    return {
      status: "invalid",
      eventName,
      detail:
        issue === undefined
          ? "payload does not satisfy the cursor hook schema"
          : `${issue.path.join(".") || "<root>"}: ${issue.message}`,
    };
  }
  if (cursorSessionId(parsed.data) === undefined) {
    return {
      status: "invalid",
      eventName,
      detail: "payload names neither conversation_id nor session_id, so it carries no session to attribute telemetry to",
    };
  }
  return { status: "modelled", payload: parsed.data };
};

/** Validated payload, or `undefined` for anything else. Convenience for callers. */
export const normalizeCursorPayload = (payload: unknown): CursorPayload | undefined => {
  const recognized = recognizeCursorPayload(payload);
  return recognized?.status === "modelled" ? recognized.payload : undefined;
};

/**
 * The session identity to attribute a modelled payload to.
 *
 * `conversation_id` is preferred, but some live Cursor Agent-surface
 * `beforeSubmitPrompt` deliveries have been observed missing it while still
 * carrying `session_id` — which every capture in `./payload.ts`'s provenance
 * note shows repeating `conversation_id` exactly. Previously the schema
 * required `conversation_id` unconditionally, so any callback missing it —
 * this one included — failed detection outright and was silently declined as
 * `provider-unknown`, with no `prompt.submitted` ever emitted for that
 * conversation. Falling back to `session_id` is not a guess: it is reading the
 * same identity from the field Cursor's own envelope repeats it in, and
 * `recognizeCursorPayload` still rejects a payload naming neither.
 */
export const cursorSessionId = (payload: CursorPayload): string | undefined => {
  if (payload.conversation_id !== undefined && payload.conversation_id.length > 0) {
    return payload.conversation_id;
  }
  return payload.session_id !== undefined && payload.session_id.length > 0
    ? payload.session_id
    : undefined;
};
