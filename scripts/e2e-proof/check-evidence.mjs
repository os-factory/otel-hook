#!/usr/bin/env node
/**
 * Evidence checker for the end-to-end proof runs (issue #56, docs/e2e-proof.md).
 *
 * Reads one or more capture directories written by `otlp-receiver.mjs` (the
 * first is the primary destination; any others are further destinations of the
 * same run) and checks the matrix rows that can be decided from the bytes that
 * reached the receiver. Rows that need a backend or a proof tool (Langfuse auth,
 * `git factory show`) are reported as `manual`, with whatever the capture can
 * contribute to them.
 *
 * Output: a machine-readable JSON result (stdout, or `--json-out`) and a
 * markdown snippet for the per-provider evidence comment (`--markdown`, or
 * `--markdown-out`). Exit code 0 when no check failed, 1 when one did, 2 on a
 * usage error.
 *
 * The result never echoes a forbidden string, an email address, or a full local
 * path: a privacy finding names the request, the attribute key and a masked
 * value, so the output can be pasted into a public issue.
 *
 * Attribute names below are the ones otel-hook exports (src/telemetry/
 * export-identity.ts, semconv.ts, log-records.ts) and the ones the Factory
 * Commits telemetry profile asks a launcher to put on the resource.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, inflateSync } from "node:zlib";

import { decodeOtlpRequest } from "./otlp-decode.mjs";

export const RESULT_SCHEMA = "otel-hook.e2e-proof.evidence/v1";

/** Matrix rows of issue #56, verbatim. */
export const ROWS = Object.freeze({
  session: "Session span with the launcher's `session.id`",
  profile: "Profile attributes (`factory.*`, `vcs.*`) on records",
  tools: "Tool spans",
  usage: "Token usage (delta vs cumulative correct)",
  logs: "Logs signal",
  auth: "`OTEL_EXPORTER_OTLP_*_HEADERS` auth to Langfuse",
  destinations: "Multiple destinations + spool replay",
  privacy: "Privacy: no `factory.local.*`, no paths, no account identity",
  proof: "Trace ↔ Factory Commits proof correlation",
});

/** Profile keys required on every record (resource or record attributes) by default. */
export const DEFAULT_PROFILE_KEYS = Object.freeze([
  "factory.work_unit.id",
  "vcs.repository.url.full",
  "vcs.ref.head.name",
]);

const ATTR = Object.freeze({
  sessionId: "session.id",
  providerSessionId: "otelhook.session.id",
  workUnitId: "factory.work_unit.id",
  toolName: "gen_ai.tool.name",
  operationName: "gen_ai.operation.name",
  spanPaired: "otelhook.span.paired",
  eventType: "otelhook.event.type",
  eventId: "otelhook.event.id",
  logSignal: "otelhook.log.signal",
  temporality: "otelhook.usage.temporality",
  resetDetected: "otelhook.usage.reset_detected",
  agentVersion: "otelhook.agent.version",
  providerVersion: "otelhook.provider.version",
  providerId: "otelhook.provider.id",
});

/** `--expect-usage` keys to `gen_ai.usage.*` attributes. */
export const USAGE_KEYS = Object.freeze({
  input: "gen_ai.usage.input_tokens",
  output: "gen_ai.usage.output_tokens",
  cache_read: "gen_ai.usage.cache_read.input_tokens",
  cache_creation: "gen_ai.usage.cache_creation.input_tokens",
  reasoning: "gen_ai.usage.reasoning.output_tokens",
});

const OTEL_HOOK_SCOPE = "@osfactory/otel-hook";

// ---------------------------------------------------------------------------
// Loading a capture
// ---------------------------------------------------------------------------

const REQUEST_FILE = /^(\d{4,})-(traces|logs|unknown)\.json$/;

const decompress = (body, encoding) => {
  const value = String(encoding ?? "").toLowerCase();
  if (body.length === 0 || value === "" || value === "identity") {
    return body;
  }
  if (value === "gzip") {
    return gunzipSync(body);
  }
  if (value === "deflate") {
    return inflateSync(body);
  }
  throw new Error(`unsupported content-encoding ${value}`);
};

/**
 * Load a capture directory. Records are re-decoded from the raw `.body` files,
 * not taken from the metadata's `decoded` copy: the bytes are the evidence.
 */
