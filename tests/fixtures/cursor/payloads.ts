/**
 * Synthetic Cursor hook payload fixtures.
 *
 * Provenance: every payload below is invented for this repository to exercise
 * `src/providers/cursor`. None of it is copied from a real Cursor session,
 * transcript, or configuration. Session/conversation ids, workspace roots,
 * file paths, and secret-shaped strings are fabricated placeholders chosen to
 * look plausible while carrying zero real information (see
 * `docs/adr/0003-provider-adapter-boundary.md`).
 */

export const BASE_TIMESTAMP = 1_753_400_000_000;

export const CONVERSATION_A = "conv_00000000000000000000000000000001";
export const CONVERSATION_B = "conv_00000000000000000000000000000002";

export const WORKSPACE_ROOT_SINGLE = ["/workspace/synthetic-repo-a"];
export const WORKSPACE_ROOT_MULTI = [
  "/workspace/synthetic-repo-a",
  "/workspace/synthetic-repo-a-docs",
];

export const sessionStartPayload = (overrides: Record<string, unknown> = {}): unknown => ({
  hookEventName: "sessionStart",
  conversationId: CONVERSATION_A,
  workspaceRoots: WORKSPACE_ROOT_SINGLE,
  model: { name: "synthetic-model-large", provider: "synthetic-labs" },
  timestampMillis: BASE_TIMESTAMP,
  agentVersion: "2026.7.1",
  sessionKind: "interactive",
  agentName: "cursor-cli",
  ...overrides,
});

export const sessionEndPayload = (overrides: Record<string, unknown> = {}): unknown => ({
  hookEventName: "sessionEnd",
  conversationId: CONVERSATION_A,
  timestampMillis: BASE_TIMESTAMP + 60_000,
  reason: "completed",
  durationMillis: 60_000,
  ...overrides,
});

export const beforeSubmitPromptPayload = (overrides: Record<string, unknown> = {}): unknown => ({
  hookEventName: "beforeSubmitPrompt",
  conversationId: CONVERSATION_A,
  generationId: "gen_0001",
  workspaceRoots: WORKSPACE_ROOT_SINGLE,
  model: { name: "synthetic-model-large", provider: "synthetic-labs" },
  timestampMillis: BASE_TIMESTAMP + 1_000,
  promptSource: "user",
  promptText: "please refactor the synthetic billing module",
  turnIndex: 0,
  ...overrides,
});

export const afterAgentResponsePayload = (overrides: Record<string, unknown> = {}): unknown => ({
  hookEventName: "afterAgentResponse",
  conversationId: CONVERSATION_A,
  generationId: "gen_0001",
  model: { name: "synthetic-model-large", provider: "synthetic-labs" },
  timestampMillis: BASE_TIMESTAMP + 5_000,
  responseText: "I refactored the synthetic billing module.",
  durationMillis: 4_000,
  outcome: "ok",
  ...overrides,
});

export const beforeToolUsePayload = (overrides: Record<string, unknown> = {}): unknown => ({
  hookEventName: "beforeToolUse",
  conversationId: CONVERSATION_A,
  generationId: "gen_0001",
  timestampMillis: BASE_TIMESTAMP + 2_000,
  toolCallId: "call_0001",
  toolName: "search_repo",
  toolKind: "search",
  toolInput: { query: "billing" },
  ...overrides,
});

export const afterToolUsePayload = (overrides: Record<string, unknown> = {}): unknown => ({
  hookEventName: "afterToolUse",
  conversationId: CONVERSATION_A,
  timestampMillis: BASE_TIMESTAMP + 2_500,
  toolCallId: "call_0001",
  toolName: "search_repo",
  toolOutput: { matches: 3 },
  durationMillis: 500,
  ...overrides,
});

export const toolUseFailedPayload = (overrides: Record<string, unknown> = {}): unknown => ({
  hookEventName: "toolUseFailed",
  conversationId: CONVERSATION_A,
  timestampMillis: BASE_TIMESTAMP + 2_600,
  toolCallId: "call_0002",
  toolName: "search_repo",
  errorText: "synthetic-tool-error: index unavailable",
  durationMillis: 100,
  ...overrides,
});

export const beforeShellExecutionPayload = (overrides: Record<string, unknown> = {}): unknown => ({
  hookEventName: "beforeShellExecution",
  conversationId: CONVERSATION_A,
  generationId: "gen_0001",
  timestampMillis: BASE_TIMESTAMP + 3_000,
  command: "echo synthetic-build-step",
  ...overrides,
});

export const afterShellExecutionPayload = (overrides: Record<string, unknown> = {}): unknown => ({
  hookEventName: "afterShellExecution",
  conversationId: CONVERSATION_A,
  timestampMillis: BASE_TIMESTAMP + 3_200,
  command: "echo synthetic-build-step",
  exitCode: 0,
  outputText: "synthetic-build-step",
  durationMillis: 200,
  ...overrides,
});

export const beforeMCPExecutionPayload = (overrides: Record<string, unknown> = {}): unknown => ({
  hookEventName: "beforeMCPExecution",
  conversationId: CONVERSATION_A,
  generationId: "gen_0001",
  timestampMillis: BASE_TIMESTAMP + 3_400,
  server: "synthetic-mcp-server",
  tool: "lookup",
  input: { term: "invoice" },
  ...overrides,
});

export const afterMCPExecutionPayload = (overrides: Record<string, unknown> = {}): unknown => ({
  hookEventName: "afterMCPExecution",
  conversationId: CONVERSATION_A,
  timestampMillis: BASE_TIMESTAMP + 3_600,
  server: "synthetic-mcp-server",
  tool: "lookup",
  output: { found: true },
  durationMillis: 200,
  isError: false,
  ...overrides,
});

