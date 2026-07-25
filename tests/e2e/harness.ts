/**
 * End-to-end harness: drives the *built* CLI binary as a child process.
 *
 * These tests deliberately do not import the library. A hook runs as a
 * subprocess whose stdout is protocol, whose stderr is diagnostics, and whose
 * exit code can abort the host agent — none of which an in-process test can
 * observe. So the binary is built, spawned, and inspected exactly as a coding
 * agent would invoke it.
 */
import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import * as path from "node:path";

export const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
export const CLI_PATH = path.join(REPO_ROOT, "dist", "cli.js");

/**
 * Assert that `dist/cli.js` exists, without building it.
 *
 * Building here would be a race: `tsup` is configured with `clean: true`, so a
 * rebuild during the run deletes the binary out from under a concurrently
 * spawned child process. `tests/global-setup.ts` builds once before any test
 * file, so this is a precondition check rather than a fallback.
 */
export const ensureBuiltCli = async (): Promise<void> => {
  try {
    await access(CLI_PATH);
  } catch {
    throw new Error(
      `${CLI_PATH} is missing. vitest's globalSetup (tests/global-setup.ts) should have built it; ` +
        "run `npm run build` if you are invoking vitest without this repository's config.",
    );
  }
};

export type CliResult = {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

export const runCliProcess = (
  args: readonly string[],
  stdin = "",
  options: { readonly env?: Readonly<Record<string, string>>; readonly timeoutMillis?: number } = {},
): Promise<CliResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd: REPO_ROOT,
      timeout: options.timeoutMillis ?? 30_000,
      env: {
        // A clean environment: the ambient shell must not be able to change what
        // these assertions see (no inherited OTEL_* endpoint, no inherited state
        // directory). PATH is kept so the child can start at all.
        PATH: process.env.PATH ?? "",
        ...options.env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.write(stdin);
    child.stdin.end();
  });

export type CapturedRequest = { readonly headers: IncomingHttpHeaders; readonly body: Buffer };

export type Collector = {
  readonly url: string;
  readonly requests: readonly CapturedRequest[];
  /** All request bodies as one latin1 string: protobuf keeps UTF-8 strings inline. */
  text(): string;
  close(): Promise<void>;
};

/**
 * Local HTTP server standing in for an OTLP collector.
 *
 * Assertions read the raw protobuf bodies as text rather than decoding them:
 * a protobuf-encoded string field appears verbatim in the payload, which is
 * exactly what a privacy assertion needs ("this prompt text is nowhere in what
 * we sent") and what an isolation assertion needs ("this process sent only its
 * own session id"). Decoding first would risk asserting against a
 * re-serialization instead of the bytes that left the process.
 */
export const startCollector = async (
  respond: (request: CapturedRequest) => { readonly status: number } = () => ({ status: 200 }),
): Promise<Collector> => {
  const requests: CapturedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const request = { headers: req.headers, body: Buffer.concat(chunks) };
      requests.push(request);
      const { status } = respond(request);
      res.writeHead(status);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("failed to bind the capturing collector");
  }
  return {
    url: `http://127.0.0.1:${String(address.port)}/v1/traces`,
    requests,
    text: (): string => Buffer.concat(requests.map((request) => request.body)).toString("latin1"),
    close: (): Promise<void> => new Promise((resolve) => server.close(() => resolve())),
  };
};

/** An ephemeral state directory; nothing in these tests touches a real one. */
export const makeStateDir = async (): Promise<{ readonly dir: string; remove(): Promise<void> }> => {
  const dir = await mkdtemp(path.join(tmpdir(), "otel-hook-e2e-"));
  return { dir, remove: (): Promise<void> => rm(dir, { recursive: true, force: true }) };
};

/** A port nothing is listening on, for the unreachable-collector case. */
export const unreachableCollectorUrl = async (): Promise<string> => {
  const probe = await startCollector();
  const { url } = probe;
  await probe.close();
  return url;
};

export type ProviderCase = {
  readonly providerId: string;
  /** Payload in that provider's own hook protocol shape. */
  readonly payload: (sessionId: string) => Record<string, unknown>;
  /** Exact bytes the provider's protocol requires on stdout. */
  readonly expectedStdout: string;
  /** Text that must never appear in what we exported. */
  readonly secret: string;
};

const CLAUDE_SECRET = "claude-prompt-secret-do-not-export";
const CURSOR_SECRET = "cursor-prompt-secret-do-not-export";
const CODEX_SECRET = "codex-prompt-secret-do-not-export";
const GEMINI_SECRET = "gemini-prompt-secret-do-not-export";
const ANTIGRAVITY_SECRET = "antigravity-input-secret-do-not-export";

/**
 * One representative payload per registered provider.
 *
 * Each is written in the shape that provider's own adapter declares, and each
 * carries a distinctive text so a single assertion can prove the default privacy
 * posture held all the way to the wire.
 */
export const PROVIDER_CASES: readonly ProviderCase[] = [
  {
    providerId: "claude-code",
    payload: (sessionId) => ({
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      transcript_path: "/workspace/fixture-repo/.claude/transcript.jsonl",
      cwd: "/workspace/fixture-repo",
      prompt: CLAUDE_SECRET,
    }),
    expectedStdout: "",
    secret: CLAUDE_SECRET,
  },
  {
    providerId: "cursor",
    payload: (sessionId) => ({
      hookEventName: "beforeSubmitPrompt",
      conversationId: sessionId,
      generationId: "gen-e2e-1",
      timestampMillis: 1_700_000_000_000,
      workspaceRoots: ["/workspace/fixture-repo"],
      promptSource: "user",
      promptText: CURSOR_SECRET,
      model: { name: "cursor-model", provider: "anthropic" },
    }),
    // beforeSubmitPrompt is a decision event in the Cursor hook protocol, so the
    // adapter must answer with the protocol's continue response and nothing else.
    expectedStdout: '{"continue":true}',
    secret: CURSOR_SECRET,
  },
  {
    providerId: "codex",
    payload: (sessionId) => ({
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      cwd: "/workspace/fixture-repo",
      turn_id: "turn-e2e-1",
      prompt: CODEX_SECRET,
      occurred_at: 1_700_000_001_000,
    }),
    expectedStdout: "",
    secret: CODEX_SECRET,
  },
  {
    providerId: "gemini-cli",
    payload: (sessionId) => ({
      session_id: sessionId,
      hook_event_name: "BeforeTool",
      cwd: "/workspace/fixture-repo",
      timestamp: "2026-07-25T10:00:06.000Z",
      tool_name: "read_file",
      tool_input: { path: GEMINI_SECRET },
    }),
    expectedStdout: "",
    secret: GEMINI_SECRET,
  },
  {
    providerId: "antigravity",
    payload: (sessionId) => ({
      hookEventName: "PreToolUse",
      conversationId: sessionId,
      workspacePaths: ["/workspace/fixture-repo"],
      stepIdx: 3,
      invocationNum: 1,
      toolName: "run_command",
      toolInput: { command: ANTIGRAVITY_SECRET },
    }),
    expectedStdout: "",
    secret: ANTIGRAVITY_SECRET,
  },
];

export const findProviderCase = (providerId: string): ProviderCase => {
  const found = PROVIDER_CASES.find((entry) => entry.providerId === providerId);
  if (found === undefined) {
    throw new Error(`no e2e payload case for provider "${providerId}"`);
  }
  return found;
};
