/**
 * Cursor hook payload fixtures for unit tests.
 *
 * Shapes are the real ones — see `src/providers/cursor/payload.ts` for the
 * reference and capture set they are derived from. Values are invented:
 * conversation, generation, and tool-call ids are fabricated placeholders,
 * workspace roots and file paths are synthetic, and `user_email` /
 * `transcript_path` are given deliberately conspicuous placeholder values so a
 * test can assert they never reach a sink. Nothing here is copied from a real
 * Cursor session, transcript, or configuration.
 */

export const CONVERSATION_A = "conv-0000-4a00-8000-000000000001";
export const CONVERSATION_B = "conv-0000-4a00-8000-000000000002";
export const GENERATION_A = "gen-0000-4a00-8000-0000000000a1";
export const TOOL_CALL_A = "tool_0000000000004a008000000000000b1";

export const WORKSPACE_ROOT_SINGLE = ["/workspace/synthetic-repo-a"];
export const WORKSPACE_ROOT_MULTI = [
  "/workspace/synthetic-repo-a",
  "/workspace/synthetic-repo-a-docs",
];

/**
 * Values that must never appear in exported telemetry. Cursor really does send
 * an account address and a transcript path on every agent hook.
 */
export const NEVER_EXPORTED_EMAIL = "cursor-fixture-account@example.invalid";
export const NEVER_EXPORTED_TRANSCRIPT_PATH =
  "/workspace/synthetic-transcripts/agent-transcripts/synthetic.jsonl";

const envelope = {
  conversation_id: CONVERSATION_A,
  generation_id: GENERATION_A,
  session_id: CONVERSATION_A,
  model: "synthetic-composer-fast",
  model_id: "synthetic-composer",
  model_params: [{ id: "fast", value: "true" }],
  cursor_version: "2026.07.17-synthetic",
  workspace_roots: WORKSPACE_ROOT_SINGLE,
  user_email: NEVER_EXPORTED_EMAIL,
  transcript_path: NEVER_EXPORTED_TRANSCRIPT_PATH,
};

const payload = (
  hookEventName: string,
  fields: Record<string, unknown>,
  overrides: Record<string, unknown>,
): unknown => ({ ...envelope, hook_event_name: hookEventName, ...fields, ...overrides });

export const sessionStartPayload = (overrides: Record<string, unknown> = {}): unknown =>
  payload("sessionStart", { is_background_agent: false, composer_mode: "agent" }, overrides);

export const sessionEndPayload = (overrides: Record<string, unknown> = {}): unknown =>
  payload(
    "sessionEnd",
    {
      reason: "completed",
      duration_ms: 60_000,
      is_background_agent: false,
      final_status: "completed",
    },
    overrides,
  );

export const beforeSubmitPromptPayload = (overrides: Record<string, unknown> = {}): unknown =>
  payload(
    "beforeSubmitPrompt",
    {
      prompt: "please refactor the synthetic billing module",
      attachments: [{ type: "file", file_path: "/workspace/synthetic-repo-a/src/billing.ts" }],
      composer_mode: "agent",
    },
    overrides,
  );

export const afterAgentResponsePayload = (overrides: Record<string, unknown> = {}): unknown =>
  payload(
    "afterAgentResponse",
    {
      text: "I refactored the synthetic billing module.",
      input_tokens: 43_859,
      output_tokens: 1_076,
      cache_read_tokens: 28_384,
      cache_write_tokens: 0,
    },
    overrides,
  );

export const afterAgentThoughtPayload = (overrides: Record<string, unknown> = {}): unknown =>
  payload(
    "afterAgentThought",
    { text: "I should check the billing module tests first.", duration_ms: 1_200 },
    overrides,
  );

export const preToolUsePayload = (overrides: Record<string, unknown> = {}): unknown =>
  payload(
    "preToolUse",
    {
      tool_name: "Grep",
      tool_input: { pattern: "billing" },
      tool_use_id: TOOL_CALL_A,
      cwd: "",
    },
    overrides,
  );

export const postToolUsePayload = (overrides: Record<string, unknown> = {}): unknown =>
  payload(
    "postToolUse",
    {
      tool_name: "Grep",
      tool_input: { pattern: "billing" },
      tool_output: "{\"matches\":3,\"success\":true}",
      tool_use_id: TOOL_CALL_A,
      duration: 12.98,
      cwd: "",
    },
    overrides,
  );

export const postToolUseFailurePayload = (overrides: Record<string, unknown> = {}): unknown =>
  payload(
    "postToolUseFailure",
    {
      tool_name: "Grep",
      tool_input: { pattern: "billing" },
      tool_use_id: TOOL_CALL_A,
      error_message: "synthetic-tool-error: index unavailable",
      failure_type: "error",
      duration: 100,
      is_interrupt: false,
    },
    overrides,
  );

export const beforeShellExecutionPayload = (overrides: Record<string, unknown> = {}): unknown =>
  payload(
    "beforeShellExecution",
    { command: "echo synthetic-build-step", cwd: "/workspace/synthetic-repo-a", sandbox: false },
    overrides,
  );

