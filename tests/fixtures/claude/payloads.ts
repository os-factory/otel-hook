/**
 * Synthetic Claude Code hook payloads.
 *
 * Provenance: every value below is invented for this repository. Session
 * ids, tool inputs, prompts, and file paths are fabricated strings chosen to
 * exercise the adapter; none are copied from a real transcript, and no
 * credential here is a working one. Field names and shapes follow Claude
 * Code's published hooks reference (code.claude.com/docs/en/hooks).
 */

const SESSION_A = "ses-a1b2c3d4-0000-0000-0000-000000000001";
const SESSION_B = "ses-a1b2c3d4-0000-0000-0000-000000000002";
const CWD_A = "/home/synthetic-user/workspace/demo-repo";

export const sessionStart = {
  hook_event_name: "SessionStart",
  session_id: SESSION_A,
  transcript_path: "/tmp/synthetic/transcript-a.jsonl",
  cwd: CWD_A,
  permission_mode: "default",
  source: "startup",
  model: "claude-opus-5",
};

export const sessionStartResumed = {
  hook_event_name: "SessionStart",
  session_id: SESSION_A,
  transcript_path: "/tmp/synthetic/transcript-a.jsonl",
  cwd: CWD_A,
  source: "resume",
};

export const userPromptSubmit = {
  hook_event_name: "UserPromptSubmit",
  session_id: SESSION_A,
  transcript_path: "/tmp/synthetic/transcript-a.jsonl",
  cwd: CWD_A,
  prompt_id: "prompt-0000-0000-0000-000000000001",
  prompt: "Refactor the synthetic widget loader to lazily import its dependencies.",
};

export const preToolUseBash = {
  hook_event_name: "PreToolUse",
  session_id: SESSION_A,
  transcript_path: "/tmp/synthetic/transcript-a.jsonl",
  cwd: CWD_A,
  prompt_id: "prompt-0000-0000-0000-000000000001",
  tool_use_id: "toolu_synthetic_0001",
  tool_name: "Bash",
  tool_input: {
    command: "npm run build",
    description: "Build the synthetic demo package",
    timeout: 120_000,
  },
};

export const postToolUseBash = {
  hook_event_name: "PostToolUse",
  session_id: SESSION_A,
  transcript_path: "/tmp/synthetic/transcript-a.jsonl",
  cwd: CWD_A,
  prompt_id: "prompt-0000-0000-0000-000000000001",
  tool_use_id: "toolu_synthetic_0001",
  tool_name: "Bash",
  tool_response: "added 12 packages in 4s\nbuild complete",
};

export const postToolUseFailure = {
  hook_event_name: "PostToolUseFailure",
  session_id: SESSION_A,
  transcript_path: "/tmp/synthetic/transcript-a.jsonl",
  cwd: CWD_A,
  prompt_id: "prompt-0000-0000-0000-000000000001",
  tool_use_id: "toolu_synthetic_0002",
  tool_name: "Bash",
  tool_error: "command exited with status 1: synthetic-widget-loader: module not found",
};

export const permissionRequest = {
  hook_event_name: "PermissionRequest",
  session_id: SESSION_A,
  transcript_path: "/tmp/synthetic/transcript-a.jsonl",
  cwd: CWD_A,
  tool_use_id: "toolu_synthetic_0003",
  tool_name: "Write",
  tool_input: { file_path: `${CWD_A}/src/widget-loader.ts`, content: "// synthetic replacement content" },
};

export const subagentStart = {
  hook_event_name: "SubagentStart",
  session_id: SESSION_A,
  transcript_path: "/tmp/synthetic/transcript-a.jsonl",
  cwd: CWD_A,
  agent_id: "agent-explore-0001",
  agent_type: "Explore",
};

export const subagentStop = {
  hook_event_name: "SubagentStop",
  session_id: SESSION_A,
  transcript_path: "/tmp/synthetic/transcript-a.jsonl",
  cwd: CWD_A,
  agent_id: "agent-explore-0001",
  agent_type: "Explore",
  last_assistant_message: "Found three call sites for the widget loader.",
  usage: {
    input_tokens: 512,
    output_tokens: 128,
    cache_read_input_tokens: 4096,
    cache_creation_input_tokens: 0,
  },
};

