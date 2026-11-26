import { createHash } from "node:crypto";
import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";

import type { PayloadEnricher, PayloadEnrichment, ReadCursor } from "../../runtime/ports.js";
import { CODEX_PROVIDER_ID } from "./version.js";
import { codexUsageSchema, type CodexUsage } from "./payload.js";

/**
 * The hook-runtime side of `providers.codex.readRolloutUsage`: attach the
 * session's token usage, read from Codex's own rollout file, to a Codex `Stop`.
 *
 * Why: Codex (observed on 0.163) puts no `usage` on any hook payload. The
 * counters exist only in the rollout JSONL Codex writes for every thread
 * (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<session-id>.jsonl`), on
 * `event_msg` records of `payload.type === "token_count"`:
 *
 * ```text
 * { "type": "event_msg", "payload": { "type": "token_count", "info": {
 *     "total_token_usage": { input_tokens, cached_input_tokens,
 *       cache_write_input_tokens, output_tokens, reasoning_output_tokens, total_tokens },
 *     "last_token_usage":  { ...same keys, the last request only } } } }
 * ```
 *
 * and, from 0.163, on `token_usage_record` records (`payload.thread_token_usage`,
 * the same running total). `total_token_usage` is the thread's running total:
 * exactly what the Codex adapter already takes `Stop.usage` to be (cumulative,
 * one series per session, diffed against the previous snapshot downstream). So
 * the enricher attaches the **last** snapshot, never a sum, which makes every
 * read exact on its own: a late read counts late, a missed read is caught up by
 * the next `Stop`, and nothing can be counted twice. That is also why no
 * `usage_partial` exists here.
 *
 * Not part of the Codex adapter, which gets no filesystem handle (ADR 0003). The
 * runtime keeps a byte cursor per session (`read-cursor` state value):
 *
 * - `SessionStart` records where the rollout ends now (0 when it does not exist
 *   yet), unless a cursor for the same file is stored already.
 * - `Stop` reads from the cursor to the end (bounded in bytes and time) and
 *   attaches the last snapshot found there; the cursor moves to the end. With no
 *   new snapshot since the cursor (no model request this turn, or Codex has not
 *   flushed it yet) it waits once, briefly, then attaches nothing: the next
 *   `Stop` carries the running total that includes it.
 * - No usable cursor, a range over the cap, or a file that shrank: the last
 *   snapshot in the bounded tail is attached instead (still exact, see above).
 * - A timeout or an unreadable file attaches nothing and keeps the cursor.
 *
 * The rollout is the one named by the payload's `transcript_path`. Only when a
 * payload names none, and the host gave a sessions root, is it looked up by
 * session id — in at most {@link ROLLOUT_LOOKUP_DAYS} date directories, by an
 * exact file-name match, never recursively.
 *
 * Nothing but numeric counters and a model id leaves this module.
 */

export const CODEX_ROLLOUT_USAGE_ENRICHER_ID = "codex-rollout-usage";

export const DEFAULT_CODEX_ROLLOUT_RANGE_BYTES = 8_388_608;
export const DEFAULT_CODEX_ROLLOUT_TAIL_BYTES = 1_048_576;
export const DEFAULT_CODEX_ROLLOUT_TIMEOUT_MILLIS = 500;
/** How long a `Stop` waits once for a snapshot Codex has not flushed yet. */
export const DEFAULT_CODEX_ROLLOUT_SETTLE_MILLIS = 150;
/** Date directories (today and earlier, local time) searched by session id. */
export const ROLLOUT_LOOKUP_DAYS = 7;

const MIN_BYTES = 65_536;
const MAX_RANGE_BYTES = 67_108_864;
const MAX_TAIL_BYTES = 16_777_216;
const MIN_TIMEOUT_MILLIS = 10;
const MAX_TIMEOUT_MILLIS = 5_000;
const MAX_SETTLE_MILLIS = 1_000;
const MAX_MODEL_ID_LENGTH = 256;
/** A date directory with more entries than this is not searched. */
const MAX_LOOKUP_DIR_ENTRIES = 20_000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;

