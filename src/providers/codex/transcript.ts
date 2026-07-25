import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import { codexUsageSchema, type CodexUsage } from "./payload.js";

/**
 * Bounded streaming reader for a Codex rollout or `codex exec --json`
 * transcript.
 *
 * This is deliberately **not** part of {@link CodexAdapter}: `ProviderContext`
 * gives adapters no filesystem handle, and AGENT.md forbids provider adapters
 * from scanning transcript directories. This function only ever reads the
 * single path a caller supplies explicitly (e.g. a `transcript_path` a
 * `SessionStart` hook payload reported), for host-side usage reconciliation
 * run outside the hook's fail-open path. It never lists a directory.
 *
 * Two on-disk shapes are recognized:
 * - Rollout JSONL: lines of `{ "type": "session_meta" | "turn_context" |
 *   "event_msg" | "response_item", "payload": {...} }`, where a
 *   `token_count` observation is an `event_msg` whose `payload.type` is
 *   `"token_count"`.
 * - `codex exec --json` stream: lines of `{ "type": "thread.started" |
 *   "turn.started" | "turn.completed" | "turn.failed" | "item.started" |
 *   "item.updated" | "item.completed" | "error", ... }` with no `payload`
 *   wrapper.
 */

export type CodexTranscriptObservation =
  | { readonly kind: "session_meta"; readonly line: number; readonly payload: unknown }
  | { readonly kind: "turn_context"; readonly line: number; readonly payload: unknown }
  | {
      readonly kind: "token_count";
      readonly line: number;
      readonly totalTokenUsage?: CodexUsage;
      readonly lastTokenUsage?: CodexUsage;
    }
  | { readonly kind: "response_item"; readonly line: number; readonly payload: unknown }
  | { readonly kind: "event_msg"; readonly line: number; readonly subtype: string; readonly payload: unknown }
  | { readonly kind: "exec_event"; readonly line: number; readonly eventType: string; readonly payload: unknown }
  | { readonly kind: "unrecognized"; readonly line: number }
  | { readonly kind: "malformed"; readonly line: number; readonly reason: "invalid-json" | "line-too-long" }
  | {
      readonly kind: "truncated";
      readonly reason: "max-lines" | "max-malformed-lines";
      readonly atLine: number;
    };

export type StreamCodexTranscriptOptions = {
  /** Stop after this many lines, emitting a `truncated` observation. Default 50,000. */
  readonly maxLines?: number;
  /** Lines longer than this (in bytes) are reported `malformed` without parsing. Default 1 MiB. */
  readonly maxLineBytes?: number;
  /** Stop after this many malformed lines, emitting a `truncated` observation. Default 50. */
  readonly maxMalformedLines?: number;
};

const DEFAULT_MAX_LINES = 50_000;
const DEFAULT_MAX_LINE_BYTES = 1_048_576;
const DEFAULT_MAX_MALFORMED_LINES = 50;

const EXEC_EVENT_TYPES = new Set([
  "thread.started",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "item.started",
  "item.updated",
  "item.completed",
  "error",
]);

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Stable non-token identity to dedupe on, when one exists; `undefined` means never dedupe. */
const dedupeKey = (observation: CodexTranscriptObservation): string | undefined => {
  switch (observation.kind) {
    case "response_item": {
      const record = asRecord(observation.payload);
      const id = record?.id;
      return typeof id === "string" ? `response_item:${id}` : undefined;
    }
    case "turn_context": {
      const record = asRecord(observation.payload);
      const id = record?.id ?? record?.turn_id;
      return typeof id === "string" ? `turn_context:${id}` : undefined;
    }
    case "exec_event": {
      const record = asRecord(observation.payload);
      const item = asRecord(record?.item);
      const id = item?.id;
      return typeof id === "string" ? `exec_event:${observation.eventType}:${id}` : undefined;
    }
    // token_count and session_meta are never deduped by content: two
    // observations that happen to report equal numbers are not duplicates.
    default:
      return undefined;
  }
};

const parseTokenCount = (line: number, eventPayload: unknown): CodexTranscriptObservation => {
  const record = asRecord(eventPayload);
  const total = codexUsageSchema.safeParse(record?.total_token_usage);
  const last = codexUsageSchema.safeParse(record?.last_token_usage);
  return {
    kind: "token_count",
    line,
    ...(total.success ? { totalTokenUsage: total.data } : {}),
    ...(last.success ? { lastTokenUsage: last.data } : {}),
  };
};

const classifyLine = (line: number, value: unknown): CodexTranscriptObservation => {
  const record = asRecord(value);
  if (record === undefined) {
    return { kind: "unrecognized", line };
  }
  const type = record.type;
  if (typeof type !== "string") {
    return { kind: "unrecognized", line };
  }

  if (type === "session_meta") {
    return { kind: "session_meta", line, payload: record.payload };
  }
  if (type === "turn_context") {
    return { kind: "turn_context", line, payload: record.payload };
  }
  if (type === "response_item") {
    return { kind: "response_item", line, payload: record.payload };
  }
  if (type === "event_msg") {
    const eventPayload = asRecord(record.payload);
    const subtype = eventPayload?.type;
    if (subtype === "token_count") {
      return parseTokenCount(line, eventPayload);
    }
    return { kind: "event_msg", line, subtype: typeof subtype === "string" ? subtype : "unknown", payload: record.payload };
  }
  if (EXEC_EVENT_TYPES.has(type)) {
    return { kind: "exec_event", line, eventType: type, payload: record };
  }
  return { kind: "unrecognized", line };
};

/**
 * Stream observations from a single, explicitly supplied transcript path.
 *
 * Bounded on three axes so a huge, hostile, or truncated file cannot exhaust
 * memory or hang a caller: total lines, bytes per line, and consecutive
 * malformed lines. Hitting a bound stops the stream with a `truncated`
 * observation rather than throwing, so callers can log what was skipped
 * instead of silently believing they saw the whole file.
 */
export async function* streamCodexTranscript(
  transcriptPath: string,
  options: StreamCodexTranscriptOptions = {},
): AsyncGenerator<CodexTranscriptObservation> {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const maxMalformedLines = options.maxMalformedLines ?? DEFAULT_MAX_MALFORMED_LINES;

  const stream = createReadStream(transcriptPath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  const seen = new Set<string>();
  let lineNumber = 0;
  let malformedCount = 0;

  try {
    for await (const rawLine of rl) {
      if (rawLine.trim().length === 0) {
        continue;
      }
      lineNumber += 1;

      if (lineNumber > maxLines) {
        yield { kind: "truncated", reason: "max-lines", atLine: lineNumber };
        return;
      }

      if (Buffer.byteLength(rawLine, "utf8") > maxLineBytes) {
        malformedCount += 1;
        yield { kind: "malformed", line: lineNumber, reason: "line-too-long" };
        if (malformedCount > maxMalformedLines) {
          yield { kind: "truncated", reason: "max-malformed-lines", atLine: lineNumber };
          return;
        }
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawLine);
      } catch {
        malformedCount += 1;
        yield { kind: "malformed", line: lineNumber, reason: "invalid-json" };
        if (malformedCount > maxMalformedLines) {
          yield { kind: "truncated", reason: "max-malformed-lines", atLine: lineNumber };
          return;
        }
        continue;
      }

      const observation = classifyLine(lineNumber, parsed);
      const key = dedupeKey(observation);
      if (key !== undefined) {
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
      }
      yield observation;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}
