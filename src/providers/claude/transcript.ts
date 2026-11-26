import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import path from "node:path";

import type { PayloadEnricher, PayloadEnrichment, ReadCursor } from "../../runtime/ports.js";
import { CLAUDE_CODE_PROVIDER_ID } from "./detect.js";
import type { ClaudeUsage } from "./schema.js";
import { coerceClaudeUsage } from "./usage.js";

/**
 * Bounded readers for one Claude Code session transcript, and the enricher that
 * uses them to attach a turn's model and token usage to a `Stop` payload.
 *
 * None of this is part of the Claude Code adapter, and the adapter never calls
 * it: `ProviderContext` gives adapters no filesystem handle (ADR 0003). Two
 * callers use it instead:
 *
 * - a wrapping harness, through {@link attachClaudeTranscriptTurn}, which reads
 *   the last assistant message only;
 * - the hook runtime, through {@link createClaudeTranscriptUsageEnricher}, when
 *   the host turns on `providers.claudeCode.readTranscriptUsage` — the one
 *   sanctioned exception to "no transcript reads in the hook". It sums the whole
 *   turn, from a byte cursor the runtime keeps in the state store.
 *
 * Why the transcript at all: no Claude Code hook callback carries a token
 * counter, and only `SessionStart` names a model. The per-turn model
 * (`message.model`, which follows `/model`) and the Anthropic usage object
 * (`message.usage`) exist only on assistant transcript records, one record per
 * content block, each repeating its request's `message.id`.
 *
 * Every bound is hard, and nothing here throws:
 * - only regular `.jsonl` files at an absolute path are opened, so a FIFO or a
 *   device cannot stall the hook, and no directory is ever listed;
 * - a read is capped in bytes and raced against a time budget;
 * - a malformed or truncated line is skipped, never fatal.
 *
 * Nothing but model ids and numeric counters leaves this module: a record's
 * content (prompt, response, thinking, tool input) is parsed only to be dropped.
 */

export type ClaudeTranscriptUnavailableReason =
  | "invalid-path"
  | "not-a-file"
  | "unreadable"
  | "timeout"
  | "no-assistant-message";

export type ClaudeTranscriptTurn =
  | {
      readonly status: "found";
      /** `message.model`; absent when the record named none. */
      readonly model?: string;
      /** `message.usage`, coerced onto the shape the `Stop` schema accepts. */
      readonly usage?: ClaudeUsage;
    }
  | { readonly status: "unavailable"; readonly reason: ClaudeTranscriptUnavailableReason };

export type ReadClaudeTranscriptTurnOptions = {
  /** Bytes read from the end of the file. Default 1 MiB, clamped to 64 KiB..16 MiB. */
  readonly maxTailBytes?: number;
  /** Budget for the whole read. Default 250 ms, clamped to 10 ms..5 s. */
  readonly timeoutMillis?: number;
};

export const DEFAULT_CLAUDE_TRANSCRIPT_TAIL_BYTES = 1_048_576;
export const DEFAULT_CLAUDE_TRANSCRIPT_TIMEOUT_MILLIS = 250;
export const DEFAULT_CLAUDE_TRANSCRIPT_RANGE_BYTES = 8_388_608;
export const DEFAULT_CLAUDE_TRANSCRIPT_RANGE_TIMEOUT_MILLIS = 500;

const MIN_TAIL_BYTES = 65_536;
const MAX_TAIL_BYTES = 16_777_216;
const MAX_RANGE_BYTES = 67_108_864;
const MIN_TIMEOUT_MILLIS = 10;
const MAX_TIMEOUT_MILLIS = 5_000;
/** Longer than any real model id; a longer value is not one. */
const MAX_MODEL_ID_LENGTH = 256;
/** Bounds the request ids held while summing one range. */
const MAX_REQUESTS_PER_RANGE = 10_000;
/**
 * Claude Code writes `<synthetic>` as the model of assistant records it made up
 * itself (an API error, an interrupted turn). Those name no real model and carry
 * zeroed usage, so they are skipped.
 */
const SYNTHETIC_MODEL = "<synthetic>";

const TIMED_OUT = Symbol("timed-out");

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

const isTranscriptPath = (transcriptPath: unknown): transcriptPath is string =>
  typeof transcriptPath === "string" &&
  transcriptPath.length > 0 &&
  !transcriptPath.includes("\0") &&
  path.isAbsolute(transcriptPath) &&
  path.extname(transcriptPath) === ".jsonl";