export const loadCapture = async (captureDir, label = path.basename(captureDir)) => {
  const names = (await readdir(captureDir)).filter((name) => REQUEST_FILE.test(name)).sort();
  const requests = [];
  for (const name of names) {
    const meta = JSON.parse(await readFile(path.join(captureDir, name), "utf8"));
    const stem = name.slice(0, -".json".length);
    let raw;
    try {
      raw = await readFile(path.join(captureDir, `${stem}.body`));
    } catch {
      raw = Buffer.alloc(0);
    }
    const match = REQUEST_FILE.exec(name);
    const signal = meta.signal ?? match?.[2] ?? "unknown";
    const status = Number(meta.responseStatus ?? 200);
    let body = raw;
    let decoded = { spans: [], logs: [] };
    let decodeError;
    try {
      body = decompress(raw, meta.contentEncoding);
      decoded = decodeOtlpRequest({ signal, contentType: meta.contentType, body });
    } catch (error) {
      decodeError = error instanceof Error ? error.message : String(error);
    }
    requests.push({
      seq: Number(meta.seq ?? match?.[1] ?? requests.length + 1),
      signal,
      path: String(meta.path ?? ""),
      status,
      delivered: status >= 200 && status < 300,
      injectedFailure: meta.injectedFailure === true,
      empty: raw.length === 0,
      bytes: raw.length,
      headers: meta.headers ?? {},
      body,
      spans: decoded.spans,
      logs: decoded.logs,
      decodeError,
    });
  }
  requests.sort((left, right) => left.seq - right.seq);
  return { label, requests };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const spanKey = (span) => `span:${span.traceId}/${span.spanId}`;
const logKey = (log) =>
  `log:${String(log.attributes[ATTR.eventId] ?? "")}|${String(log.attributes[ATTR.logSignal] ?? "")}|` +
  `${log.eventName}|${String(log.attributes[ATTR.eventType] ?? "")}|${String(log.timeUnixNanos)}`;

const merged = (record) => ({ ...record.resourceAttributes, ...record.attributes });

const recordTimeMillis = (record) =>
  record.kind === "span" ? record.endMillis : Number(BigInt(record.timeUnixNanos ?? 0n) / 1_000_000n);

/** Unique records from delivered (2xx) requests, first delivery wins, plus duplicate counts. */
const deliveredRecords = (capture) => {
  const seen = new Map();
  let duplicates = 0;
  for (const request of capture.requests) {
    if (!request.delivered) {
      continue;
    }
    for (const span of request.spans) {
      const key = spanKey(span);
      if (seen.has(key)) {
        duplicates += 1;
        continue;
      }
      seen.set(key, { ...span, kind: "span", seq: request.seq });
    }
    for (const log of request.logs) {
      const key = logKey(log);
      if (seen.has(key)) {
        duplicates += 1;
        continue;
      }
      seen.set(key, { ...log, kind: "log", seq: request.seq });
    }
  }
  return { records: [...seen.values()], keys: new Set(seen.keys()), duplicates };
};

const countBy = (values) => {
  const counts = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
};

const formatCounts = (counts) =>
  Object.entries(counts)
    .map(([name, count]) => `${name}×${String(count)}`)
    .join(", ");

const short = (value, length = 16) => {
  const text = String(value);
  return text.length > length ? `${text.slice(0, length)}…` : text;
};

const maskPath = (value) => {
  const text = String(value);
  if (/^[A-Za-z]:\\/.test(text)) {
    return `${text.slice(0, 3)}…`;
  }
  const first = text.split("/").filter((part) => part.length > 0)[0] ?? "";
  return `/${first}/…`;
};

const maskEmail = (value) => {
  const [local = "", domain = ""] = String(value).split("@");
  const tld = domain.split(".").at(-1) ?? "";
  return `${local.slice(0, 1)}***@***.${tld}`;
};

const check = (id, row, status, details) => ({ id, row, status, details });

const isNonNegativeInteger = (value) => typeof value === "number" && Number.isInteger(value) && value >= 0;

// ---------------------------------------------------------------------------
// Privacy patterns
// ---------------------------------------------------------------------------

/** A string attribute value that is an absolute local path. */
const ABSOLUTE_PATH_VALUE = /^(?:\/[^/\s]+\/|[A-Za-z]:\\|~\/|file:\/\/)/;
/** Home-directory paths anywhere in the raw bytes. */
const RAW_HOME_PATH = /(?:\/home\/|\/Users\/|\/root\/|[A-Za-z]:\\\\?Users\\)[A-Za-z0-9._-]+/g;
const RAW_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
/** `scheme://user[:pass]@host`: credentials in a URL. */
const RAW_URL_USERINFO = /\b[a-z][a-z0-9+.-]*:\/\/[A-Za-z0-9._~%!$&'()*+,;=:-]+@/gi;
/** Attribute keys that name an account holder rather than a session. */
const IDENTITY_KEY = /^(?:enduser\.|user\.(?:email|name|full_name|id|hash)$)|(?:^|[._])e?mail(?:$|[._])/i;
/** Local parts that are protocol users, not people (`git@host:org/repo`). */
const SERVICE_EMAIL_LOCAL = new Set(["git", "noreply", "no-reply"]);

const stringValues = (record) => {
  const values = [];
  for (const [scope, attributes] of [
    ["resource", record.resourceAttributes],
    ["record", record.attributes],
  ]) {
    for (const [key, value] of Object.entries(attributes ?? {})) {
      if (typeof value === "string") {
        values.push({ scope, key, value });
      }
    }
  }
  if (typeof record.body === "string") {
    values.push({ scope: "record", key: "<log body>", value: record.body });
  }
  if (typeof record.name === "string") {
    values.push({ scope: "record", key: "<span name>", value: record.name });
  }
  return values;
};

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

const checkCaptureIntegrity = (capture, delivered) => {
  const details = [];
  const failures = capture.requests.filter((request) => request.decodeError !== undefined);
  const empty = capture.requests.filter((request) => request.empty);
  details.push(
    `${String(capture.requests.length)} requests (${formatCounts(countBy(capture.requests.map((request) => request.signal))) || "none"})`,
  );
  if (empty.length > 0) {
    details.push(
      `empty-body requests: ${empty.map((request) => `#${String(request.seq)} ${request.signal}`).join(", ")} (see #54)`,
    );
  }
  if (delivered.duplicates > 0) {
    details.push(`${String(delivered.duplicates)} duplicate record(s) across delivered requests`);
  }
  for (const request of failures) {
    details.push(`request #${String(request.seq)} did not decode: ${request.decodeError}`);
  }
  if (capture.requests.length === 0) {
    return check("capture-integrity", null, "fail", ["capture holds no requests"]);
  }
  return check("capture-integrity", null, failures.length > 0 ? "fail" : "pass", details);
};

const checkSession = (records, options) => {
  const sessionSpans = records.filter((record) => record.kind === "span" && record.name === "session");
  if (sessionSpans.length === 0) {
    return check("session-span", ROWS.session, "fail", [
      `no span named \`session\` was delivered (spans: ${formatCounts(countBy(records.filter((record) => record.kind === "span").map((record) => record.name))) || "none"})`,
    ]);
  }
  const details = [];
  const resourceIds = [...new Set(records.map((record) => record.resourceAttributes[ATTR.sessionId]).filter((id) => typeof id === "string"))];
  const expected = options.sessionId;
  if (expected === undefined) {
    const withResourceId = sessionSpans.filter((span) => typeof span.resourceAttributes[ATTR.sessionId] === "string");
    details.push("launcher session id not supplied (`--session-id`); only its presence on the resource was checked");
    details.push(`resource \`session.id\` values: ${resourceIds.map((id) => `\`${id}\``).join(", ") || "none"}`);
    return check("session-span", ROWS.session, withResourceId.length > 0 && resourceIds.length === 1 ? "pass" : "fail", details);
  }
  const matching = sessionSpans.filter(
    (span) => span.resourceAttributes[ATTR.sessionId] === expected || span.attributes[ATTR.sessionId] === expected,
  );
  const carrying = records.filter((record) => merged(record)[ATTR.sessionId] === expected || record.resourceAttributes[ATTR.sessionId] === expected);
  const span = matching[0];
  if (span !== undefined) {
    const where = [
      span.resourceAttributes[ATTR.sessionId] === expected ? "resource" : undefined,
      span.attributes[ATTR.sessionId] === expected ? "span attribute" : undefined,
    ].filter(Boolean);
    details.push(`session span \`${span.spanId}\` in trace \`${span.traceId}\` carries \`session.id\`=\`${expected}\` (${where.join(" + ")})`);
    const providerId = span.attributes[ATTR.providerSessionId];
    if (typeof providerId === "string") {
      details.push(`provider session id (\`otelhook.session.id\`): \`${providerId}\``);
    }
  } else {
    details.push(`no session span carries \`session.id\`=\`${expected}\` (resource values: ${resourceIds.map((id) => `\`${id}\``).join(", ") || "none"})`);
  }
  details.push(`${String(carrying.length)}/${String(records.length)} delivered records carry the launcher id`);
  return check("session-span", ROWS.session, span !== undefined && carrying.length === records.length ? "pass" : "fail", details);
};

const checkProfile = (records, options) => {
  const required = options.requireAttributes ?? DEFAULT_PROFILE_KEYS;
  if (records.length === 0) {
    return check("profile-attributes", ROWS.profile, "fail", ["no delivered records"]);
  }
  const details = [];
  const failures = [];
  const keysSeen = { resource: new Set(), record: new Set() };
  for (const record of records) {
    for (const [scope, attributes] of [
      ["resource", record.resourceAttributes],
      ["record", record.attributes],
    ]) {
      for (const key of Object.keys(attributes)) {
        if ((key.startsWith("factory.") && !key.startsWith("factory.local.")) || key.startsWith("vcs.")) {
          keysSeen[scope].add(key);
        }
      }
    }
  }
  const missingFamily = (prefix) =>
    records.filter((record) =>
      !Object.keys(merged(record)).some((key) => key.startsWith(prefix) && !key.startsWith("factory.local.")),
    ).length;
  for (const prefix of ["factory.", "vcs."]) {
    const missing = missingFamily(prefix);
    if (missing > 0) {
      failures.push(`${String(missing)}/${String(records.length)} records carry no \`${prefix}*\` attribute`);
    }
  }
  for (const key of required) {
    const missing = records.filter((record) => merged(record)[key] === undefined).length;
    if (missing > 0) {
      failures.push(`\`${key}\` missing on ${String(missing)}/${String(records.length)} records`);
    }
  }
  if (options.workUnitId !== undefined) {
    const wrong = records.filter((record) => merged(record)[ATTR.workUnitId] !== options.workUnitId).length;
    if (wrong > 0) {
      failures.push(`\`factory.work_unit.id\` is not \`${options.workUnitId}\` on ${String(wrong)}/${String(records.length)} records`);
    } else {
      details.push(`\`factory.work_unit.id\`=\`${options.workUnitId}\` on every record`);
    }
  }
  details.push(`on the resource: ${[...keysSeen.resource].sort().map((key) => `\`${key}\``).join(", ") || "none"}`);
  details.push(`on record attributes: ${[...keysSeen.record].sort().map((key) => `\`${key}\``).join(", ") || "none"}`);
  return check("profile-attributes", ROWS.profile, failures.length === 0 ? "pass" : "fail", [...failures, ...details]);
};

const checkTools = (records, options) => {
  const tools = records.filter((record) => record.kind === "span" && typeof record.attributes[ATTR.toolName] === "string");
  const names = countBy(tools.map((span) => span.attributes[ATTR.toolName]));
  const details = [`tool spans: ${formatCounts(names) || "none"}`];
  const unpaired = tools.filter((span) => span.attributes[ATTR.spanPaired] === false).length;
  if (unpaired > 0) {
    details.push(`${String(unpaired)} tool span(s) unpaired (start or end edge missing)`);
  }
  const missing = (options.expectTools ?? []).filter((name) => names[name] === undefined);
  if (missing.length > 0) {
    details.unshift(`expected tool(s) without a span: ${missing.map((name) => `\`${name}\``).join(", ")}`);
  }
  return check("tool-spans", ROWS.tools, tools.length > 0 && missing.length === 0 ? "pass" : "fail", details);
};

const isGenerationSpan = (record) =>
  record.kind === "span" && (record.name.startsWith("generation") || record.attributes[ATTR.operationName] === "chat");

const checkUsage = (records, options) => {
  const usage = records.filter(
    (record) =>
      record.attributes[USAGE_KEYS.input] !== undefined || record.attributes[USAGE_KEYS.output] !== undefined,
  );
  if (usage.length === 0) {
    return check("token-usage", ROWS.usage, "fail", ["no delivered record carries `gen_ai.usage.*`"]);
  }
  const failures = [];
  const details = [];
  const temporalities = countBy(usage.map((record) => String(record.attributes[ATTR.temporality] ?? "<missing>")));
  details.push(`${String(usage.length)} usage-bearing record(s); temporality: ${formatCounts(temporalities)}`);
  for (const record of usage) {
    const temporality = record.attributes[ATTR.temporality];
    if (temporality !== "delta" && temporality !== "cumulative") {
      failures.push(`${record.kind} \`${record.kind === "span" ? record.name : record.eventName || record.attributes[ATTR.eventType]}\` has usage without a valid \`otelhook.usage.temporality\``);
    }
    for (const attribute of Object.values(USAGE_KEYS)) {
      const value = record.attributes[attribute];
      if (value !== undefined && !isNonNegativeInteger(value)) {
        failures.push(`\`${attribute}\`=${JSON.stringify(value)} is not a non-negative integer`);
      }
    }
  }
  const resets = usage.filter((record) => record.attributes[ATTR.resetDetected] === true).length;
  if (resets > 0) {
    details.push(`${String(resets)} record(s) flagged \`otelhook.usage.reset_detected\``);
  }

  // A cumulative series must never go down (unless the exporter flagged a reset).
  const series = new Map();
  for (const record of usage.filter((entry) => entry.attributes[ATTR.temporality] === "cumulative")) {
    const session = String(record.attributes[ATTR.providerSessionId] ?? record.attributes[ATTR.sessionId] ?? "");
    // A running total is session-lifetime, so every cumulative record of one
    // session and signal belongs to one series, whatever span or event carries it.
    const key = `${record.kind}|${session}`;
    const list = series.get(key) ?? [];
    list.push(record);
    series.set(key, list);
  }
  for (const [key, list] of series) {
    list.sort((left, right) => recordTimeMillis(left) - recordTimeMillis(right));
    for (let index = 1; index < list.length; index += 1) {
      const previous = list[index - 1];
      const current = list[index];
      if (current.attributes[ATTR.resetDetected] === true) {
        continue;
      }
      for (const [name, attribute] of Object.entries(USAGE_KEYS)) {
        const before = previous.attributes[attribute];
        const after = current.attributes[attribute];
        if (typeof before === "number" && typeof after === "number" && after < before) {
          failures.push(`cumulative ${name} went down (${String(before)} → ${String(after)}) in the ${key.split("|")[0]} series of session \`${key.split("|")[1] ?? ""}\``);
        }
      }
    }
  }

  // Session totals from generation spans: deltas are summed; a session whose
  // generation spans carry running totals contributes its largest total once.
  // Summing running totals is exactly the double count this row guards against.
  const generations = usage.filter((record) => isGenerationSpan(record));
  const deltaGenerations = generations.filter((record) => record.attributes[ATTR.temporality] === "delta");
  const cumulativeGenerations = generations.filter((record) => record.attributes[ATTR.temporality] === "cumulative");
  const sessionOf = (record) => String(record.attributes[ATTR.providerSessionId] ?? record.attributes[ATTR.sessionId] ?? "");
  const deltaSessions = new Set(deltaGenerations.map(sessionOf));
  const sums = {};
  const totals = {};
  for (const [name, attribute] of Object.entries(USAGE_KEYS)) {
    const numberOf = (record) => (typeof record.attributes[attribute] === "number" ? record.attributes[attribute] : 0);
    sums[name] = deltaGenerations.reduce((total, record) => total + numberOf(record), 0);
    const largest = new Map();
    for (const record of cumulativeGenerations.filter((entry) => !deltaSessions.has(sessionOf(entry)))) {
      largest.set(sessionOf(record), Math.max(largest.get(sessionOf(record)) ?? 0, numberOf(record)));
    }
    totals[name] = sums[name] + [...largest.values()].reduce((total, value) => total + value, 0);
  }
  details.push(
    `generation spans: ${String(deltaGenerations.length)} delta, ${String(cumulativeGenerations.length)} cumulative; ` +
      `session totals ${Object.entries(totals).map(([name, value]) => `${name}=${String(value)}`).join(", ")}`,
  );
  let determinable = false;
  if (options.expectUsage !== undefined) {
    determinable = true;
    const mismatches = [];
    for (const [name, expected] of Object.entries(options.expectUsage)) {
      if (totals[name] !== expected) {
        mismatches.push(`exported ${name} tokens ${String(totals[name])} ≠ expected ${String(expected)} (from the agent's own report)`);
      }
    }
    failures.push(...mismatches);
    if (mismatches.length === 0) {
      details.push(`exported totals match the agent-reported totals (${Object.entries(options.expectUsage).map(([name, value]) => `${name}=${String(value)}`).join(", ")})`);
    }
  }
  const cumulative = usage.filter((record) => record.attributes[ATTR.temporality] === "cumulative");
  if (cumulative.length > 0 && deltaGenerations.length > 0) {
    determinable = true;
    for (const [name, attribute] of [["input", USAGE_KEYS.input], ["output", USAGE_KEYS.output]]) {
      const total = Math.max(...cumulative.map((record) => (typeof record.attributes[attribute] === "number" ? record.attributes[attribute] : 0)));
      if (sums[name] > total) {
        failures.push(`summed delta ${name} tokens ${String(sums[name])} exceed the largest cumulative total ${String(total)}: a running total was probably exported as a delta`);
      } else {
        details.push(`delta ${name} sum ${String(sums[name])} ≤ cumulative total ${String(total)}`);
      }
    }
  }
  if (!determinable) {
    details.push("delta vs cumulative cross-check not determinable from the capture alone: pass `--expect-usage` with the agent's own totals");
  }
  return check("token-usage", ROWS.usage, failures.length === 0 ? "pass" : "fail", [...failures, ...details]);
};