export const subagentStartPayload = (overrides: Record<string, unknown> = {}): unknown => ({
  hookEventName: "subagentStart",
  conversationId: CONVERSATION_A,
  timestampMillis: BASE_TIMESTAMP + 4_000,
  subagentInvocationId: "inv_subagent_0001",
  subagentType: "reviewer",
  delegationDepth: 1,
  model: { name: "synthetic-model-small" },
  ...overrides,
});

export const subagentStopPayload = (overrides: Record<string, unknown> = {}): unknown => ({
  hookEventName: "subagentStop",
  conversationId: CONVERSATION_A,
  timestampMillis: BASE_TIMESTAMP + 4_500,
  subagentInvocationId: "inv_subagent_0001",
  outcome: "ok",
  durationMillis: 500,
  ...overrides,
});

export const preCompactPayload = (overrides: Record<string, unknown> = {}): unknown => ({
  hookEventName: "preCompact",
  conversationId: CONVERSATION_A,
  timestampMillis: BASE_TIMESTAMP + 5_500,
  trigger: "automatic",
  contextTokensBefore: 128_000,
  ...overrides,
});

export const stopPayload = (overrides: Record<string, unknown> = {}): unknown => ({
  hookEventName: "stop",
  conversationId: CONVERSATION_A,
  generationId: "gen_0001",
  timestampMillis: BASE_TIMESTAMP + 6_000,
  stopReason: "completed",
  generationCompleted: true,
  durationMillis: 5_000,
  ...overrides,
});

export const afterFileEditPayload = (overrides: Record<string, unknown> = {}): unknown => ({
  hookEventName: "afterFileEdit",
  conversationId: CONVERSATION_A,
  generationId: "gen_0001",
  timestampMillis: BASE_TIMESTAMP + 2_800,
  filePath: "/workspace/synthetic-repo-a/src/billing.ts",
  editKind: "modify",
  ...overrides,
});

export const beforeReadFilePayload = (overrides: Record<string, unknown> = {}): unknown => ({
  hookEventName: "beforeReadFile",
  conversationId: CONVERSATION_A,
  generationId: "gen_0001",
  timestampMillis: BASE_TIMESTAMP + 1_800,
  filePath: "/workspace/synthetic-repo-a/src/billing.ts",
  ...overrides,
});

export const afterAgentThoughtPayload = (overrides: Record<string, unknown> = {}): unknown => ({
  hookEventName: "afterAgentThought",
  conversationId: CONVERSATION_A,
  generationId: "gen_0001",
  timestampMillis: BASE_TIMESTAMP + 1_500,
  thoughtText: "I should check the billing module tests first.",
  thoughtIndex: 0,
  ...overrides,
});

/** Legacy (snake_case, older event names) equivalent of `sessionStartPayload`. */
export const legacySessionStartPayload = (overrides: Record<string, unknown> = {}): unknown => ({
  hook_event_name: "session_start",
  conversation_id: CONVERSATION_A,
  workspace_roots: WORKSPACE_ROOT_SINGLE,
  model: { name: "synthetic-model-large", provider: "synthetic-labs" },
  timestamp_millis: BASE_TIMESTAMP,
  agent_version: "2025.11.0",
  session_kind: "interactive",
  agent_name: "cursor-cli",
  ...overrides,
});

/** Legacy equivalent of `beforeSubmitPromptPayload`; exercises the renamed event. */
export const legacyBeforeSubmitPromptPayload = (
  overrides: Record<string, unknown> = {},
): unknown => ({
  hook_event_name: "before_user_prompt",
  conversation_id: CONVERSATION_A,
  generation_id: "gen_0001",
  timestamp_millis: BASE_TIMESTAMP + 1_000,
  prompt_source: "user",
  prompt_text: "please refactor the synthetic billing module",
  turn_index: 0,
  ...overrides,
});

/** Legacy equivalent of `stopPayload`; exercises the `agent_stop` rename. */
export const legacyStopPayload = (overrides: Record<string, unknown> = {}): unknown => ({
  hook_event_name: "agent_stop",
  conversation_id: CONVERSATION_A,
  generation_id: "gen_0001",
  timestamp_millis: BASE_TIMESTAMP + 6_000,
  stop_reason: "cancelled",
  generation_completed: false,
  ...overrides,
});

/** Structurally unrelated payload: should never be recognized as Cursor's. */
export const unknownProviderPayload = (): unknown => ({
  provider: "some-other-agent",
  event: "session.start",
  sessionId: "unrelated-session",
});

/** Recognized event name, but missing a field the schema requires. */
export const malformedPayload = (): unknown => ({
  hookEventName: "beforeToolUse",
  conversationId: CONVERSATION_A,
  timestampMillis: BASE_TIMESTAMP,
  // toolCallId and toolName are required and intentionally omitted.
});

/** Payload carrying secret-shaped content, to prove it never reaches the sink. */
export const secretBearingPromptPayload = (overrides: Record<string, unknown> = {}): unknown =>
  beforeSubmitPromptPayload({
    promptText: "use this key sk-abcdefghijklmnopqrstuvwx0123 to deploy",
    ...overrides,
  });

export const secretBearingToolInputPayload = (overrides: Record<string, unknown> = {}): unknown =>
  beforeToolUsePayload({
    toolInput: { command: "deploy --token=abc123", api_key: "sk-live-1234567890abcdef" },
    ...overrides,
  });