export type CodexRolloutUsageEnricherOptions = {
  /** Most bytes one `Stop` reads from its cursor. Default 8 MiB, clamped to 64 KiB..64 MiB. */
  readonly maxRangeBytes?: number;
  /** Bytes read from the end when no cursor applies. Default 1 MiB, clamped to 64 KiB..16 MiB. */
  readonly maxTailBytes?: number;
  /** Budget for one enrichment, lookup and settle wait included. Default 500 ms, clamped to 10 ms..5 s. */
  readonly timeoutMillis?: number;
  /** Wait before the one re-read when no snapshot is found yet. Default 150 ms, 0 disables. */
  readonly settleMillis?: number;
  /**
   * `$CODEX_HOME/sessions`, for payloads that name no `transcript_path`. Absent,
   * such payloads are left alone. Supplied by the host, never read from the
   * environment here.
   */
  readonly sessionsRoot?: string;
  /** Clock for the date directories of the session-id lookup. */
  readonly now?: () => Date;
};

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

const isRolloutPath = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 4096 &&
  !value.includes("\0") &&
  path.isAbsolute(value) &&
  path.extname(value) === ".jsonl";

const sourceDigest = (rolloutPath: string): string =>
  createHash("sha256").update(rolloutPath, "utf8").digest("hex").slice(0, 32);

/** One running-total snapshot, with the model in force when it was written. */
export type CodexRolloutSnapshot = {
  readonly usage: CodexUsage;
  readonly model?: string;
};

const parseUsage = (value: unknown): CodexUsage | undefined => {
  const parsed = codexUsageSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  const usage = parsed.data;
  // A snapshot must at least say how many tokens went in and out.
  return usage.input_tokens === undefined || usage.output_tokens === undefined ? undefined : usage;
};

const modelOf = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_MODEL_ID_LENGTH ? value : undefined;

type LineFacts = { readonly usage?: CodexUsage; readonly model?: string };

/**
 * The running total or the model one rollout line carries, if any.
 *
 * Pre-filtered on substrings: most lines are messages, tool calls and their
 * output, and parsing them would spend the budget on records never used.
 */
const factsOf = (line: string): LineFacts | undefined => {
  const usageLine = line.includes('"token_count"') || line.includes('"token_usage_record"');
  const contextLine = line.includes('"turn_context"');
  if (!usageLine && !contextLine) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  const record = asRecord(parsed);
  const payload = asRecord(record?.payload);
  if (record === undefined || payload === undefined) {
    return undefined;
  }
  if (record.type === "turn_context") {
    const model = modelOf(payload.model);
    return model === undefined ? undefined : { model };
  }
  if (record.type === "event_msg" && payload.type === "token_count") {
    // 0.163 nests the counters under `info`; earlier releases put them on the payload.
    const info = asRecord(payload.info) ?? payload;
    const usage = parseUsage(info.total_token_usage);
    return usage === undefined ? undefined : { usage };
  }
  if (record.type === "token_usage_record") {
    const usage = parseUsage(payload.thread_token_usage);
    return usage === undefined ? undefined : { usage };
  }
  return undefined;
};

/** The last snapshot (and the last model named before or after it) in `lines`. */
const lastSnapshotIn = (lines: readonly string[]): CodexRolloutSnapshot | undefined => {
  let usage: CodexUsage | undefined;
  let model: string | undefined;
  for (const line of lines) {
    const facts = factsOf(line.trim());
    if (facts === undefined) {
      continue;
    }
    if (facts.model !== undefined) {
      model = facts.model;
    }
    if (facts.usage !== undefined) {
      usage = facts.usage;
    }
  }
  return usage === undefined ? undefined : { usage, ...(model === undefined ? {} : { model }) };
};

type FileHandle = Awaited<ReturnType<typeof open>>;

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

type ReadOutcome =
  | { readonly status: "found"; readonly snapshot?: CodexRolloutSnapshot; readonly endOffset: number }
  | { readonly status: "unavailable"; readonly reason: "not-a-file" | "unreadable" | "truncated" | "over-cap" };

/**
 * Read `[fromOffset, end)` (or the last `tailBytes` when `fromOffset` is
 * undefined) and return the last snapshot in its complete lines.
 */
