/**
 * Drives the e2e proof scripts (scripts/e2e-proof/*.mjs) as child processes,
 * the way a proof run uses them: the receiver as a long-running process that
 * announces its endpoint on stdout, the checker as a one-shot command whose exit
 * code and JSON are the result.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

export const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
export const RECEIVER = path.join(REPO_ROOT, "scripts", "e2e-proof", "otlp-receiver.mjs");
export const CHECKER = path.join(REPO_ROOT, "scripts", "e2e-proof", "check-evidence.mjs");
export const PASSING_CAPTURE = path.join(REPO_ROOT, "tests", "fixtures", "e2e-proof", "passing-capture");

export type ScriptResult = { readonly code: number | null; readonly stdout: string; readonly stderr: string };

export const runNode = (
  args: readonly string[],
  options: { readonly stdin?: string; readonly env?: Readonly<Record<string, string>> } = {},
): Promise<ScriptResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...args], {
      cwd: REPO_ROOT,
      timeout: 60_000,
      env: { PATH: process.env.PATH ?? "", ...options.env },
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
    child.stdin.end(options.stdin ?? "");
  });

export type EvidenceCheck = {
  readonly id: string;
  readonly row: string | null;
  readonly status: "pass" | "fail" | "skip" | "manual";
  readonly details: readonly string[];
};

export type EvidenceResult = {
  readonly schema: string;
  readonly ok: boolean;
  readonly provider: string | null;
  readonly summary: {
    readonly requests: number;
    readonly emptyRequests: readonly number[];
    readonly rejectedRequests: readonly number[];
    readonly spans: number;
    readonly logs: number;
    readonly traceIds: readonly string[];
    readonly launcherSessionIds: readonly string[];
  };
  readonly checks: readonly EvidenceCheck[];
};

export const runChecker = async (
  args: readonly string[],
): Promise<ScriptResult & { readonly result: EvidenceResult | undefined }> => {
  const outcome = await runNode([CHECKER, ...args]);
  let result: EvidenceResult | undefined;
  try {
    result = JSON.parse(outcome.stdout) as EvidenceResult;
  } catch {
    result = undefined;
  }
  return { ...outcome, result };
};

export const statusOf = (result: EvidenceResult | undefined, id: string): EvidenceCheck["status"] | undefined =>
  result?.checks.find((entry) => entry.id === id)?.status;

export const detailsOf = (result: EvidenceResult | undefined, id: string): string =>
  (result?.checks.find((entry) => entry.id === id)?.details ?? []).join("\n");

export const makeTempDir = async (prefix: string): Promise<{ readonly dir: string; remove(): Promise<void> }> => {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  return { dir, remove: (): Promise<void> => rm(dir, { recursive: true, force: true }) };
};

/** A writable copy of the passing fixture capture, for one mutation. */
export const copyPassingCapture = async (target: string): Promise<string> => {
  await cp(PASSING_CAPTURE, target, { recursive: true });
  return target;
};

export type ReceiverProcess = {
  readonly endpoint: string;
  readonly tracesUrl: string;
  readonly logsUrl: string;
  readonly child: ChildProcessWithoutNullStreams;
  /** Close stdin, then resolve with the final `closed` line once the process exits. */
  stop(): Promise<Record<string, unknown>>;
};

export const startReceiverProcess = (args: readonly string[]): Promise<ReceiverProcess> =>
  new Promise((resolve, reject) => {
    // Stopped by closing stdin rather than SIGTERM: on Windows a signal kills the
    // process outright, before it can write its summary.
    const child = spawn(process.execPath, [RECEIVER, "--stop-on-stdin-close", ...args], {
      cwd: REPO_ROOT,
      env: { PATH: process.env.PATH ?? "" },
    });
    let stdout = "";
    let stderr = "";
    let announced = false;
    const exited = new Promise<void>((done) => child.on("close", () => done()));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const first = stdout.split("\n")[0];
      if (!announced && stdout.includes("\n") && first !== undefined) {
        announced = true;
        const line = JSON.parse(first) as { endpoint: string; tracesUrl: string; logsUrl: string };
        resolve({
          ...line,
          child,
          stop: async (): Promise<Record<string, unknown>> => {
            child.stdin.end();
            await exited;
            const last = stdout.trim().split("\n").at(-1) ?? "{}";
            return JSON.parse(last) as Record<string, unknown>;
          },
        });
      }
    });
    void exited.then(() => {
      if (!announced) {
        reject(new Error(`receiver exited before listening: ${stderr}`));
      }
    });
  });