const checkLogs = (records) => {
  const logs = records.filter((record) => record.kind === "log");
  const typed = logs.filter((record) => typeof record.attributes[ATTR.eventType] === "string");
  if (typed.length === 0) {
    return check("logs-signal", ROWS.logs, "fail", [`no delivered log record with \`otelhook.event.type\` (log records: ${String(logs.length)})`]);
  }
  const traceIds = new Set(records.filter((record) => record.kind === "span").map((span) => span.traceId));
  const correlated = typed.filter((record) => traceIds.has(record.traceId)).length;
  return check("logs-signal", ROWS.logs, "pass", [
    `${String(typed.length)} log record(s): ${formatCounts(countBy(typed.map((record) => record.attributes[ATTR.eventType])))}`,
    `${String(correlated)}/${String(typed.length)} share a trace id with a delivered span`,
  ]);
};

const checkPrivacy = (captures, options) => {
  const failures = [];
  const note = (message) => {
    if (!failures.includes(message)) {
      failures.push(message);
    }
  };
  const forbid = (options.forbid ?? []).filter((value) => value.length > 0);
  let inspected = 0;
  for (const capture of captures) {
    const where = (request) => `${captures.length > 1 ? `${capture.label} ` : ""}request #${String(request.seq)}`;
    for (const request of capture.requests) {
      inspected += 1;
      for (const record of [...request.spans, ...request.logs]) {
        for (const { scope, key } of [
          ...Object.keys(record.resourceAttributes).map((key) => ({ scope: "resource", key })),
          ...Object.keys(record.attributes).map((key) => ({ scope: "record", key })),
        ]) {
          if (key.startsWith("factory.local.")) {
            note(`\`${key}\` exported (${scope}) in ${where(request)}`);
          }
          if (IDENTITY_KEY.test(key)) {
            note(`account-identity key \`${key}\` exported (${scope}) in ${where(request)}`);
          }
        }
        for (const { scope, key, value } of stringValues(record)) {
          if (ABSOLUTE_PATH_VALUE.test(value)) {
            note(`absolute path in \`${key}\` (${scope}) in ${where(request)}: \`${maskPath(value)}\``);
          }
        }
      }
      const latin1 = request.body.toString("latin1");
      if (latin1.includes("factory.local.")) {
        note(`\`factory.local.\` bytes in ${where(request)}`);
      }
      for (const match of latin1.matchAll(RAW_HOME_PATH)) {
        note(`home-directory path in ${where(request)}: \`${maskPath(match[0].replace(/\\\\/g, "\\"))}\``);
      }
      for (const match of latin1.matchAll(RAW_EMAIL)) {
        const local = match[0].split("@")[0] ?? "";
        if (!SERVICE_EMAIL_LOCAL.has(local.toLowerCase())) {
          note(`email-shaped value in ${where(request)}: \`${maskEmail(match[0])}\``);
        }
      }
      if ((latin1.match(RAW_URL_USERINFO) ?? []).length > 0) {
        note(`URL with embedded credentials or user in ${where(request)}`);
      }
      forbid.forEach((value, index) => {
        if (request.body.includes(Buffer.from(value, "utf8"))) {
          note(`forbidden value #${String(index + 1)} (${String(value.length)} chars) found in ${where(request)}`);
        }
      });
    }
  }
  const details = [
    `${String(inspected)} request bodies inspected (delivered and rejected, every destination)`,
    `forbidden values supplied: ${String(forbid.length)}`,
  ];
  return check("privacy", ROWS.privacy, failures.length === 0 ? "pass" : "fail", [...failures, ...details]);
};

