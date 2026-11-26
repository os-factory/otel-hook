import { open } from "node:fs/promises";
import * as path from "node:path";

import { z } from "zod";

import {
  checkResourceAttributeKey,
  MAX_RESOURCE_ATTRIBUTE_VALUE_LENGTH,
  MAX_RESOURCE_ATTRIBUTES,
} from "../config/resource-attributes.js";
import type { CanonicalEvent } from "../model/events.js";
import type { SessionContextReader, SessionContextSegment } from "./ports.js";

/**
 * Session context: attributes a harness wants on every record of one agent
 * session, for a window of time.
 *
 * A harness (HAR, or anything else) writes one JSON file per agent session:
 *
 * ```text
 * <dir>/<agent-tool>/<session-id>.json
 * { "version": 1, "agentTool": "claude_code", "sessionId": "…",
 *   "segments": [ { "from": "<ISO-8601>", "to": "<ISO-8601>" | null,
 *                   "reason": "launch", "attributes": { "k": "v" } } ] }
 * ```
 *
 * On every hook event the core reads the one file for the event's session,
 * picks the segment in force at each event's time, and stamps its attributes on
 * every record the event produces. otel-hook knows nothing about what the
 * attributes mean: it applies an attribute map. See `docs/session-context.md`.
 *
 * Fail-open throughout: a missing, unreadable, oversized, invalid, or
 * wrong-version file — or no segment in force — stamps nothing and never fails
 * the hook.
 */

/** The only file format version this build reads. Any other is ignored whole. */
export const SESSION_CONTEXT_FILE_VERSION = 1 as const;

/** Largest file read; anything bigger is ignored rather than truncated. */
export const DEFAULT_SESSION_CONTEXT_MAX_BYTES = 256 * 1024;

/** Ceiling on one read; a slow filesystem costs the stamp, never the hook. */
export const DEFAULT_SESSION_CONTEXT_BUDGET_MILLIS = 100;

/** Upper bound on segments considered in one file. */
export const MAX_SESSION_CONTEXT_SEGMENTS = 1024;

/**
 * otel-hook provider id → the agent-tool directory a harness writes under.
 *
 * The names are the ones HAR derives from the agent process it finds
 * (`claude_code`, `codex`, `cursor`). A provider absent from this table has no
 * session context: nothing is read for it.
 */
export const SESSION_CONTEXT_AGENT_TOOLS: Readonly<Record<string, string>> = Object.freeze({
  "claude-code": "claude_code",
  codex: "codex",
  cursor: "cursor",
  "gemini-cli": "gemini_cli",
  antigravity: "antigravity",
});

export const sessionContextAgentTool = (providerId: string): string | undefined =>
  Object.hasOwn(SESSION_CONTEXT_AGENT_TOOLS, providerId) ? SESSION_CONTEXT_AGENT_TOOLS[providerId] : undefined;

/**
 * A session id is used as a file name, so it must be one: no separators, no
 * `.`/`..`, nothing a path could be steered with. Real session ids (UUIDs) pass.
 */
const SESSION_FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export const isSessionContextFileName = (sessionId: string): boolean =>
  SESSION_FILE_NAME_PATTERN.test(sessionId) && !sessionId.includes("..");

/**
 * Where the context of one session lives, or `undefined` when the provider has
 * no agent-tool directory or the session id cannot be a file name.
 */
export const sessionContextFilePath = (
  dir: string,
  providerId: string,
  sessionId: string,
): string | undefined => {
  const tool = sessionContextAgentTool(providerId);
  if (tool === undefined || !isSessionContextFileName(sessionId) || !path.isAbsolute(dir)) {
    return undefined;
  }
  return path.join(dir, tool, `${sessionId}.json`);
};

/**
 * Keys a context may never set, whatever it says.
 *
 * - `factory.local.*`: the Factory Commits telemetry profile defines it as
 *   local-only (paths and the like); it must never reach a record.
 * - otel-hook's own record identity (`session.id`, `otelhook.*`, the hex trace
 *   ids, `gen_ai.conversation.id`): a context file describes the work a session
 *   does, it does not get to rename the session or forge its trace.
 * - Everything `checkResourceAttributeKey` refuses: malformed keys, the
 *   `service.*` exporter policy keys, and secret-like names.
 */
const RESERVED_CONTEXT_KEYS: ReadonlySet<string> = new Set([
  "session.id",
  "trace_id",
  "span_id",
  "parent_span_id",
  "gen_ai.conversation.id",
  "factory.local",
]);
const RESERVED_CONTEXT_PREFIXES: readonly string[] = Object.freeze(["factory.local.", "otelhook."]);

export const isReservedSessionContextKey = (key: string): boolean =>
  RESERVED_CONTEXT_KEYS.has(key) || RESERVED_CONTEXT_PREFIXES.some((prefix) => key.startsWith(prefix));

/**
 * Screen one segment's attribute map: primitive values only, bounded, and no
 * reserved or unsafe key. Dropped entries are dropped silently, one by one; the
 * rest of the map still applies.
 */
export const sanitizeSessionContextAttributes = (
  attributes: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string | number | boolean>> => {
  const kept: Record<string, string | number | boolean> = {};
  let count = 0;
  for (const [key, value] of Object.entries(attributes)) {
    if (count >= MAX_RESOURCE_ATTRIBUTES) {
      break;
    }
    if (checkResourceAttributeKey(key) !== undefined || isReservedSessionContextKey(key)) {
      continue;
    }
    if (typeof value === "string") {
      if (value.length > MAX_RESOURCE_ATTRIBUTE_VALUE_LENGTH) {
        continue;
      }
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        continue;
      }
    } else if (typeof value !== "boolean") {
      continue;
    }
    kept[key] = value;
    count += 1;
  }
  return kept;
};

