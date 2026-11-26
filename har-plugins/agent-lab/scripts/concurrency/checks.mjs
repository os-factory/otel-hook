/**
 * Wire-level checks for the concurrency scenarios: every span, log record and
 * metric point the collector received is mapped back to its own session and
 * compared with that session's context file (the record HAR kept of which
 * attempt the session worked on, when).
 */

import { STALE_RESOURCE } from "./agents.mjs";

export const CONTEXT_KEYS = Object.freeze([
  "factory.attempt.id",
  "factory.work_unit.id",
  "factory.slot.id",
  "vcs.repository.url.full",
  "vcs.ref.head.name",
]);
const ATTEMPT = "factory.attempt.id";

/** otel-hook provider id -> session context agent-tool directory. */
export const AGENT_TOOL_OF = Object.freeze({ "claude-code": "claude_code", codex: "codex" });

const toMillis = (value) => (value === null || value === undefined ? null : Date.parse(value));

/** Parsed segments of one context file: `[{ from, to, attributes }]` in millis. */
export const segmentsOf = (context) =>
  (context?.segments ?? []).map((segment) => ({
    from: toMillis(segment.from),
    to: toMillis(segment.to),
    attributes: segment.attributes ?? {},
  }));

export const segmentAt = (segments, at) => {
  let best;
  for (const segment of segments) {
    if (segment.from <= at && (segment.to === null || at < segment.to)) {
      if (best === undefined || segment.from >= best.from) best = segment;
    }
  }
  return best;
};

/**
 * Decode one collector into records keyed by their resource group, so the
 * Resource each batch was exported under can be checked against its records.
 */
export const decodeCollector = (collector) => {
  const records = [];
  let group = 0;
  const push = (signal, items, body) => {
    const byResource = new Map();
    for (const item of items) {
      const key = JSON.stringify(item.resourceAttributes);
      if (!byResource.has(key)) {
        group += 1;
        byResource.set(key, group);
      }
      records.push({ signal, group: byResource.get(key), body, ...normalize(signal, item) });
    }
  };
  collector.requests.forEach((request, body) => {
    if (request.responseStatus !== 200 || request.decoded === null || request.decoded === undefined) return;
    if (request.signal === "traces") push("span", request.decoded.spans, body);
    else if (request.signal === "logs") push("log", request.decoded.logs, body);
    else if (request.signal === "metrics") push("metric", request.decoded.metrics, body);
  });
  return records;
};

const normalize = (signal, item) => {
  const attributes = item.attributes ?? {};
  const providerId = attributes["otelhook.provider.id"];
  const sessionId = signal === "metric" ? attributes["session.id"] : attributes["otelhook.session.id"];
  const times =
    signal === "span"
      ? [item.startMillis, item.endMillis]
      : signal === "log"
        ? [Number(item.timeUnixNanos / 1_000_000n)]
        : [Number(BigInt(item.timeUnixNanos ?? 0) / 1_000_000n)];
  return {
    traceId: item.traceId,
    spanId: item.spanId,
    name: signal === "span" ? item.name : signal === "log" ? item.eventName || attributes["otelhook.event.type"] : item.name,
    eventId: attributes["otelhook.event.id"],
    eventType: attributes["otelhook.event.type"],
    providerId,
    sessionId,
    times,
    attributes,
    resourceAttributes: item.resourceAttributes ?? {},
  };
};

const contextOf = (record) => Object.fromEntries(CONTEXT_KEYS.filter((key) => key in record.attributes).map((key) => [key, record.attributes[key]]));

/**
 * The invariants every scenario must hold.
 *
 * - own: a record's context values all come from one segment of its own
 *   session's file (never another session's, never a mix of two segments);
 * - exact (logs): a log record carries the segment in force at its own time,
 *   and nothing when none was;
 * - edge (spans): a span carries the segment in force at its start or its end;
 * - after-to: no record emitted at or after a segment's `to` carries that
 *   segment's attempt unless another segment with that attempt is in force;
 * - resource: a batch's Resource keeps the stale environment value, or states
 *   exactly what every record of the batch states; never another session's.
 *
 * @param {ReturnType<typeof decodeCollector>} records
 * @param {Map<string, Array>} contexts key `${agentTool}/${sessionId}` -> segments
 */