/**
 * A record of subagent `agentId`: a sidechain record naming that agent, or
 * naming none (the file is the agent's own; only a different name excludes it).
 */
const isRecordOfAgent = (record: Record<string, unknown>, agentId: string): boolean =>
  record.isSidechain === true && (typeof record.agentId !== "string" || record.agentId === agentId);

type AssistantRecord = { readonly id?: string; readonly model?: string; readonly usage?: ClaudeUsage };

/**
 * The request id, model and usage of one transcript line, or `undefined` when
 * it is not a usable assistant record of the thread being read.
 *
 * Without `agentId` that thread is the main one: sidechain records are a
 * subagent's conversation, and the parent's `Stop` is not about them. With
 * `agentId` it is that subagent's, read from its own transcript
 * (`agent_transcript_path`), where every record is a sidechain record; a record
 * naming another agent is skipped.
 */
const assistantRecordOf = (line: string, agentId?: string): AssistantRecord | undefined => {
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
  if (record === undefined || record.type !== "assistant") {
    return undefined;
  }
  if (agentId === undefined ? record.isSidechain === true : !isRecordOfAgent(record, agentId)) {
    return undefined;
  }
  const message = asRecord(record.message);
  if (message === undefined || message.model === SYNTHETIC_MODEL) {
    return undefined;
  }
  const model =
    typeof message.model === "string" && message.model.length > 0 && message.model.length <= MAX_MODEL_ID_LENGTH
      ? message.model
      : undefined;
  const usage = coerceClaudeUsage(message.usage);
  if (model === undefined && usage === undefined) {
    return undefined;
  }
  const id =
    typeof message.id === "string" && message.id.length > 0 && message.id.length <= 256 ? message.id : undefined;
  return {
    ...(id === undefined ? {} : { id }),
    ...(model === undefined ? {} : { model }),
    ...(usage === undefined ? {} : { usage }),
  };
};

const cacheCreationOf = (usage: ClaudeUsage): number =>
  usage.cache_creation_input_tokens ??
  (usage.cache_creation === undefined
    ? 0
    : (usage.cache_creation.ephemeral_5m_input_tokens ?? 0) + (usage.cache_creation.ephemeral_1h_input_tokens ?? 0));

/**
 * Sum per-request usage into one turn total.
 *
 * Only the four counters are summed. The TTL split and `iterations[]` are
 * breakdowns of one request's counters (docs/claude-code-usage-contract.md,
 * findings 3 and 4); carrying them across requests would add nothing a consumer
 * reads, and the adapter would only audit them against the sums.
 */
const sumUsage = (usages: readonly ClaudeUsage[]): ClaudeUsage => {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheCreation = 0;
  for (const usage of usages) {
    input += usage.input_tokens;
    output += usage.output_tokens;
    cacheRead += usage.cache_read_input_tokens ?? 0;
    cacheCreation += cacheCreationOf(usage);
  }
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation,
  };
};

/** Race `work` against a budget; a rejection becomes `onError`. */
const withTimeout = async <T>(
  work: Promise<T>,
  timeoutMillis: number,
  onError: T,
): Promise<T | typeof TIMED_OUT> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      resolve(TIMED_OUT);
    }, timeoutMillis);
    // A hook process must be free to exit the moment its real work is done.
    timer.unref();
  });
  try {
    return await Promise.race([work.catch(() => onError), timeout]);
  } finally {
    clearTimeout(timer);
  }
};

type FileUnavailable = { readonly status: "unavailable"; readonly reason: "not-a-file" | "unreadable" };

type FileHandle = Awaited<ReturnType<typeof open>>;

/** Open a regular file and run `body` with its handle and size; always closes. */
const withRegularFile = async <T>(
  transcriptPath: string,
  body: (handle: FileHandle, size: number) => Promise<T>,
): Promise<T | FileUnavailable> => {
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
    return await body(handle, size);
  } catch {
    return { status: "unavailable", reason: "unreadable" };
  } finally {
    await handle.close().catch(() => undefined);
  }
};

const readBytes = async (handle: FileHandle, start: number, length: number): Promise<Buffer> => {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, start + filled);
    if (bytesRead === 0) {
      break;
    }
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
};