/** A tool call made from inside the subagent above — carries the same `agent_id`. */
export const preToolUseFromSubagent = {
  hook_event_name: "PreToolUse",
  session_id: SESSION_A,
  transcript_path: "/tmp/synthetic/transcript-a.jsonl",
  cwd: CWD_A,
  agent_id: "agent-explore-0001",
  agent_type: "Explore",
  tool_use_id: "toolu_synthetic_sub_0001",
  tool_name: "Grep",
  tool_input: { pattern: "widget-loader", path: CWD_A },
};

export const preCompact = {
  hook_event_name: "PreCompact",
  session_id: SESSION_A,
  transcript_path: "/tmp/synthetic/transcript-a.jsonl",
  cwd: CWD_A,
  compact_trigger: "auto",
  estimated_tokens_removed: 8_000,
};

/** Cache-heavy: most of the prompt is served from cache. */
export const postCompact = {
  hook_event_name: "PostCompact",
  session_id: SESSION_A,
  transcript_path: "/tmp/synthetic/transcript-a.jsonl",
  cwd: CWD_A,
  compact_trigger: "auto",
  usage: {
    input_tokens: 300,
    output_tokens: 900,
    cache_read_input_tokens: 42_000,
    cache_creation_input_tokens: 6_000,
  },
};

export const stop = {
  hook_event_name: "Stop",
  session_id: SESSION_A,
  transcript_path: "/tmp/synthetic/transcript-a.jsonl",
  cwd: CWD_A,
  prompt_id: "prompt-0000-0000-0000-000000000001",
  last_assistant_message: "Refactored the widget loader to lazily import its dependencies.",
  usage: {
    input_tokens: 1_200,
    output_tokens: 640,
    cache_read_input_tokens: 9_500,
    cache_creation_input_tokens: 2_000,
  },
};

export const stopNoUsage = {
  hook_event_name: "Stop",
  session_id: SESSION_B,
  transcript_path: "/tmp/synthetic/transcript-b.jsonl",
  cwd: CWD_A,
  last_assistant_message: "Done.",
};

export const stopFailureRateLimit = {
  hook_event_name: "StopFailure",
  session_id: SESSION_A,
  transcript_path: "/tmp/synthetic/transcript-a.jsonl",
  cwd: CWD_A,
  prompt_id: "prompt-0000-0000-0000-000000000002",
  error_type: "rate_limit",
  error_message: "synthetic rate limit exceeded",
};

export const stopFailureAuth = {
  hook_event_name: "StopFailure",
  session_id: SESSION_A,
  transcript_path: "/tmp/synthetic/transcript-a.jsonl",
  cwd: CWD_A,
  error_type: "authentication_failed",
  error_message: "synthetic authentication failure",
};

export const sessionEndClear = {
  hook_event_name: "SessionEnd",
  session_id: SESSION_A,
  transcript_path: "/tmp/synthetic/transcript-a.jsonl",
  cwd: CWD_A,
  end_reason: "clear",
};

export const sessionEndLogout = {
  hook_event_name: "SessionEnd",
  session_id: SESSION_A,
  transcript_path: "/tmp/synthetic/transcript-a.jsonl",
  cwd: CWD_A,
  end_reason: "logout",
};

export const sessionEndUnknownReason = {
  hook_event_name: "SessionEnd",
  session_id: SESSION_A,
  transcript_path: "/tmp/synthetic/transcript-a.jsonl",
  cwd: CWD_A,
  end_reason: "a-future-reason-this-adapter-has-never-seen",
};

/** Forward compatibility: fields Claude Code might add in a future release. */
export const preToolUseWithUnknownFields = {
  hook_event_name: "PreToolUse",
  session_id: SESSION_A,
  transcript_path: "/tmp/synthetic/transcript-a.jsonl",
  cwd: CWD_A,
  tool_use_id: "toolu_synthetic_0004",
  tool_name: "Read",
  tool_input: { file_path: `${CWD_A}/README.md` },
  effort: { level: "high" },
  a_field_from_the_future: { nested: true, value: 42 },
};

