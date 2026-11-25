import { open, stat } from "node:fs/promises";
import path from "node:path";

import type { ClaudeUsage } from "./schema.js";
import { coerceClaudeUsage } from "./usage.js";

/**
 * Bounded reader for the **last assistant message** of one Claude Code session
 * transcript, for a wrapping harness to attach to a `Stop` payload.
 *
 * This is deliberately **not** part of the Claude Code adapter, and the adapter
 * never calls it: `ProviderContext` gives adapters no filesystem handle (ADR
 * 0003), and the adapter must not read `transcript_path` to find tokens
 * (docs/claude-code-usage-contract.md). It is the helper half of the harness
 * contract instead — a wrapper calls it with the one path the hook payload
 * named, and attaches `{ model, usage }` to the payload it hands to otel-hook.
 * It never lists a directory.
 *
 * Why the transcript at all: no Claude Code hook callback carries a token
 * counter, and only `SessionStart` names a model. The per-turn model
 * (`message.model`, which follows `/model`) and the Anthropic usage object
 * (`message.usage`) exist only on assistant transcript records.
 *
 * Every bound is hard, and nothing here throws:
 * - only the last `maxTailBytes` of the file are read, however large it is;
 * - the whole read races a `timeoutMillis` budget;
 * - only regular `.jsonl` files at an absolute path are opened, so a FIFO or a
 *   device cannot stall the hook;
 * - a malformed or truncated line is skipped, never fatal.
 *
 * Nothing but the model id and the numeric counters leaves this module: the
 * record's content (prompt, response, thinking, tool input) is parsed only to
 * be discarded.
 */

export type ClaudeTranscriptTurn =
  | {
      readonly status: "found";
      /** `message.model`; absent when the record named none. */
      readonly model?: string;
      /** `message.usage`, coerced onto the shape the `Stop` schema accepts. */
      readonly usage?: ClaudeUsage;
    }
  | {
      readonly status: "unavailable";
      readonly reason:
        | "invalid-path"
        | "not-a-file"
        | "unreadable"
        | "timeout"
        | "no-assistant-message";
    };

export type ReadClaudeTranscriptTurnOptions = {
  /** Bytes read from the end of the file. Default 1 MiB, clamped to 64 KiB..16 MiB. */
  readonly maxTailBytes?: number;
  /** Budget for the whole read. Default 250 ms, clamped to 10 ms..5 s. */
  readonly timeoutMillis?: number;
};

export const DEFAULT_CLAUDE_TRANSCRIPT_TAIL_BYTES = 1_048_576;
export const DEFAULT_CLAUDE_TRANSCRIPT_TIMEOUT_MILLIS = 250;

const MIN_TAIL_BYTES = 65_536;
const MAX_TAIL_BYTES = 16_777_216;
const MIN_TIMEOUT_MILLIS = 10;
const MAX_TIMEOUT_MILLIS = 5_000;
/** Longer than any real model id; a longer value is not one. */
const MAX_MODEL_ID_LENGTH = 256;
/**
 * Claude Code writes `<synthetic>` as the model of assistant records it made up
 * itself (an API error, an interrupted turn). Those name no real model and carry
 * zeroed usage, so they are skipped in favour of the last real reply.
 */
const SYNTHETIC_MODEL = "<synthetic>";

const clamp = (value: number | undefined, fallback: number, min: number, max: number): number => {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * The model and usage of one transcript line, or `undefined` when it is not a
 * usable top-level assistant record.
 *
 * Sidechain records are a subagent's conversation written into the parent's
 * transcript; the parent's `Stop` is not about them.
 */
const assistantTurnOf = (line: string): { model?: string; usage?: ClaudeUsage } | undefined => {
  // Cheap pre-filter: most lines are user, tool-result, or summary records, and
  // parsing every one of them would spend the budget on records never used.
  if (!line.includes('"assistant"')) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  const record = asRecord(parsed);
  if (record === undefined || record.type !== "assistant" || record.isSidechain === true) {
    return undefined;
  }
  const message = asRecord(record.message);
  if (message === undefined) {
    return undefined;
  }
  const rawModel = message.model;
  if (rawModel === SYNTHETIC_MODEL) {
    return undefined;
  }
  const model =
    typeof rawModel === "string" && rawModel.length > 0 && rawModel.length <= MAX_MODEL_ID_LENGTH
      ? rawModel
      : undefined;
  const usage = coerceClaudeUsage(message.usage);
  if (model === undefined && usage === undefined) {
    return undefined;
  }
  return { ...(model === undefined ? {} : { model }), ...(usage === undefined ? {} : { usage }) };
};

const readTail = async (
  transcriptPath: string,
  maxTailBytes: number,
): Promise<ClaudeTranscriptTurn> => {
  let info;
  try {
    info = await stat(transcriptPath);
  } catch {
    return { status: "unavailable", reason: "unreadable" };
  }
  if (!info.isFile()) {
    return { status: "unavailable", reason: "not-a-file" };
  }
  let handle;
  try {
    handle = await open(transcriptPath, "r");
  } catch {
    return { status: "unavailable", reason: "unreadable" };
  }
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, maxTailBytes);
    const start = size - length;
    const buffer = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled, start + filled);
      if (bytesRead === 0) {
        break;
      }
      filled += bytesRead;
    }
    const lines = buffer.subarray(0, filled).toString("utf8").split("\n");
    // A tail that starts mid-file starts mid-line: that first fragment is not a
    // record, and parsing it could only fail or, worse, half-succeed.
    if (start > 0) {
      lines.shift();
    }
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const turn = assistantTurnOf((lines[index] ?? "").trim());
      if (turn !== undefined) {
        return { status: "found", ...turn };
      }
    }
    return { status: "unavailable", reason: "no-assistant-message" };
  } catch {
    return { status: "unavailable", reason: "unreadable" };
  } finally {
    await handle.close().catch(() => undefined);
  }
};