/** Offset just past the last complete line of `bytes`, read from `start`. */
const completeLinesEnd = (bytes: Buffer, start: number): number => {
  const lastNewline = bytes.lastIndexOf(0x0a);
  return lastNewline < 0 ? start : start + lastNewline + 1;
};

type TailRead = { readonly turn: ClaudeTranscriptTurn; readonly endOffset: number };

const readTail = (
  transcriptPath: string,
  maxTailBytes: number,
  agentId: string | undefined,
): Promise<TailRead | FileUnavailable> =>
  withRegularFile(transcriptPath, async (handle, size): Promise<TailRead> => {
    const length = Math.min(size, maxTailBytes);
    const start = size - length;
    const bytes = await readBytes(handle, start, length);
    const endOffset = completeLinesEnd(bytes, start);
    const lines = bytes.toString("utf8").split("\n");
    // A tail that starts mid-file starts mid-line: that first fragment is not a
    // record, and parsing it could only fail or, worse, half-succeed.
    if (start > 0) {
      lines.shift();
    }
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const record = assistantRecordOf((lines[index] ?? "").trim(), agentId);
      if (record !== undefined) {
        return {
          turn: {
            status: "found",
            ...(record.model === undefined ? {} : { model: record.model }),
            ...(record.usage === undefined ? {} : { usage: record.usage }),
          },
          endOffset,
        };
      }
    }
    return { turn: { status: "unavailable", reason: "no-assistant-message" }, endOffset };
  });

const boundedTail = async (
  transcriptPath: string,
  options: ReadClaudeTranscriptTurnOptions,
  agentId?: string,
): Promise<TailRead | FileUnavailable | typeof TIMED_OUT> =>
  withTimeout<TailRead | FileUnavailable>(
    readTail(
      transcriptPath,
      clamp(options.maxTailBytes, DEFAULT_CLAUDE_TRANSCRIPT_TAIL_BYTES, MIN_TAIL_BYTES, MAX_TAIL_BYTES),
      agentId,
    ),
    clamp(options.timeoutMillis, DEFAULT_CLAUDE_TRANSCRIPT_TIMEOUT_MILLIS, MIN_TIMEOUT_MILLIS, MAX_TIMEOUT_MILLIS),
    { status: "unavailable", reason: "unreadable" },
  );

/**
 * Read the model and usage of the last main-thread assistant message in a
 * Claude Code transcript. Never throws, never rejects.
 *
 * The usage is that **one message's** — the final model request of the turn. A
 * turn that called tools made several requests, and the earlier ones are not
 * summed in; {@link readClaudeTranscriptRange} sums a whole turn.
 */
export const readClaudeTranscriptTurn = async (
  transcriptPath: string,
  options: ReadClaudeTranscriptTurnOptions = {},
): Promise<ClaudeTranscriptTurn> => {
  if (!isTranscriptPath(transcriptPath)) {
    return { status: "unavailable", reason: "invalid-path" };
  }
  const read = await boundedTail(transcriptPath, options);
  if (read === TIMED_OUT) {
    return { status: "unavailable", reason: "timeout" };
  }
  return "turn" in read ? read.turn : read;
};

export type ClaudeTranscriptRange =
  | {
      readonly status: "found";
      /** Model of the last main-thread assistant record in the range. */
      readonly model?: string;
      /** Summed usage of every distinct request; absent when none reported usage. */
      readonly usage?: ClaudeUsage;
      /** Distinct main-thread requests (by `message.id`) in the range. */
      readonly requestCount: number;
      /** Offset just past the last complete line read: the next range starts here. */
      readonly endOffset: number;
    }
  | {
      readonly status: "unavailable";
      readonly reason:
        | "invalid-path"
        | "not-a-file"
        | "unreadable"
        | "timeout"
        /** The file is shorter than the offset: it was replaced or truncated. */
        | "truncated"
        /** More than the range cap was written since the offset. */
        | "over-cap";
    };

export type ReadClaudeTranscriptRangeOptions = {
  /** Most bytes a range may span. Default 8 MiB, clamped to 64 KiB..64 MiB. */
  readonly maxRangeBytes?: number;
  /** Budget for the whole range read. Default 500 ms, clamped to 10 ms..5 s. */
  readonly rangeTimeoutMillis?: number;
  /**
   * Read subagent `agentId`'s requests (its sidechain records) instead of the
   * main thread's. For a subagent's own transcript, `agent_transcript_path`.
   */
  readonly agentId?: string;
};