const readRollout = async (
  rolloutPath: string,
  fromOffset: number | undefined,
  maxRangeBytes: number,
  tailBytes: number,
): Promise<ReadOutcome> => {
  let handle: FileHandle;
  try {
    const info = await stat(rolloutPath);
    if (!info.isFile()) {
      return { status: "unavailable", reason: "not-a-file" };
    }
    handle = await open(rolloutPath, "r");
  } catch {
    return { status: "unavailable", reason: "unreadable" };
  }
  try {
    const { size } = await handle.stat();
    let start: number;
    if (fromOffset === undefined) {
      start = Math.max(0, size - tailBytes);
    } else if (size < fromOffset) {
      return { status: "unavailable", reason: "truncated" };
    } else if (size - fromOffset > maxRangeBytes) {
      return { status: "unavailable", reason: "over-cap" };
    } else {
      start = fromOffset;
    }
    const bytes = await readBytes(handle, start, size - start);
    const lastNewline = bytes.lastIndexOf(0x0a);
    const endOffset = lastNewline < 0 ? start : start + lastNewline + 1;
    const lines = bytes.subarray(0, endOffset - start).toString("utf8").split("\n");
    // A tail that starts mid-file starts mid-line; that fragment is not a record.
    if (fromOffset === undefined && start > 0) {
      lines.shift();
    }
    const snapshot = lastSnapshotIn(lines);
    return { status: "found", ...(snapshot === undefined ? {} : { snapshot }), endOffset };
  } catch {
    return { status: "unavailable", reason: "unreadable" };
  } finally {
    await handle.close().catch(() => undefined);
  }
};

const pad = (value: number): string => String(value).padStart(2, "0");

/**
 * Find `rollout-*-<sessionId>.jsonl` in the last {@link ROLLOUT_LOOKUP_DAYS}
 * local date directories below `sessionsRoot`. Never recursive.
 */
const findRolloutBySessionId = async (
  sessionsRoot: string,
  sessionId: string,
  now: Date,
): Promise<string | undefined> => {
  if (!SESSION_ID_PATTERN.test(sessionId) || !path.isAbsolute(sessionsRoot)) {
    return undefined;
  }
  const suffix = `-${sessionId}.jsonl`;
  for (let back = 0; back < ROLLOUT_LOOKUP_DAYS; back += 1) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
    const dir = path.join(sessionsRoot, String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate()));
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    if (names.length > MAX_LOOKUP_DIR_ENTRIES) {
      continue;
    }
    const match = names.find((name) => name.startsWith("rollout-") && name.endsWith(suffix));
    if (match !== undefined) {
      return path.join(dir, match);
    }
  }
  return undefined;
};

const TIMED_OUT = Symbol("timed-out");

const withTimeout = async <T>(work: Promise<T>, timeoutMillis: number): Promise<T | typeof TIMED_OUT> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      resolve(TIMED_OUT);
    }, timeoutMillis);
    timer.unref();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

const sleep = (millis: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, millis).unref();
  });

const hasUsage = (record: Record<string, unknown>): boolean => record.usage !== undefined;

