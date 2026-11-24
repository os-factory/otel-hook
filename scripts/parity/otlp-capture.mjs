// OTLP capture files: the on-disk form of what a local receiver was sent.
//
// A capture is JSONL. Each line is one HTTP request the receiver accepted,
// with the same `{ path, body }` shape the agent-lab collector
// (har-plugins/agent-lab/scripts/collector.mjs) and the test collector
// (tests/helpers/collector.ts) keep in memory, made durable:
//
//   {"path":"/v1/logs","contentType":"application/x-protobuf","bodyBase64":"..."}
//   {"path":"/v1/metrics","contentType":"application/json","body":{...OTLP/JSON...}}
//
// `bodyBase64` holds the exact bytes (protobuf, or JSON text), optionally with
// `"contentEncoding":"gzip"`; `body` holds an already-parsed OTLP/JSON request and
// is what hand-written synthetic fixtures use, because it is reviewable. A line
// of the form `{"meta":{...}}` describes the capture (side, provider, versions,
// whether it is synthetic) and carries no telemetry.
//
// Every signal is normalized to one flat item shape so the comparison never
// needs to know which encoding or which signal a fact arrived in:
//
//   { signal: "metric" | "log" | "span", name, attributes, resourceAttributes,
//     durationMillis?, severityNumber?, statusCode? }
//
// Only metric/log/span names and attributes are retained. Log bodies are read to
// find an event name and are never copied into an item, so a report built from a
// capture cannot echo prompt text.

import { gunzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";

// --- protobuf wire format ----------------------------------------------------

const readVarint = (buffer, start) => {
  let value = 0n;
  let shift = 0n;
  for (let offset = start; offset < buffer.length; offset += 1) {
    const byte = buffer[offset];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value, next: offset + 1 };
    }
    shift += 7n;
  }
  throw new Error("truncated varint in protobuf message");
};

const readFields = (buffer) => {
  const fields = [];
  let offset = 0;
  while (offset < buffer.length) {
    const tag = readVarint(buffer, offset);
    offset = tag.next;
    const number = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 0x7n);
    switch (wireType) {
      case 0: {
        const varint = readVarint(buffer, offset);
        offset = varint.next;
        fields.push({ number, varint: varint.value });
        break;
      }
      case 1:
        fields.push({ number, fixed64: buffer.subarray(offset, offset + 8) });
        offset += 8;
        break;
      case 2: {
        const length = readVarint(buffer, offset);
        offset = length.next;
        const end = offset + Number(length.value);
        if (end > buffer.length) {
          throw new Error("truncated length-delimited protobuf field");
        }
        fields.push({ number, bytes: buffer.subarray(offset, end) });
        offset = end;
        break;
      }
      case 5:
        fields.push({ number, fixed32: buffer.subarray(offset, offset + 4) });
        offset += 4;
        break;
      default:
        throw new Error(`unsupported protobuf wire type ${String(wireType)}`);
    }
  }
  return fields;
};

const all = (fields, number) =>
  fields.filter((field) => field.number === number && field.bytes !== undefined).map((field) => field.bytes);
const first = (fields, number) => fields.find((field) => field.number === number);
const firstString = (fields, number) => first(fields, number)?.bytes?.toString("utf8");
const firstFixed64 = (fields, number) => first(fields, number)?.fixed64?.readBigUInt64LE(0);

const decodeAnyValue = (buffer) => {
  const fields = readFields(buffer);
  const field = fields[0];
  if (field === undefined) {
    return undefined;
  }
  switch (field.number) {
    case 1:
      return field.bytes.toString("utf8");
    case 2:
      return field.varint !== 0n;
    case 3:
      return Number(BigInt.asIntN(64, field.varint));
    case 4:
      return field.fixed64.readDoubleLE(0);
    case 5: // ArrayValue: values = 1
      return all(readFields(field.bytes), 1).map(decodeAnyValue);
    default:
      // kvlist and bytes values are kept as a marker: their presence is what a
      // coverage comparison needs, not their content.
      return "[structured]";
  }
};

const decodeKeyValues = (fields, number) => {
  const decoded = {};
  for (const keyValue of all(fields, number)) {
    const kv = readFields(keyValue);
    const key = firstString(kv, 1);
    const valueBytes = first(kv, 2)?.bytes;
    if (key !== undefined && valueBytes !== undefined) {
      decoded[key] = decodeAnyValue(valueBytes);
    }
  }
  return decoded;
};

const resourceAttributesOf = (resourceContainerFields) => {
  const resource = first(resourceContainerFields, 1)?.bytes;
  return resource === undefined ? {} : decodeKeyValues(readFields(resource), 1);
};

const nanosToMillis = (nanos) => (nanos === undefined ? undefined : Number(nanos / 1_000_000n));