/** Same shape, but missing `transcript_path` — the weakest evidence this adapter still accepts. */
export const preToolUseWithoutTranscriptPath = {
  hook_event_name: "PreToolUse",
  session_id: SESSION_A,
  cwd: CWD_A,
  tool_use_id: "toolu_synthetic_0005",
  tool_name: "Read",
  tool_input: { file_path: `${CWD_A}/README.md` },
};

/** Parallel tool calls: two PreToolUse firings before either resolves. */
export const parallelToolCalls = [
  {
    hook_event_name: "PreToolUse",
    session_id: SESSION_A,
    transcript_path: "/tmp/synthetic/transcript-a.jsonl",
    cwd: CWD_A,
    tool_use_id: "toolu_synthetic_parallel_1",
    tool_name: "Read",
    tool_input: { file_path: `${CWD_A}/src/a.ts` },
  },
  {
    hook_event_name: "PreToolUse",
    session_id: SESSION_A,
    transcript_path: "/tmp/synthetic/transcript-a.jsonl",
    cwd: CWD_A,
    tool_use_id: "toolu_synthetic_parallel_2",
    tool_name: "Read",
    tool_input: { file_path: `${CWD_A}/src/b.ts` },
  },
  {
    hook_event_name: "PostToolUse",
    session_id: SESSION_A,
    transcript_path: "/tmp/synthetic/transcript-a.jsonl",
    cwd: CWD_A,
    tool_use_id: "toolu_synthetic_parallel_2",
    tool_name: "Read",
    tool_response: "export const b = 2;",
  },
  {
    hook_event_name: "PostToolUse",
    session_id: SESSION_A,
    transcript_path: "/tmp/synthetic/transcript-a.jsonl",
    cwd: CWD_A,
    tool_use_id: "toolu_synthetic_parallel_1",
    tool_name: "Read",
    tool_response: "export const a = 1;",
  },
];

/** Secret-bearing: a tool call whose input/output carries secret-shaped values. */
export const preToolUseWithSecrets = {
  hook_event_name: "PreToolUse",
  session_id: SESSION_A,
  transcript_path: "/tmp/synthetic/transcript-a.jsonl",
  cwd: CWD_A,
  tool_use_id: "toolu_synthetic_secret_0001",
  tool_name: "Bash",
  tool_input: {
    command:
      "curl -H 'Authorization: Bearer sk-synthetic1234567890abcdef' https://example.invalid/api",
    api_key: "sk-synthetic-should-never-leak-0000000000",
    description: "Call a synthetic API with a fabricated bearer token",
  },
};

export const postToolUseWithSecrets = {
  hook_event_name: "PostToolUse",
  session_id: SESSION_A,
  transcript_path: "/tmp/synthetic/transcript-a.jsonl",
  cwd: CWD_A,
  tool_use_id: "toolu_synthetic_secret_0001",
  tool_name: "Bash",
  tool_response: {
    stdout: "authenticated",
    set_cookie: "session=synthetic-secret-cookie-value",
  },
};

// --- Malformed / non-conforming input -------------------------------------

export const malformedMissingSessionId = {
  hook_event_name: "UserPromptSubmit",
  prompt: "no session id on this one",
};

export const malformedUnknownEventName = {
  hook_event_name: "SomethingClaudeCodeHasNeverEmitted",
  session_id: SESSION_A,
};

export const malformedPreToolUseMissingToolUseId = {
  hook_event_name: "PreToolUse",
  session_id: SESSION_A,
  transcript_path: "/tmp/synthetic/transcript-a.jsonl",
  cwd: CWD_A,
  tool_name: "Bash",
  tool_input: { command: "echo hi" },
};

export const malformedNotAnObject = "just a string, not a hook payload";

export const malformedNull = null;

export const malformedArray = [1, 2, 3];

export const malformedEmptyObject = {};

/** Looks Claude-Code-shaped but is missing the discriminant Claude Code always sends. */
export const genericInputResemblingAHook = {
  session_id: SESSION_A,
  event: "tool.start",
  tool: "Bash",
};