const checkSpoolReplay = (capture) => {
  const rejected = capture.requests.filter((request) => !request.delivered && request.signal !== "unknown");
  if (rejected.length === 0) {
    return check("spool-replay", ROWS.destinations, "skip", [
      "no rejected request in the capture: run the receiver with `--fail-first N` to exercise spool replay",
    ]);
  }
  const missing = [];
  let total = 0;
  for (const request of rejected) {
    const later = capture.requests.filter((candidate) => candidate.delivered && candidate.seq > request.seq);
    const laterKeys = new Set(later.flatMap((candidate) => [...candidate.spans.map(spanKey), ...candidate.logs.map(logKey)]));
    for (const key of [...request.spans.map(spanKey), ...request.logs.map(logKey)]) {
      total += 1;
      if (!laterKeys.has(key)) {
        missing.push(`#${String(request.seq)}`);
      }
    }
  }
  const details = [
    `${String(rejected.length)} rejected request(s) (statuses ${[...new Set(rejected.map((request) => request.status))].join(", ")}) holding ${String(total)} record(s)`,
  ];
  if (total === 0) {
    details.push("the rejected requests held no records (empty bodies), so there was nothing to replay");
    return check("spool-replay", ROWS.destinations, "skip", details);
  }
  if (missing.length > 0) {
    details.unshift(`${String(missing.length)} record(s) from rejected request(s) ${[...new Set(missing)].join(", ")} never arrived in a later successful request`);
  } else {
    details.push("every rejected record arrived later in a successful request");
  }
  return check("spool-replay", ROWS.destinations, missing.length === 0 ? "pass" : "fail", details);
};