/**
 * Sum every main-thread model request (or, with `agentId`, every request of that
 * subagent) written between `fromOffset` and the end of the transcript. Never
 * throws, never rejects.
 *
 * Records of one request share a `message.id` and each repeats its usage, so the
 * last record per id is the one counted; a record without an id counts alone.
 * A trailing partial line is left for the next range.
 */
export const readClaudeTranscriptRange = async (
  transcriptPath: string,
  fromOffset: number,
  options: ReadClaudeTranscriptRangeOptions = {},
): Promise<ClaudeTranscriptRange> => {
  if (!isTranscriptPath(transcriptPath) || !Number.isSafeInteger(fromOffset) || fromOffset < 0) {
    return { status: "unavailable", reason: "invalid-path" };
  }
  const maxRangeBytes = clamp(options.maxRangeBytes, DEFAULT_CLAUDE_TRANSCRIPT_RANGE_BYTES, MIN_TAIL_BYTES, MAX_RANGE_BYTES);
  const timeoutMillis = clamp(
    options.rangeTimeoutMillis,
    DEFAULT_CLAUDE_TRANSCRIPT_RANGE_TIMEOUT_MILLIS,
    MIN_TIMEOUT_MILLIS,
    MAX_TIMEOUT_MILLIS,
  );
  const work = withRegularFile(transcriptPath, async (handle, size): Promise<ClaudeTranscriptRange> => {
    if (size < fromOffset) {
      return { status: "unavailable", reason: "truncated" };
    }
    if (size - fromOffset > maxRangeBytes) {
      return { status: "unavailable", reason: "over-cap" };
    }
    const bytes = await readBytes(handle, fromOffset, size - fromOffset);
    const endOffset = completeLinesEnd(bytes, fromOffset);
    const complete = bytes.subarray(0, endOffset - fromOffset).toString("utf8");
    const requests = new Map<string, AssistantRecord>();
    let anonymous = 0;
    let model: string | undefined;
    for (const line of complete.split("\n")) {
      const record = assistantRecordOf(line.trim(), options.agentId);
      if (record === undefined) {
        continue;
      }
      if (record.model !== undefined) {
        model = record.model;
      }
      anonymous += record.id === undefined ? 1 : 0;
      // The last record of a request carries its final usage, so it replaces the earlier ones.
      requests.set(record.id ?? `#${String(anonymous)}`, record);
      if (requests.size > MAX_REQUESTS_PER_RANGE) {
        return { status: "unavailable", reason: "over-cap" };
      }
    }
    const usages = [...requests.values()].flatMap((record) => (record.usage === undefined ? [] : [record.usage]));
    return {
      status: "found",
      ...(model === undefined ? {} : { model }),
      ...(usages.length === 0 ? {} : { usage: sumUsage(usages) }),
      requestCount: requests.size,
      endOffset,
    };
  });
  const result = await withTimeout<ClaudeTranscriptRange | FileUnavailable>(work, timeoutMillis, {
    status: "unavailable",
    reason: "unreadable",
  });
  return result === TIMED_OUT ? { status: "unavailable", reason: "timeout" } : result;
};

const STOP_EVENTS: ReadonlySet<string> = new Set(["Stop", "StopFailure"]);

const hasUsage = (record: Record<string, unknown>): boolean =>
  record.usage !== undefined || record.token_usage !== undefined || record.tokenUsage !== undefined;

const eventNameOf = (record: Record<string, unknown>): unknown => record.hook_event_name ?? record.hookEventName;
const transcriptPathOf = (record: Record<string, unknown>): unknown =>
  record.transcript_path ?? record.transcriptPath;

/**
 * Attach the last assistant message's `{ model, usage }` to a Claude Code
 * `Stop` / `StopFailure` payload, for a wrapper to hand to otel-hook.
 *
 * The usage is one request's, so it is attached with `usage_partial: true`,
 * which the exported generation reports as `otelhook.usage.partial`. For whole
 * turn totals, turn on `providers.claudeCode.readTranscriptUsage` instead.
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
  const eventName = eventNameOf(record);
  if (typeof eventName !== "string" || !STOP_EVENTS.has(eventName)) {
    return payload;
  }
  const transcriptPath = transcriptPathOf(record);
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
    ...(needsUsage && turn.usage !== undefined ? { usage: turn.usage, usage_partial: true } : {}),
  };
};

export type ClaudeTranscriptUsageEnricherOptions = ReadClaudeTranscriptTurnOptions &
  Omit<ReadClaudeTranscriptRangeOptions, "agentId">;

export const CLAUDE_TRANSCRIPT_USAGE_ENRICHER_ID = "claude-transcript-usage";

/** Opaque, path-free name for a transcript, stored beside its cursor. */
const sourceDigest = (transcriptPath: string): string =>
  createHash("sha256").update(transcriptPath, "utf8").digest("hex").slice(0, 32);