export const createCodexRolloutUsageEnricher = (options: CodexRolloutUsageEnricherOptions = {}): PayloadEnricher => {
  const maxRangeBytes = clamp(options.maxRangeBytes, DEFAULT_CODEX_ROLLOUT_RANGE_BYTES, MIN_BYTES, MAX_RANGE_BYTES);
  const maxTailBytes = clamp(options.maxTailBytes, DEFAULT_CODEX_ROLLOUT_TAIL_BYTES, MIN_BYTES, MAX_TAIL_BYTES);
  const timeoutMillis = clamp(
    options.timeoutMillis,
    DEFAULT_CODEX_ROLLOUT_TIMEOUT_MILLIS,
    MIN_TIMEOUT_MILLIS,
    MAX_TIMEOUT_MILLIS,
  );
  const settleMillis = clamp(options.settleMillis, DEFAULT_CODEX_ROLLOUT_SETTLE_MILLIS, 0, MAX_SETTLE_MILLIS);
  const now = options.now ?? ((): Date => new Date());

  const fileSize = async (rolloutPath: string): Promise<number | "absent" | undefined> => {
    try {
      const info = await stat(rolloutPath);
      return info.isFile() ? info.size : undefined;
    } catch (thrown) {
      return (thrown as { code?: unknown } | undefined)?.code === "ENOENT" ? "absent" : undefined;
    }
  };

  const resolveRollout = async (record: Record<string, unknown>): Promise<string | undefined> => {
    const named = record.transcript_path;
    if (named !== undefined && named !== null) {
      return isRolloutPath(named) ? named : undefined;
    }
    const sessionId = record.session_id;
    if (options.sessionsRoot === undefined || typeof sessionId !== "string") {
      return undefined;
    }
    return findRolloutBySessionId(options.sessionsRoot, sessionId, now());
  };

  const enrichWithin = async (input: {
    readonly payload: unknown;
    readonly cursor?: ReadCursor;
  }): Promise<PayloadEnrichment> => {
    const unchanged: PayloadEnrichment = { payload: input.payload };
    const record = asRecord(input.payload);
    const eventName = record?.hook_event_name;
    if (record === undefined || (eventName !== "SessionStart" && eventName !== "Stop")) {
      return unchanged;
    }
    const rolloutPath = await resolveRollout(record);
    if (rolloutPath === undefined) {
      return { ...unchanged, notes: ["no rollout named or found for this session"] };
    }
    const source = sourceDigest(rolloutPath);
    const cursor = input.cursor?.source === source ? input.cursor : undefined;

    if (eventName === "SessionStart") {
      if (cursor !== undefined) {
        return unchanged;
      }
      const size = await fileSize(rolloutPath);
      if (size === undefined) {
        return { ...unchanged, notes: ["rollout is not a readable regular file; no cursor recorded"] };
      }
      return { payload: input.payload, cursor: { source, offset: size === "absent" ? 0 : size } };
    }

    if (hasUsage(record)) {
      // Codex (or a wrapper) attached usage itself: keep it, move past it.
      const size = await fileSize(rolloutPath);
      return typeof size === "number" ? { payload: input.payload, cursor: { source, offset: size } } : unchanged;
    }

    const attach = (snapshot: CodexRolloutSnapshot): Record<string, unknown> => ({
      ...record,
      ...(record.model === undefined && snapshot.model !== undefined ? { model: snapshot.model } : {}),
      usage: snapshot.usage,
    });

    let read = await readRollout(rolloutPath, cursor?.offset, maxRangeBytes, maxTailBytes);
    if (read.status === "found" && read.snapshot === undefined && cursor !== undefined && settleMillis > 0) {
      // Codex writes the rollout from its own task; the turn's last `token_count`
      // can land a moment after `Stop` fires. One short wait, then give up: the
      // next `Stop`'s running total includes whatever this one missed.
      await sleep(settleMillis);
      read = await readRollout(rolloutPath, cursor.offset, maxRangeBytes, maxTailBytes);
    }
    if (read.status === "unavailable") {
      if (read.reason !== "truncated" && read.reason !== "over-cap") {
        return { ...unchanged, notes: [`rollout not read (${read.reason}); cursor kept`] };
      }
      read = await readRollout(rolloutPath, undefined, maxRangeBytes, maxTailBytes);
      if (read.status === "unavailable") {
        return { ...unchanged, notes: [`rollout tail not read (${read.reason})`] };
      }
    }
    const next = { source, offset: read.endOffset };
    if (read.snapshot === undefined) {
      return { payload: input.payload, cursor: next, notes: ["no token_count since the last stop"] };
    }
    return {
      payload: attach(read.snapshot),
      cursor: next,
      notes: [cursor === undefined ? "no cursor; attached the last running total in the tail" : "attached the running total"],
    };
  };

  const enrich = async (input: { readonly payload: unknown; readonly cursor?: ReadCursor }): Promise<PayloadEnrichment> => {
    try {
      const result = await withTimeout(enrichWithin(input), timeoutMillis);
      return result === TIMED_OUT ? { payload: input.payload, notes: ["rollout read timed out; cursor kept"] } : result;
    } catch {
      return { payload: input.payload, notes: ["rollout read failed; cursor kept"] };
    }
  };

  return Object.freeze({ id: CODEX_ROLLOUT_USAGE_ENRICHER_ID, providerId: CODEX_PROVIDER_ID, enrich });
};

/**
 * The last running-total snapshot in a Codex rollout, for a wrapping harness
 * that wants to attach `usage` itself. Bounded to the last `maxTailBytes`.
 * Never throws.
 */
export const readCodexRolloutUsage = async (
  rolloutPath: string,
  options: { readonly maxTailBytes?: number } = {},
): Promise<CodexRolloutSnapshot | undefined> => {
  if (!isRolloutPath(rolloutPath)) {
    return undefined;
  }
  const tail = clamp(options.maxTailBytes, DEFAULT_CODEX_ROLLOUT_TAIL_BYTES, MIN_BYTES, MAX_TAIL_BYTES);
  const read = await readRollout(rolloutPath, undefined, DEFAULT_CODEX_ROLLOUT_RANGE_BYTES, tail).catch(() => undefined);
  return read?.status === "found" ? read.snapshot : undefined;
};