const checkDestinations = (captures, deliveredSets) => {
  if (captures.length < 2) {
    return check("multi-destination", ROWS.destinations, "skip", [
      "one capture directory: pass a second destination's capture to compare (needs #54)",
    ]);
  }
  const [first, ...others] = deliveredSets;
  const details = [];
  let same = true;
  others.forEach((set, index) => {
    const onlyFirst = [...first.keys].filter((key) => !set.keys.has(key)).length;
    const onlyOther = [...set.keys].filter((key) => !first.keys.has(key)).length;
    const label = captures[index + 1]?.label ?? `#${String(index + 2)}`;
    if (onlyFirst > 0 || onlyOther > 0) {
      same = false;
      details.push(`\`${label}\` differs from \`${captures[0]?.label ?? ""}\`: ${String(onlyFirst)} record(s) only in the first, ${String(onlyOther)} only in \`${label}\``);
    } else {
      details.push(`\`${label}\` received the same ${String(set.keys.size)} record(s) as \`${captures[0]?.label ?? ""}\``);
    }
  });
  return check("multi-destination", ROWS.destinations, same && first.keys.size > 0 ? "pass" : "fail", details);
};

const checkAuth = (capture) => {
  const schemes = countBy(
    capture.requests.map((request) => {
      const value = request.headers.authorization;
      if (typeof value !== "string") {
        return "none";
      }
      const scheme = /^<redacted:([^>]+)>$/.exec(value)?.[1];
      return scheme ?? "present";
    }),
  );
  return check("headers-auth", ROWS.auth, "manual", [
    `Authorization header at the receiver: ${formatCounts(schemes)} (value never recorded)`,
    "acceptance by Langfuse needs the Langfuse trace link or screenshot",
  ]);
};

