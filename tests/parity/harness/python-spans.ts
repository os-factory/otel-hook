/**
 * Thin TypeScript wrapper around scripts/parity/python-reference.mjs.
 *
 * Kept as a subprocess boundary (rather than a direct import) so this file
 * stays plain, typed TS under tsconfig's project while the runner script stays
 * a dependency-free Node program usable standalone in CI.
 */
import { spawn } from "node:child_process";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const RUNNER = path.join(REPO_ROOT, "scripts", "parity", "python-reference.mjs");

export type PythonSpan = {
  readonly name: string;
  readonly trace_id: string;
  readonly span_id: string;
  readonly parent_span_id?: string;
  readonly start_time_ns: number;
  readonly end_time_ns: number;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly resource: Readonly<Record<string, unknown>>;
  readonly links: readonly unknown[];
  readonly status: string;
};

export type PythonSessionResult =
  | { readonly available: true; readonly spans: readonly PythonSpan[] }
  | { readonly available: false; readonly reason: string };

/** Runs a Node script with `input` piped to stdin and its stdout captured, regardless of exit code. */
const runNodeScript = (
  args: readonly string[],
  input: string,
  timeoutMillis: number,
): Promise<{ readonly stdout: string; readonly code: number | null }> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...args], { timeout: timeoutMillis });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (stdout.trim().length === 0 && code !== 0) {
        reject(new Error(`${args.join(" ")} exited ${String(code)} with no stdout: ${stderr.slice(0, 2000)}`));
        return;
      }
      resolve({ stdout, code });
    });
    child.stdin.write(input);
    child.stdin.end();
  });

let cachedProbe: Promise<{ readonly available: boolean; readonly reason?: string }> | undefined;

/** Cached per test-process: the venv/pip probe is expensive, run it once. */
export const isPythonReferenceAvailable = async (): Promise<{
  readonly available: boolean;
  readonly reason?: string;
}> => {
  cachedProbe ??= (async () => {
    try {
      const { stdout } = await runNodeScript([RUNNER, "--probe"], "", 130_000);
      return JSON.parse(stdout) as { available: boolean; reason?: string };
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.message : String(error) };
    }
  })();
  return cachedProbe;
};

/** Runs one parity fixture session (ordered raw hook payloads sharing a session id) through the pinned Python CLI. */
export const runPythonSession = async (
  provider: string,
  payloads: readonly unknown[],
): Promise<PythonSessionResult> => {
  const { stdout } = await runNodeScript(
    [RUNNER, "--provider", provider],
    JSON.stringify(payloads),
    60_000,
  );
  return JSON.parse(stdout) as PythonSessionResult;
};
