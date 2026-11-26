#!/usr/bin/env node
/**
 * Wrapping harness around `otel-hook run` for the agent live lab.
 *
 * Some hosts (Claude Code 2.1.x) do not put token counters on hook stdin
 * (docs/claude-code-usage-contract.md). This process:
 *
 * 1. Reads the hook payload.
 * 2. Records the event name (never prompt/tool content) to a lab dump.
 * 3. On Stop, attaches the mock's last `usage` object if the host sent none
 *    (not with `--no-usage`: the lab then checks otel-hook's own usage read,
 *    e.g. `--codex-rollout-usage`).
 * 4. Exec's `otel-hook run` with the (possibly decorated) payload on stdin.
 *
 * With `--gate-dir <dir>` (the concurrency scenarios), each hook first drops an
 * `arrived` marker naming its session and event, and a hook whose event has a
 * `hold.<event>` file in that directory waits (bounded) for the lab to write
 * `<session-id>.<event>.release` before it forwards. That is how the lab runs a
 * harness command at a precise point of a live session (bind a session that
 * just started, move a session to another slot between two tool hooks).
 *
 * Fail-open: any wrapper error still forwards the original payload so the
 * host agent is not blocked.
 */

import { spawn } from "node:child_process";
import { access, appendFile, mkdir, writeFile } from "node:fs/promises";
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
const noUsage = process.argv.slice(2, dashDash).includes("--no-usage");
const mockUrl = noUsage ? undefined : (parseFlag("--mock-url") ?? process.env.OTEL_HOOK_LAB_MOCK_URL);
const gateDir = parseFlag("--gate-dir");

const GATE_POLL_MILLIS = 25;
const GATE_MAX_WAIT_MILLIS = 25_000;
const SAFE_NAME = /^[A-Za-z0-9._-]{1,200}$/;

/** Lab-only rendezvous; any failure forwards at once (fail-open, like the hook). */
const passGate = async (sessionId, eventName) => {
  if (typeof gateDir !== "string" || !SAFE_NAME.test(sessionId) || !SAFE_NAME.test(eventName)) {
    return;
  }
  try {
    const stamp = `${String(Date.now())}-${String(process.pid)}`;
    await writeFile(
      path.join(gateDir, `${sessionId}.${eventName}.${stamp}.arrived`),
      `${JSON.stringify({ sessionId, eventName, at: Date.now() })}\n`,
    );
    try {
      await access(path.join(gateDir, `hold.${eventName}`));
    } catch {
      return;
    }
    const release = path.join(gateDir, `${sessionId}.${eventName}.release`);
    const deadline = Date.now() + GATE_MAX_WAIT_MILLIS;
    while (Date.now() < deadline) {
      try {
        await access(release);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, GATE_POLL_MILLIS));
      }
    }
  } catch {
    // never block the host on lab plumbing
  }
};

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
  ...(typeof payload.session_id === "string" ? { session_id: payload.session_id } : {}),
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

if (typeof payload?.session_id === "string") {
  await passGate(payload.session_id, eventName);
}
dump.forwarded_at = Date.now();

if (typeof dumpPath === "string" && dumpPath.length > 0) {
  try {
    await dumpHook(dumpPath, dump);
  } catch {
    // dump is lab evidence, never a reason to block the hook
  }
}

process.exit(await forward(otelArgv, attached ? decorated : raw, {}));