const checkProof = (records) => {
  const sessionTraces = [...new Set(records.filter((record) => record.kind === "span" && record.name === "session").map((span) => span.traceId))];
  return check("trace-proof", ROWS.proof, "manual", [
    `session trace id(s): ${sessionTraces.map((id) => `\`${id}\``).join(", ") || "none"}`,
    "needs `git factory show <commit>` output and the trace link (docs/e2e-proof.md)",
  ]);
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Check one run's captures.
 *
 * @param {Array<{label: string, requests: object[]}>} captures first = primary destination
 * @param {object} [options]
 * @param {string} [options.provider] provider id, for the report only
 * @param {string} [options.sessionId] the launcher's session id
 * @param {string} [options.workUnitId] the bound work unit id
 * @param {string[]} [options.requireAttributes] profile keys every record must carry
 * @param {string[]} [options.expectTools] tool names that must have a span
 * @param {Record<string, number>} [options.expectUsage] agent-reported totals, keys of USAGE_KEYS
 * @param {string[]} [options.forbid] strings that must not appear in any body
 */
export const checkEvidence = (captures, options = {}) => {
  if (captures.length === 0) {
    throw new Error("checkEvidence needs at least one capture");
  }
  const [primary] = captures;
  const deliveredSets = captures.map((capture) => deliveredRecords(capture));
  const delivered = deliveredSets[0];
  const records = delivered.records;

  const checks = [
    checkCaptureIntegrity(primary, delivered),
    checkSession(records, options),
    checkProfile(records, options),
    checkTools(records, options),
    checkUsage(records, options),
    checkLogs(records),
    checkAuth(primary),
    checkDestinations(captures, deliveredSets),
    checkSpoolReplay(primary),
    checkPrivacy(captures, options),
    checkProof(records),
  ];

  const spans = records.filter((record) => record.kind === "span");
  const otelHookVersions = [...new Set(spans.filter((span) => span.scopeName === OTEL_HOOK_SCOPE).map((span) => span.scopeVersion).filter((version) => version.length > 0))];
  const agentVersions = [...new Set(records.map((record) => record.attributes[ATTR.agentVersion] ?? record.attributes[ATTR.providerVersion]).filter((value) => typeof value === "string"))];
  const providers = [...new Set(records.map((record) => record.attributes[ATTR.providerId]).filter((value) => typeof value === "string"))];

  return {
    schema: RESULT_SCHEMA,
    ok: checks.every((entry) => entry.status !== "fail"),
    provider: options.provider ?? (providers.length === 1 ? providers[0] : null),
    captures: captures.map((capture) => capture.label),
    summary: {
      requests: primary.requests.length,
      emptyRequests: primary.requests.filter((request) => request.empty).map((request) => request.seq),
      rejectedRequests: primary.requests.filter((request) => !request.delivered).map((request) => request.seq),
      bySignal: countBy(primary.requests.map((request) => request.signal)),
      spans: spans.length,
      logs: records.length - spans.length,
      duplicates: delivered.duplicates,
      traceIds: [...new Set(spans.map((span) => span.traceId))],
      launcherSessionIds: [...new Set(records.map((record) => record.resourceAttributes[ATTR.sessionId]).filter((id) => typeof id === "string"))],
      providerIds: providers,
      otelHookVersions,
      agentVersions,
    },
    checks,
  };
};

const escapeCell = (text) =>
  String(text).replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

const STATUS_LABEL = Object.freeze({ pass: "PASS", fail: "FAIL", skip: "skip", manual: "manual" });

/** Markdown snippet for the per-provider evidence comment. */
export const renderMarkdown = (result) => {
  const lines = [];
  const summary = result.summary;
  lines.push(`#### Receiver capture (\`check-evidence\`)${result.provider === null ? "" : ` — ${result.provider}`}`);
  lines.push("");
  lines.push(`Result: **${result.ok ? "PASS" : "FAIL"}** (${RESULT_SCHEMA})`);
  lines.push("");
  lines.push(
    `- Requests: ${String(summary.requests)} (${formatCounts(summary.bySignal) || "none"}); empty bodies: ${summary.emptyRequests.length === 0 ? "none" : summary.emptyRequests.map((seq) => `#${String(seq)}`).join(", ")}; rejected: ${summary.rejectedRequests.length === 0 ? "none" : summary.rejectedRequests.map((seq) => `#${String(seq)}`).join(", ")}`,
  );
  lines.push(`- Delivered records: ${String(summary.spans)} spans, ${String(summary.logs)} log records; duplicates: ${String(summary.duplicates)}`);
  lines.push(`- otel-hook (instrumentation scope): ${summary.otelHookVersions.map((version) => `\`${version}\``).join(", ") || "unknown"}; agent version: ${summary.agentVersions.map((version) => `\`${version}\``).join(", ") || "unknown"}`);
  lines.push(`- Trace ids: ${summary.traceIds.map((id) => `\`${short(id, 32)}\``).join(", ") || "none"}`);
  lines.push("");
  lines.push("| Row | Check | Result | Evidence |");
  lines.push("|---|---|---|---|");
  for (const entry of result.checks) {
    lines.push(
      `| ${escapeCell(entry.row ?? "(capture)")} | \`${entry.id}\` | ${STATUS_LABEL[entry.status] ?? entry.status} | ${entry.details.map(escapeCell).join("<br>")} |`,
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `usage: check-evidence.mjs <capture-dir> [<second-destination-capture-dir> ...]
  [--provider <id>] [--session-id <launcher session id>] [--work-unit-id <id>]
  [--require-attr <key>]... [--expect-tool <name>]...
  [--expect-usage input=N,output=N[,cache_read=N,cache_creation=N,reasoning=N]]
  [--forbid <string>]... [--json-out <file>] [--markdown-out <file>] [--markdown]`;