const protobufSpans = (body) => {
  const items = [];
  for (const resourceSpans of all(readFields(body), 1)) {
    const resourceFields = readFields(resourceSpans);
    const resourceAttributes = resourceAttributesOf(resourceFields);
    for (const scopeSpans of all(resourceFields, 2)) {
      for (const span of all(readFields(scopeSpans), 2)) {
        const fields = readFields(span);
        const start = nanosToMillis(firstFixed64(fields, 7));
        const end = nanosToMillis(firstFixed64(fields, 8));
        const status = first(fields, 15)?.bytes;
        items.push({
          signal: "span",
          name: firstString(fields, 5) ?? "",
          attributes: decodeKeyValues(fields, 9),
          resourceAttributes,
          ...(start === undefined || end === undefined ? {} : { durationMillis: end - start }),
          statusCode: status === undefined ? 0 : Number(first(readFields(status), 3)?.varint ?? 0n),
        });
      }
    }
  }
  return items;
};

const protobufLogs = (body) => {
  const items = [];
  for (const resourceLogs of all(readFields(body), 1)) {
    const resourceFields = readFields(resourceLogs);
    const resourceAttributes = resourceAttributesOf(resourceFields);
    for (const scopeLogs of all(resourceFields, 2)) {
      for (const record of all(readFields(scopeLogs), 2)) {
        // LogRecord: 2 severity_number, 5 body, 6 attributes, 12 event_name.
        const fields = readFields(record);
        const bodyBytes = first(fields, 5)?.bytes;
        const bodyValue = bodyBytes === undefined ? undefined : decodeAnyValue(bodyBytes);
        items.push(
          logItem({
            eventName: firstString(fields, 12),
            body: bodyValue,
            attributes: decodeKeyValues(fields, 6),
            resourceAttributes,
            severityNumber: Number(first(fields, 2)?.varint ?? 0n),
          }),
        );
      }
    }
  }
  return items;
};

// Metric: 1 name, 5 gauge, 7 sum, 9 histogram, 10 exponential_histogram, 11 summary.
// Each of those holds data_points at field 1. A data point's attributes sit at
// field 7 for number and summary points, 9 for histograms, 1 for exponential ones.
const METRIC_DATA_FIELDS = [
  { field: 5, kind: "gauge", attributesField: 7 },
  { field: 7, kind: "sum", attributesField: 7 },
  { field: 9, kind: "histogram", attributesField: 9 },
  { field: 10, kind: "exponentialHistogram", attributesField: 1 },
  { field: 11, kind: "summary", attributesField: 7 },
];

const protobufMetrics = (body) => {
  const items = [];
  for (const resourceMetrics of all(readFields(body), 1)) {
    const resourceFields = readFields(resourceMetrics);
    const resourceAttributes = resourceAttributesOf(resourceFields);
    for (const scopeMetrics of all(resourceFields, 2)) {
      for (const metric of all(readFields(scopeMetrics), 2)) {
        const fields = readFields(metric);
        const name = firstString(fields, 1) ?? "";
        for (const { field, attributesField } of METRIC_DATA_FIELDS) {
          const data = first(fields, field)?.bytes;
          if (data === undefined) {
            continue;
          }
          for (const point of all(readFields(data), 1)) {
            items.push({
              signal: "metric",
              name,
              attributes: decodeKeyValues(readFields(point), attributesField),
              resourceAttributes,
            });
          }
        }
      }
    }
  }
  return items;
};

// --- OTLP/JSON ----------------------------------------------------------------

