#!/usr/bin/env node
/**
 * Wrapping harness around `otel-hook run` for the agent live lab.
 *
 * Some hosts (Claude Code 2.1.x) do not put token counters on hook stdin
 * (docs/claude-code-usage-contract.md). This process:
 *
 * 1. Reads the hook payload.
 * 2. Records the event name (never prompt/tool content) to a lab dump.
 * 3. On Stop, attaches the mock's last `usage` object if the host sent none.
 * 4. Exec's `otel-hook run` with the (possibly decorated) payload on stdin.
 *
 * Fail-open: any wrapper error still forwards the original payload so the
 * host agent is not blocked.
 */

import { spawn } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import * as path from "node:path";

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const asRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;

const payloadHasUsage = (payload) => {
  const record = asRecord(payload);
  if (record === undefined) {
    return false;
  }
  const message = asRecord(record.message);
  const candidates = [record.usage, record.token_usage, record.tokenUsage, message?.usage];
  return candidates.some((candidate) => {
    const usage = asRecord(candidate);
    return usage !== undefined && typeof usage.input_tokens === "number" && typeof usage.output_tokens === "number";
  });
};

const eventNameOf = (payload) => {
  const record = asRecord(payload);
  if (record === undefined) {
    return "unknown";
  }
  if (typeof record.hook_event_name === "string") {
    return record.hook_event_name;
  }
  if (record.type === "result") {
    return "Stop";
  }
  return "unknown";
};

const fetchLastUsage = async (mockUrl) => {
  const response = await fetch(`${mockUrl.replace(/\/+$/, "")}/last-usage`);
  if (!response.ok) {
    throw new Error(`last-usage HTTP ${String(response.status)}`);
  }
  return await response.json();
};

const dumpHook = async (dumpPath, entry) => {
  await mkdir(path.dirname(dumpPath), { recursive: true });
  await appendFile(dumpPath, `${JSON.stringify(entry)}\n`);
};

const forward = (argv, stdin, extraEnv) =>
  new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      stdio: ["pipe", "inherit", "inherit"],
      env: { ...process.env, ...extraEnv },
    });
    child.on("error", () => resolve(0));
    child.on("close", (code) => resolve(code ?? 0));
    child.stdin.end(stdin);
  });

const dashDash = process.argv.indexOf("--");
if (dashDash === -1 || dashDash === process.argv.length - 1) {
  process.stderr.write("otel-hook-wrapper: missing `-- <otel-hook run …>` command\n");
  process.exit(0);
}

const parseFlag = (name) => {
  const flags = process.argv.slice(2, dashDash);
  const index = flags.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return flags[index + 1];
};

const otelArgv = process.argv.slice(dashDash + 1);
const dumpPath = parseFlag("--hooks-jsonl") ?? process.env.OTEL_HOOK_LAB_HOOKS_JSONL;
const mockUrl = parseFlag("--mock-url") ?? process.env.OTEL_HOOK_LAB_MOCK_URL;

let raw = "";
try {
  raw = await readStdin();
} catch {
  process.exit(0);
}

let payload;
try {
  payload = JSON.parse(raw);
} catch {
  process.exit(await forward(otelArgv, raw, {}));
}

const eventName = eventNameOf(payload);
const hadUsage = payloadHasUsage(payload);
let attached = false;
let decorated = raw;

const dump = {
  hook_event_name: eventName,
  had_usage_before_wrapper: hadUsage,
  usage_attached: false,
  ...(typeof payload.tool_name === "string" ? { tool_name: payload.tool_name } : {}),
};

try {
  const isStop = eventName === "Stop" || eventName === "StopFailure" || eventName === "SessionEnd";
  if (isStop && !hadUsage && typeof mockUrl === "string" && mockUrl.length > 0) {
    const usage = await fetchLastUsage(mockUrl);
    const record = asRecord(payload) ?? {};
    record.usage = usage;
    const message = asRecord(record.message) ?? {};
    message.usage = usage;
    record.message = message;
    decorated = JSON.stringify(record);
    attached = true;
    dump.usage_attached = true;
    dump.attached_usage = usage;
  }
} catch (error) {
  dump.wrapper_error = error instanceof Error ? error.name : "unknown";
}

if (typeof dumpPath === "string" && dumpPath.length > 0) {
  try {
    await dumpHook(dumpPath, dump);
  } catch {
    // dump is lab evidence, never a reason to block the hook
  }
}

process.exit(await forward(otelArgv, attached ? decorated : raw, {}));