/**
 * Read the model and usage of the last top-level assistant message in a Claude
 * Code transcript. Never throws, never rejects.
 *
 * The usage is that **one message's** — the final model request of the turn. A
 * turn that called tools made several requests, and the earlier ones are not
 * summed in; see docs/claude-code-usage-contract.md.
 */
export const readClaudeTranscriptTurn = async (
  transcriptPath: string,
  options: ReadClaudeTranscriptTurnOptions = {},
): Promise<ClaudeTranscriptTurn> => {
  if (
    typeof transcriptPath !== "string" ||
    transcriptPath.length === 0 ||
    transcriptPath.includes("\0") ||
    !path.isAbsolute(transcriptPath) ||
    path.extname(transcriptPath) !== ".jsonl"
  ) {
    return { status: "unavailable", reason: "invalid-path" };
  }
  const maxTailBytes = clamp(options.maxTailBytes, DEFAULT_CLAUDE_TRANSCRIPT_TAIL_BYTES, MIN_TAIL_BYTES, MAX_TAIL_BYTES);
  const timeoutMillis = clamp(
    options.timeoutMillis,
    DEFAULT_CLAUDE_TRANSCRIPT_TIMEOUT_MILLIS,
    MIN_TIMEOUT_MILLIS,
    MAX_TIMEOUT_MILLIS,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ClaudeTranscriptTurn>((resolve) => {
    timer = setTimeout(() => {
      resolve({ status: "unavailable", reason: "timeout" });
    }, timeoutMillis);
    // A hook process must be free to exit the moment its real work is done.
    timer.unref();
  });
  try {
    return await Promise.race([
      readTail(transcriptPath, maxTailBytes).catch(
        (): ClaudeTranscriptTurn => ({ status: "unavailable", reason: "unreadable" }),
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const STOP_EVENTS: ReadonlySet<string> = new Set(["Stop", "StopFailure"]);

const hasUsage = (record: Record<string, unknown>): boolean =>
  record.usage !== undefined || record.token_usage !== undefined || record.tokenUsage !== undefined;

/**
 * Attach the last assistant message's `{ model, usage }` to a Claude Code
 * `Stop` / `StopFailure` payload, for a wrapper to hand to otel-hook.
 *
 * Returns the payload unchanged when it is not a stop, names no
 * `transcript_path`, already carries both fields, or the transcript yields
 * nothing — so a wrapper can call it unconditionally. A field the payload
 * already carries is never overwritten. Never throws, never rejects.
 */
export const attachClaudeTranscriptTurn = async (
  payload: unknown,
  options: ReadClaudeTranscriptTurnOptions = {},
): Promise<unknown> => {
  const record = asRecord(payload);
  if (record === undefined) {
    return payload;
  }
  const eventName = record.hook_event_name ?? record.hookEventName;
  if (typeof eventName !== "string" || !STOP_EVENTS.has(eventName)) {
    return payload;
  }
  const transcriptPath = record.transcript_path ?? record.transcriptPath;
  if (typeof transcriptPath !== "string") {
    return payload;
  }
  const needsModel = record.model === undefined;
  const needsUsage = !hasUsage(record);
  if (!needsModel && !needsUsage) {
    return payload;
  }
  const turn = await readClaudeTranscriptTurn(transcriptPath, options);
  if (turn.status !== "found") {
    return payload;
  }
  return {
    ...record,
    ...(needsModel && turn.model !== undefined ? { model: turn.model } : {}),
    ...(needsUsage && turn.usage !== undefined ? { usage: turn.usage } : {}),
  };
};