const jsonAnyValue = (value) => {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  if ("stringValue" in value) return value.stringValue;
  if ("boolValue" in value) return value.boolValue;
  if ("intValue" in value) return Number(value.intValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("arrayValue" in value) return (value.arrayValue?.values ?? []).map(jsonAnyValue);
  return "[structured]";
};

const jsonAttributes = (list) => {
  const decoded = {};
  for (const entry of Array.isArray(list) ? list : []) {
    if (typeof entry?.key === "string") {
      decoded[entry.key] = jsonAnyValue(entry.value);
    }
  }
  return decoded;
};

const jsonNanosToMillis = (value) => {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return Number(BigInt(String(value)) / 1_000_000n);
};

const jsonSpans = (body) =>
  (body.resourceSpans ?? []).flatMap((resourceSpans) => {
    const resourceAttributes = jsonAttributes(resourceSpans.resource?.attributes);
    return (resourceSpans.scopeSpans ?? []).flatMap((scopeSpans) =>
      (scopeSpans.spans ?? []).map((span) => {
        const start = jsonNanosToMillis(span.startTimeUnixNano);
        const end = jsonNanosToMillis(span.endTimeUnixNano);
        return {
          signal: "span",
          name: span.name ?? "",
          attributes: jsonAttributes(span.attributes),
          resourceAttributes,
          ...(start === undefined || end === undefined ? {} : { durationMillis: end - start }),
          statusCode: Number(span.status?.code ?? 0),
        };
      }),
    );
  });

const jsonLogs = (body) =>
  (body.resourceLogs ?? []).flatMap((resourceLogs) => {
    const resourceAttributes = jsonAttributes(resourceLogs.resource?.attributes);
    return (resourceLogs.scopeLogs ?? []).flatMap((scopeLogs) =>
      (scopeLogs.logRecords ?? []).map((record) =>
        logItem({
          eventName: record.eventName,
          body: jsonAnyValue(record.body),
          attributes: jsonAttributes(record.attributes),
          resourceAttributes,
          severityNumber: Number(record.severityNumber ?? 0),
        }),
      ),
    );
  });

const JSON_METRIC_KINDS = ["gauge", "sum", "histogram", "exponentialHistogram", "summary"];

const jsonMetrics = (body) =>
  (body.resourceMetrics ?? []).flatMap((resourceMetrics) => {
    const resourceAttributes = jsonAttributes(resourceMetrics.resource?.attributes);
    return (resourceMetrics.scopeMetrics ?? []).flatMap((scopeMetrics) =>
      (scopeMetrics.metrics ?? []).flatMap((metric) =>
        JSON_METRIC_KINDS.flatMap((kind) =>
          (metric[kind]?.dataPoints ?? []).map((point) => ({
            signal: "metric",
            name: metric.name ?? "",
            attributes: jsonAttributes(point.attributes),
            resourceAttributes,
          })),
        ),
      ),
    );
  });

// --- shared -------------------------------------------------------------------

/**
 * A log's name is its OTLP `event_name`, else an `event.name` attribute (the
 * convention older SDKs and Claude Code use), else a short string body. The body
 * is consulted only for that and never retained.
 */
const logItem = ({ eventName, body, attributes, resourceAttributes, severityNumber }) => {
  const fromAttribute = typeof attributes["event.name"] === "string" ? attributes["event.name"] : undefined;
  const fromBody = typeof body === "string" && body.length > 0 && body.length <= 128 && !/\s/.test(body) ? body : undefined;
  return {
    signal: "log",
    name: (eventName !== undefined && eventName !== "" ? eventName : undefined) ?? fromAttribute ?? fromBody ?? "",
    attributes,
    resourceAttributes,
    severityNumber,
  };
};

/** The OTLP signal a request path carries, from its conventional suffix. */
export const signalOfPath = (path) => {
  if (/\/v1\/traces\/?$/.test(path)) return "span";
  if (/\/v1\/logs\/?$/.test(path)) return "log";
  if (/\/v1\/metrics\/?$/.test(path)) return "metric";
  return undefined;
};

const DECODERS = {
  span: { protobuf: protobufSpans, json: jsonSpans },
  log: { protobuf: protobufLogs, json: jsonLogs },
  metric: { protobuf: protobufMetrics, json: jsonMetrics },
};

/** Normalize one captured request into items. Throws on an undecodable body. */
export const decodeCapturedRequest = (request) => {
  const signal = signalOfPath(request.path ?? "");
  if (signal === undefined) {
    return [];
  }
  if (request.body !== undefined && typeof request.body === "object") {
    return DECODERS[signal].json(request.body);
  }
  if (typeof request.bodyBase64 !== "string") {
    throw new Error(`captured ${request.path} request has neither body nor bodyBase64`);
  }
  let bytes = Buffer.from(request.bodyBase64, "base64");
  if (/gzip/i.test(request.contentEncoding ?? "")) {
    bytes = gunzipSync(bytes);
  }
  if (/json/i.test(request.contentType ?? "")) {
    return DECODERS[signal].json(JSON.parse(bytes.toString("utf8")));
  }
  return DECODERS[signal].protobuf(bytes);
};

/** Parse capture JSONL text into `{ meta, requests }`. */
export const parseCapture = (text, source = "capture") => {
  const meta = {};
  const requests = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === "") {
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`${source}:${String(index + 1)}: invalid JSON (${error.message})`, { cause: error });
    }
    if (parsed !== null && typeof parsed === "object" && parsed.meta !== undefined) {
      Object.assign(meta, parsed.meta);
      return;
    }
    requests.push(parsed);
  });
  return { meta, requests };
};

/** Read a capture file and normalize every request in it. */
export const loadCapture = async (file) => {
  const { meta, requests } = parseCapture(await readFile(file, "utf8"), file);
  const items = requests.flatMap((request, index) => {
    try {
      return decodeCapturedRequest(request);
    } catch (error) {
      throw new Error(`${file}: request ${String(index + 1)} (${String(request.path)}): ${error.message}`, {
        cause: error,
      });
    }
  });
  return { meta, requests: requests.length, items };
};

/** One capture line for a request the receiver accepted. */
export const captureLine = ({ path, contentType, contentEncoding, body, receivedAt }) =>
  JSON.stringify({
    receivedAt,
    path,
    ...(contentType === undefined ? {} : { contentType }),
    ...(contentEncoding === undefined ? {} : { contentEncoding }),
    bodyBase64: body.toString("base64"),
  });