const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

const isoInstantSchema = z
  .string()
  .max(64)
  .regex(ISO_INSTANT_PATTERN)
  .transform((value, ctx) => {
    const millis = Date.parse(value);
    if (!Number.isFinite(millis)) {
      ctx.issues.push({ code: "custom", input: value, message: "not a valid instant" });
      return z.NEVER;
    }
    return millis;
  });

const segmentSchema = z.object({
  from: isoInstantSchema,
  to: isoInstantSchema.nullable(),
  reason: z.string().max(256).optional(),
  attributes: z.record(z.string(), z.unknown()),
});

/**
 * The file format. Unknown extra fields are tolerated (a later minor revision
 * may add some); a different `version` is not, because its fields may mean
 * something else.
 */
const sessionContextFileSchema = z.object({
  version: z.literal(SESSION_CONTEXT_FILE_VERSION),
  agentTool: z.string().max(64).optional(),
  sessionId: z.string().max(256).optional(),
  segments: z.array(segmentSchema).max(MAX_SESSION_CONTEXT_SEGMENTS),
});

/**
 * Parse a decoded context file into screened segments.
 *
 * `expected` guards against a file that names another session or tool than the
 * one it was read for (a copy, a misplaced write): such a file applies to
 * nobody. Returns `undefined` for anything invalid; never throws.
 */
export const parseSessionContextFile = (
  value: unknown,
  expected?: { readonly agentTool?: string; readonly sessionId?: string },
): readonly SessionContextSegment[] | undefined => {
  const parsed = sessionContextFileSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  const file = parsed.data;
  if (
    (expected?.agentTool !== undefined && file.agentTool !== undefined && file.agentTool !== expected.agentTool) ||
    (expected?.sessionId !== undefined && file.sessionId !== undefined && file.sessionId !== expected.sessionId)
  ) {
    return undefined;
  }
  return file.segments.map((segment) => ({
    from: segment.from,
    to: segment.to,
    attributes: sanitizeSessionContextAttributes(segment.attributes),
  }));
};

/**
 * The segment in force at `at`: `from <= at` and (`to` is null or `at < to`).
 * Should a writer ever leave two overlapping, the one that started last wins,
 * because it is the more recent statement.
 */
export const segmentInForce = (
  segments: readonly SessionContextSegment[],
  at: number,
): SessionContextSegment | undefined => {
  let best: SessionContextSegment | undefined;
  for (const segment of segments) {
    if (segment.from <= at && (segment.to === null || at < segment.to)) {
      if (best === undefined || segment.from >= best.from) {
        best = segment;
      }
    }
  }
  return best;
};

/**
 * Stamp each event with the attributes of the segment in force at its own
 * `occurredAt`, and strip any `contextAttributes` an event already carried: only
 * this core step may set them. An event with no segment in force, or one whose
 * segment has no usable attribute, carries none.
 */
export const stampSessionContext = (
  events: readonly CanonicalEvent[],
  segments: readonly SessionContextSegment[] | undefined,
): readonly CanonicalEvent[] =>
  events.map((event) => {
    const { contextAttributes: _discarded, ...rest } = event;
    const segment = segments === undefined ? undefined : segmentInForce(segments, event.occurredAt);
    if (segment === undefined || Object.keys(segment.attributes).length === 0) {
      return _discarded === undefined ? event : (rest);
    }
    return { ...rest, contextAttributes: { ...segment.attributes } };
  });

export type DirectorySessionContextReaderOptions = {
  /** Absolute directory holding `<agent-tool>/<session-id>.json`. */
  readonly dir: string;
  readonly maxBytes?: number;
  readonly budgetMillis?: number;
};

const readBounded = async (file: string, maxBytes: number): Promise<string | undefined> => {
  let handle;
  try {
    handle = await open(file, "r");
  } catch {
    return undefined;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > maxBytes) {
      return undefined;
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) {
        break;
      }
      length += bytesRead;
    }
    if (length > maxBytes) {
      return undefined;
    }
    return buffer.subarray(0, length).toString("utf8");
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
};

/**
 * The filesystem {@link SessionContextReader}: one bounded read of one file per
 * call, never a directory scan. Never throws.
 */
export const createDirectorySessionContextReader = (
  options: DirectorySessionContextReaderOptions,
): SessionContextReader => {
  const maxBytes = options.maxBytes ?? DEFAULT_SESSION_CONTEXT_MAX_BYTES;
  const budgetMillis = options.budgetMillis ?? DEFAULT_SESSION_CONTEXT_BUDGET_MILLIS;

  const readOnce = async (
    providerId: string,
    sessionId: string,
  ): Promise<readonly SessionContextSegment[] | undefined> => {
    const file = sessionContextFilePath(options.dir, providerId, sessionId);
    if (file === undefined) {
      return undefined;
    }
    const text = await readBounded(file, maxBytes);
    if (text === undefined) {
      return undefined;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch {
      return undefined;
    }
    const agentTool = sessionContextAgentTool(providerId);
    return parseSessionContextFile(decoded, {
      ...(agentTool === undefined ? {} : { agentTool }),
      sessionId,
    });
  };

  return {
    read: async (request) => {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), budgetMillis);
        timer.unref?.();
      });
      try {
        return await Promise.race([
          readOnce(request.providerId, request.sessionId).catch(() => undefined),
          timeout,
        ]);
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }
    },
  };
};