const SUBAGENT_STOP = "SubagentStop";

const agentIdOf = (record: Record<string, unknown>): string | undefined => {
  const agentId = record.agent_id ?? record.agentId;
  return typeof agentId === "string" && agentId.length > 0 && agentId.length <= 256 ? agentId : undefined;
};

const agentTranscriptPathOf = (record: Record<string, unknown>): unknown =>
  record.agent_transcript_path ?? record.agentTranscriptPath;

/**
 * The cursor scope of a `SubagentStop`: one cursor per subagent, beside the
 * session's own. An opaque digest of the agent id, never the id or a path.
 */
const subagentCursorScope = (payload: unknown): string | undefined => {
  const record = asRecord(payload);
  if (record === undefined || eventNameOf(record) !== SUBAGENT_STOP) {
    return undefined;
  }
  const agentId = agentIdOf(record);
  return agentId === undefined
    ? undefined
    : `agent-${createHash("sha256").update(agentId, "utf8").digest("hex").slice(0, 32)}`;
};

/**
 * The hook-runtime side of `providers.claudeCode.readTranscriptUsage`: attach
 * each turn's model and **summed** usage to its `Stop` / `StopFailure`, and each
 * subagent run's to its `SubagentStop`.
 *
 * The runtime keeps a byte cursor per session (state value `read-cursor`):
 *
 * - `SessionStart` records where the transcript ends now (0 when it does not
 *   exist yet), unless a cursor for the same transcript is already stored — a
 *   compaction restart must not skip the turn it interrupted.
 * - `Stop` sums every main-thread request from the cursor to the end, and moves
 *   the cursor there. That is the exact turn total: `usage_partial: false`.
 * - With no usable cursor (enabled mid-session, an expired or lost store, a
 *   different transcript), a range over the cap, or a transcript that shrank, it
 *   falls back to the last request in the bounded tail, attaches it with
 *   `usage_partial: true`, and moves the cursor to the end so the next turn is
 *   exact again.
 * - A timeout or an unreadable file attaches nothing and keeps the cursor, so
 *   the next turn's range includes this one: tokens are counted late, never
 *   twice and never lost.
 *
 * `SubagentStop` does the same over the subagent's own transcript
 * (`agent_transcript_path`), with a cursor of its own per subagent (see
 * {@link PayloadEnricher.cursorScope}), summing that agent's sidechain records.
 * A subagent with no cursor yet is read from the start of its file: the file is
 * that subagent's alone, so the first stop is its exact total, not a fallback.
 * The parent's cursor is never touched, and the parent's `Stop` never counts
 * sidechain records, so a subagent's requests are counted once, on its own
 * generation (issue #68).
 *
 * A payload that already carries `usage` (a wrapper attached it) is left as it
 * is, and the cursor moves past it so those tokens are not counted again.
 */