export const checkInvariants = (records, contexts, { sessions, boundarySkewMillis = 100 } = {}) => {
  const failures = [];
  const fail = (message, record) => {
    if (failures.length < 40) {
      failures.push(`${message} [${record.signal} ${record.name ?? ""} ${record.providerId}/${String(record.sessionId)}]`);
    }
  };
  const counts = { records: 0, stamped: 0, unstamped: 0, foreign: 0, boundarySkew: 0, maxSkewMillis: 0, bySignal: {} };
  /**
   * A writer computes a boundary instant, then writes the file: a hook that
   * reads in between still sees the previous segment open, and stamps an event
   * that occurred just after the boundary with the previous segment. That is
   * the write latency, not a mix-up; counted (with its size) instead of failed
   * when the event lies within `boundarySkewMillis` after the boundary.
   */
  const isBoundarySkew = (segments, actual, at) => {
    const previous = segments.find((segment) => segment.attributes[ATTEMPT] === actual && segment.to !== null && at >= segment.to);
    if (previous === undefined || at - previous.to > boundarySkewMillis) return false;
    counts.boundarySkew += 1;
    counts.maxSkewMillis = Math.max(counts.maxSkewMillis, at - previous.to);
    return true;
  };
  const known = sessions === undefined ? undefined : new Set(sessions);
  const groups = new Map();

  for (const record of records) {
    const agentTool = AGENT_TOOL_OF[record.providerId];
    const key = `${agentTool}/${String(record.sessionId)}`;
    if (known !== undefined && !known.has(key)) continue;
    counts.records += 1;
    counts.bySignal[record.signal] = (counts.bySignal[record.signal] ?? 0) + 1;
    const segments = contexts.get(key) ?? [];
    const stamped = contextOf(record);
    const attempt = stamped[ATTEMPT];
    if (attempt === undefined || attempt === STALE_RESOURCE[ATTEMPT]) counts.unstamped += 1;
    else counts.stamped += 1;

    if (attempt !== undefined && attempt !== STALE_RESOURCE[ATTEMPT]) {
      const owners = segments.filter((segment) => segment.attributes[ATTEMPT] === attempt);
      if (owners.length === 0) {
        counts.foreign += 1;
        fail(`attempt ${attempt} is not one of the session's own segments`, record);
      } else {
        // Every stamped key must agree with one owning segment (no torn mix). A
        // tool event keeps its worktree target's branch (it beats context), so
        // the branch is not compared on records that name a target.
        const ignoreBranch = record.signal !== "metric" && record.attributes["otelhook.target.source"] !== undefined;
        const consistent = owners.some((segment) =>
          CONTEXT_KEYS.every(
            (k) =>
              (ignoreBranch && k === "vcs.ref.head.name") ||
              !(k in segment.attributes) ||
              stamped[k] === segment.attributes[k],
          ),
        );
        if (!consistent) fail(`context keys mix segments: ${JSON.stringify(stamped)}`, record);
      }
    }

    if (record.signal === "log") {
      const [at] = record.times;
      const expected = segmentAt(segments, at)?.attributes[ATTEMPT];
      const actual = attempt === STALE_RESOURCE[ATTEMPT] ? undefined : attempt;
      if (expected !== actual && !isBoundarySkew(segments, actual, at)) {
        fail(`log at ${String(at)} carries ${String(actual)}, segment in force says ${String(expected)}`, record);
      }
    } else if (record.signal === "span") {
      const allowed = new Set(record.times.map((at) => segmentAt(segments, at)?.attributes[ATTEMPT]));
      const actual = attempt === STALE_RESOURCE[ATTEMPT] ? undefined : attempt;
      if (!allowed.has(actual) && !isBoundarySkew(segments, actual, Math.max(...record.times))) {
        fail(`span carries ${String(actual)}, edges say ${JSON.stringify([...allowed])}`, record);
      }
    }

    // after-to: emitted (last time) at/after `to` of a closed segment with this attempt.
    if (attempt !== undefined && record.signal !== "metric") {
      const emittedAt = Math.max(...record.times);
      const closed = segments.filter((segment) => segment.attributes[ATTEMPT] === attempt && segment.to !== null);
      const open = segments.some((segment) => segment.attributes[ATTEMPT] === attempt && segment.from <= emittedAt && (segment.to === null || emittedAt < segment.to));
      const late = closed.filter((segment) => emittedAt >= segment.to);
      if (!open && late.length > 0 && record.signal === "log" && !late.every((segment) => emittedAt - segment.to <= boundarySkewMillis)) {
        fail(`emitted after its segment's to with the old attempt ${attempt}`, record);
      }
    }

    // Resource: per batch group.
    const groupKey = `${record.signal}:${String(record.group)}`;
    const entry = groups.get(groupKey) ?? { resource: record.resourceAttributes, attempts: new Set(), record };
    entry.attempts.add(attempt);
    groups.set(groupKey, entry);
    const resourceAttempt = record.resourceAttributes[ATTEMPT];
    if (resourceAttempt !== undefined && resourceAttempt !== STALE_RESOURCE[ATTEMPT]) {
      if (!segments.some((segment) => segment.attributes[ATTEMPT] === resourceAttempt)) {
        fail(`Resource attempt ${resourceAttempt} belongs to another session`, record);
      }
    }
  }

  let rewrittenGroups = 0;
  for (const entry of groups.values()) {
    const resourceAttempt = entry.resource[ATTEMPT];
    if (resourceAttempt !== undefined && resourceAttempt !== STALE_RESOURCE[ATTEMPT]) {
      rewrittenGroups += 1;
      if (entry.attempts.size !== 1 || !entry.attempts.has(resourceAttempt)) {
        fail(`Resource says ${resourceAttempt} but its records say ${JSON.stringify([...entry.attempts])}`, entry.record);
      }
    }
  }
  return { ok: failures.length === 0, failures, counts: { ...counts, resourceGroups: groups.size, rewrittenGroups } };
};

/** Records of one session. */
export const recordsOf = (records, providerId, sessionId) =>
  records.filter((record) => record.providerId === providerId && record.sessionId === sessionId);

export const attemptsOf = (records) =>
  [...new Set(records.map((record) => record.attributes[ATTEMPT]).filter((value) => value !== undefined))].sort();

/** Identity of a record across destinations: a span by its ids, a log by its event. */
export const recordIdentity = (record) =>
  record.signal === "span"
    ? `span:${String(record.traceId)}:${String(record.spanId)}`
    : record.signal === "log"
      ? `log:${String(record.eventId)}:${String(record.eventType ?? record.name)}`
      : `metric:${record.name}:${JSON.stringify(record.attributes)}:${record.times.join(",")}`;