export const parseExpectUsage = (text) => {
  const usage = {};
  for (const part of text.split(",").map((piece) => piece.trim()).filter((piece) => piece.length > 0)) {
    const [name, raw] = part.split("=");
    if (name === undefined || !(name in USAGE_KEYS) || raw === undefined || !/^\d+$/.test(raw)) {
      throw new Error(`--expect-usage: bad entry "${part}" (keys: ${Object.keys(USAGE_KEYS).join(", ")})`);
    }
    usage[name] = Number(raw);
  }
  return usage;
};

const parseArgs = (argv) => {
  const options = { dirs: [], forbid: [], expectTools: [], requireAttributes: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    const need = () => {
      if (value === undefined) {
        throw new Error(`${flag} needs a value`);
      }
      index += 1;
      return value;
    };
    switch (flag) {
      case "--provider":
        options.provider = need();
        break;
      case "--session-id":
        options.sessionId = need();
        break;
      case "--work-unit-id":
        options.workUnitId = need();
        break;
      case "--require-attr":
        options.requireAttributes.push(need());
        break;
      case "--expect-tool":
        options.expectTools.push(need());
        break;
      case "--expect-usage":
        options.expectUsage = parseExpectUsage(need());
        break;
      case "--forbid":
        options.forbid.push(need());
        break;
      case "--json-out":
        options.jsonOut = need();
        break;
      case "--markdown-out":
        options.markdownOut = need();
        break;
      case "--markdown":
        options.markdown = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        if (String(flag).startsWith("--")) {
          throw new Error(`unknown flag ${String(flag)}`);
        }
        options.dirs.push(String(flag));
    }
  }
  if (options.requireAttributes.length === 0) {
    delete options.requireAttributes;
  }
  return options;
};

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
    process.exit(2);
  }
  if (options.help === true) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  if (options.dirs.length === 0) {
    process.stderr.write(`a capture directory is required\n${USAGE}\n`);
    process.exit(2);
  }
  let captures;
  try {
    captures = await Promise.all(options.dirs.map((dir) => loadCapture(path.resolve(dir))));
  } catch (error) {
    process.stderr.write(`cannot read capture: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
  const result = checkEvidence(captures, options);
  const json = `${JSON.stringify(result, null, 2)}\n`;
  const markdown = renderMarkdown(result);
  if (options.jsonOut !== undefined) {
    await writeFile(options.jsonOut, json);
  }
  if (options.markdownOut !== undefined) {
    await writeFile(options.markdownOut, markdown);
  }
  process.stdout.write(options.markdown === true ? markdown : json);
  process.exit(result.ok ? 0 : 1);
}