export const createClaudeTranscriptUsageEnricher = (
  options: ClaudeTranscriptUsageEnricherOptions = {},
): PayloadEnricher => {
  const fileSize = async (transcriptPath: string): Promise<number | "absent" | undefined> => {
    try {
      const info = await stat(transcriptPath);
      return info.isFile() ? info.size : undefined;
    } catch (thrown) {
      return (thrown as { code?: unknown } | undefined)?.code === "ENOENT" ? "absent" : undefined;
    }
  };

  const readOptions = (agentId: string | undefined): ReadClaudeTranscriptRangeOptions => ({
    ...(options.maxRangeBytes === undefined ? {} : { maxRangeBytes: options.maxRangeBytes }),
    ...(options.rangeTimeoutMillis === undefined ? {} : { rangeTimeoutMillis: options.rangeTimeoutMillis }),
    ...(agentId === undefined ? {} : { agentId }),
  });

  /**
   * Sum one transcript since `fromOffset` and attach the result, or fall back to
   * the bounded tail. `fromOffset` undefined means there is no usable cursor.
   */
  const attachSince = async (
    record: Record<string, unknown>,
    transcriptPath: string,
    fromOffset: number | undefined,
    agentId: string | undefined,
  ): Promise<PayloadEnrichment> => {
    const source = sourceDigest(transcriptPath);
    const attach = (
      model: string | undefined,
      usage: ClaudeUsage | undefined,
      partial: boolean,
    ): Record<string, unknown> => ({
      ...record,
      ...(record.model === undefined && model !== undefined ? { model } : {}),
      ...(usage === undefined ? {} : { usage, usage_partial: partial }),
    });

    if (fromOffset !== undefined) {
      const range = await readClaudeTranscriptRange(transcriptPath, fromOffset, readOptions(agentId));
      if (range.status === "found") {
        return {
          payload: attach(range.model, range.usage, false),
          cursor: { source, offset: range.endOffset },
          notes: [`summed ${String(range.requestCount)} request(s) since the last stop`],
        };
      }
      if (range.reason !== "truncated" && range.reason !== "over-cap") {
        return { payload: record, notes: [`transcript range not read (${range.reason}); cursor kept`] };
      }
    }

    // No usable cursor, or a range that cannot be summed within bounds.
    const tail = await boundedTail(transcriptPath, options, agentId);
    if (tail === TIMED_OUT || !("turn" in tail)) {
      return { payload: record, notes: [`transcript tail not read (${tail === TIMED_OUT ? "timeout" : tail.reason})`] };
    }
    const why = fromOffset === undefined ? "no cursor for this transcript" : "range not summable within bounds";
    return {
      payload: tail.turn.status === "found" ? attach(tail.turn.model, tail.turn.usage, true) : record,
      cursor: { source, offset: tail.endOffset },
      notes: [`${why}; attached the last request only (usage_partial)`],
    };
  };

  /** A wrapper attached usage: keep it, and move the cursor past what it covered. */
  const skipAttached = async (payload: unknown, transcriptPath: string): Promise<PayloadEnrichment> => {
    const size = await fileSize(transcriptPath);
    return typeof size === "number"
      ? { payload, cursor: { source: sourceDigest(transcriptPath), offset: size } }
      : { payload };
  };

  const enrich = async (input: {
    readonly payload: unknown;
    readonly cursor?: ReadCursor;
  }): Promise<PayloadEnrichment> => {
    const unchanged: PayloadEnrichment = { payload: input.payload };
    const record = asRecord(input.payload);
    if (record === undefined) {
      return unchanged;
    }
    const eventName = eventNameOf(record);

    if (eventName === SUBAGENT_STOP) {
      const agentTranscriptPath = agentTranscriptPathOf(record);
      const agentId = agentIdOf(record);
      if (agentId === undefined || !isTranscriptPath(agentTranscriptPath)) {
        return unchanged;
      }
      if (hasUsage(record)) {
        return skipAttached(input.payload, agentTranscriptPath);
      }
      const cursor = input.cursor?.source === sourceDigest(agentTranscriptPath) ? input.cursor : undefined;
      return attachSince(record, agentTranscriptPath, cursor?.offset ?? 0, agentId);
    }

    const transcriptPath = transcriptPathOf(record);
    if (typeof eventName !== "string" || !isTranscriptPath(transcriptPath)) {
      return unchanged;
    }
    const source = sourceDigest(transcriptPath);
    const cursor = input.cursor?.source === source ? input.cursor : undefined;

    if (eventName === "SessionStart") {
      if (cursor !== undefined) {
        return unchanged;
      }
      const size = await fileSize(transcriptPath);
      if (size === undefined) {
        return { ...unchanged, notes: ["transcript is not a readable regular file; no cursor recorded"] };
      }
      return { payload: input.payload, cursor: { source, offset: size === "absent" ? 0 : size } };
    }

    if (!STOP_EVENTS.has(eventName)) {
      return unchanged;
    }
    if (hasUsage(record)) {
      return skipAttached(input.payload, transcriptPath);
    }
    return attachSince(record, transcriptPath, cursor?.offset, undefined);
  };

  return Object.freeze({
    id: CLAUDE_TRANSCRIPT_USAGE_ENRICHER_ID,
    providerId: CLAUDE_CODE_PROVIDER_ID,
    cursorScope: subagentCursorScope,
    enrich,
  });
};