export const afterShellExecutionPayload = (overrides: Record<string, unknown> = {}): unknown =>
  payload(
    "afterShellExecution",
    {
      command: "echo synthetic-build-step",
      output: "synthetic-build-step\n",
      duration: 169.812,
      sandbox: false,
    },
    overrides,
  );

export const beforeMcpExecutionPayload = (overrides: Record<string, unknown> = {}): unknown =>
  payload(
    "beforeMCPExecution",
    {
      tool_name: "mcp__synthetic-server__lookup",
      tool_input: "{\"term\":\"invoice\"}",
      url: "https://mcp.example.invalid/synthetic",
    },
    overrides,
  );

export const afterMcpExecutionPayload = (overrides: Record<string, unknown> = {}): unknown =>
  payload(
    "afterMCPExecution",
    {
      tool_name: "mcp__synthetic-server__lookup",
      tool_input: "{\"term\":\"invoice\"}",
      result_json: "{\"found\":true}",
      duration: 84.5,
    },
    overrides,
  );

export const beforeReadFilePayload = (overrides: Record<string, unknown> = {}): unknown =>
  payload(
    "beforeReadFile",
    {
      file_path: "/workspace/synthetic-repo-a/src/billing.ts",
      content: "export const rate = 0.2;\n",
      attachments: [],
    },
    overrides,
  );

export const afterFileEditPayload = (overrides: Record<string, unknown> = {}): unknown =>
  payload(
    "afterFileEdit",
    {
      file_path: "/workspace/synthetic-repo-a/src/billing.ts",
      edits: [{ old_string: "export const rate = 0.2;", new_string: "export const rate = 0.25;" }],
    },
    overrides,
  );

export const subagentStartPayload = (overrides: Record<string, unknown> = {}): unknown =>
  payload(
    "subagentStart",
    {
      subagent_id: "subagent-0000-4a00-8000-0000000000c1",
      subagent_type: "reviewer",
      task: "review the synthetic billing change",
      parent_conversation_id: CONVERSATION_A,
      tool_call_id: TOOL_CALL_A,
      subagent_model: "synthetic-composer",
      is_parallel_worker: false,
    },
    overrides,
  );

export const subagentStopPayload = (overrides: Record<string, unknown> = {}): unknown =>
  payload(
    "subagentStop",
    {
      subagent_type: "reviewer",
      status: "completed",
      task: "review the synthetic billing change",
      description: "reviewed",
      summary: "no findings",
      duration_ms: 500,
      message_count: 4,
      tool_call_count: 2,
      loop_count: 1,
      modified_files: [],
      agent_transcript_path: null,
    },
    overrides,
  );

export const preCompactPayload = (overrides: Record<string, unknown> = {}): unknown =>
  payload(
    "preCompact",
    {
      trigger: "auto",
      context_usage_percent: 82.5,
      context_tokens: 128_000,
      context_window_size: 160_000,
      message_count: 96,
      messages_to_compact: 40,
      is_first_compaction: true,
    },
    overrides,
  );

export const stopPayload = (overrides: Record<string, unknown> = {}): unknown =>
  payload(
    "stop",
    {
      status: "completed",
      loop_count: 1,
      input_tokens: 43_859,
      output_tokens: 1_076,
      cache_read_tokens: 28_384,
      cache_write_tokens: 0,
    },
    overrides,
  );

/** Structurally unrelated payload: should never be recognized as Cursor's. */
export const unknownProviderPayload = (): unknown => ({
  provider: "some-other-agent",
  event: "session.start",
  sessionId: "unrelated-session",
});

/** A Cursor event this adapter deliberately does not model. */
export const workspaceOpenPayload = (): unknown => ({
  hook_event_name: "workspaceOpen",
  cursor_version: "2026.07.17-synthetic",
  workspace_roots: WORKSPACE_ROOT_SINGLE,
  user_email: NEVER_EXPORTED_EMAIL,
});

/** Recognized event name, but missing a field the schema requires. */
export const malformedPayload = (): unknown => ({
  hook_event_name: "preToolUse",
  conversation_id: CONVERSATION_A,
  // tool_name is required and intentionally omitted.
  tool_use_id: TOOL_CALL_A,
});

/** Recognized event name with no session to attribute it to. */
export const sessionlessPayload = (): unknown => ({
  hook_event_name: "sessionStart",
  is_background_agent: false,
});

export const secretBearingPromptPayload = (overrides: Record<string, unknown> = {}): unknown =>
  beforeSubmitPromptPayload({
    prompt: "use this key sk-abcdefghijklmnopqrstuvwx0123 to deploy",
    ...overrides,
  });

export const secretBearingToolInputPayload = (overrides: Record<string, unknown> = {}): unknown =>
  preToolUsePayload({
    tool_input: { command: "deploy --token=abc123", api_key: "sk-live-1234567890abcdef" },
    ...overrides,
  });
