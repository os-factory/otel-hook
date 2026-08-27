/**
 * OTLP protobuf decoder for the agent live lab (ported from tests/helpers/otlp.ts).
 * Lab-only; not part of the public package.
 */
const readVarint = (buffer, start) => {
  let value = 0n;
  let shift = 0n;
  let offset = start;
  for (; offset < buffer.length; offset += 1) {
    const byte = buffer[offset] ?? 0;
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
        fields.push({ number, wireType, varint: varint.value });
        break;
      }
      case 1: {
        fields.push({ number, wireType, fixed64: buffer.subarray(offset, offset + 8) });
        offset += 8;
        break;
      }
      case 2: {
        const length = readVarint(buffer, offset);
        offset = length.next;
        const end = offset + Number(length.value);
        fields.push({ number, wireType, bytes: buffer.subarray(offset, end) });
        offset = end;
        break;
      }
      case 5: {
        fields.push({ number, wireType, bytes: buffer.subarray(offset, offset + 4) });
        offset += 4;
        break;
      }
      default:
        throw new Error(`unsupported protobuf wire type ${wireType}`);
    }
  }
  return fields;
};

const submessages = (fields, number) =>
  fields.filter((field) => field.number === number && field.bytes !== undefined).map((field) => field.bytes);

const firstBytes = (fields, number) =>
  fields.find((field) => field.number === number)?.bytes;

const firstVarint = (fields, number) =>
  fields.find((field) => field.number === number)?.varint;

const firstFixed64 = (fields, number) => {
  const raw = fields.find((field) => field.number === number)?.fixed64;
  return raw === undefined ? undefined : raw.readBigUInt64LE(0);
};


const decodeAnyValue = (buffer) => {
  const fields = readFields(buffer);
  const stringValue = firstBytes(fields, 1);
  if (stringValue !== undefined) {
    return stringValue.toString("utf8");
  }
  const boolValue = firstVarint(fields, 2);
  if (boolValue !== undefined) {
    return boolValue !== 0n;
  }
  const intValue = firstVarint(fields, 3);
  if (intValue !== undefined) {
    return Number(intValue);
  }
  const doubleRaw = fields.find((field) => field.number === 4)?.fixed64;
  if (doubleRaw !== undefined) {
    return doubleRaw.readDoubleLE(0);
  }
  return undefined;
};


/** Decode a repeated `KeyValue` field into a plain record. */
const decodeKeyValues = (
  fields,
  fieldNumber,
) => {
  const decoded = {};
  for (const keyValue of submessages(fields, fieldNumber)) {
    const kv = readFields(keyValue);
    const key = firstBytes(kv, 1)?.toString("utf8");
    const valueBytes = firstBytes(kv, 2);
    if (key === undefined || valueBytes === undefined) {
      continue;
    }
    const value = decodeAnyValue(valueBytes);
    if (value !== undefined) {
      decoded[key] = value;
    }
  }
  return decoded;
};

const decodeSpan = (
  buffer,
  resourceAttributes,
) => {
  const fields = readFields(buffer);
  const attributes = decodeKeyValues(fields, 9);
  const startNanos = firstFixed64(fields, 7) ?? 0n;
  const endNanos = firstFixed64(fields, 8) ?? 0n;
  const startMillis = Number(startNanos / 1_000_000n);
  const endMillis = Number(endNanos / 1_000_000n);
  const status = firstBytes(fields, 15);
  return {
    traceId: (firstBytes(fields, 1) ?? Buffer.alloc(0)).toString("hex"),
    spanId: (firstBytes(fields, 2) ?? Buffer.alloc(0)).toString("hex"),
    parentSpanId: (firstBytes(fields, 4) ?? Buffer.alloc(0)).toString("hex"),
    name: (firstBytes(fields, 5) ?? Buffer.alloc(0)).toString("utf8"),
    startMillis,
    endMillis,
    durationMillis: endMillis - startMillis,
    statusCode: status === undefined ? 0 : Number(firstVarint(readFields(status), 3) ?? 0n),
    attributes,
    resourceAttributes,
  };
};

/** Every span in one captured `ExportTraceServiceRequest` body. */
export const decodeExportedSpans = (body) => {
  const spans = [];
  for (const resourceSpans of submessages(readFields(body), 1)) {
    const resourceFields = readFields(resourceSpans);
    // ResourceSpans.resource is field 1; Resource.attributes is field 1 within it.
    const resourceBytes = firstBytes(resourceFields, 1);
    const resourceAttributes =
      resourceBytes === undefined ? {} : decodeKeyValues(readFields(resourceBytes), 1);
    for (const scopeSpans of submessages(resourceFields, 2)) {
      for (const span of submessages(readFields(scopeSpans), 2)) {
        spans.push(decodeSpan(span, resourceAttributes));
      }
    }
  }
  return spans;
};

/** Every span across a sequence of captured request bodies, in arrival order. */
export const decodeAllExportedSpans = (
  bodies,
) => bodies.flatMap((body) => decodeExportedSpans(body));


const firstFixed64Raw = (fields, number) => {
  const raw = fields.find((field) => field.number === number)?.fixed64;
  return raw === undefined ? undefined : raw.readBigUInt64LE(0);
};

const decodeLogRecord = (
  buffer,
  resourceAttributes,
  scopeName,
) => {
  const fields = readFields(buffer);
  // LogRecord field numbers, which are not contiguous: 1 time_unix_nano,
  // 2 severity_number, 3 severity_text, 5 body, 6 attributes, 9 trace_id,
  // 10 span_id, 11 observed_time_unix_nano, 12 event_name.
  const bodyBytes = firstBytes(fields, 5);
  return {
    traceId: (firstBytes(fields, 9) ?? Buffer.alloc(0)).toString("hex"),
    spanId: (firstBytes(fields, 10) ?? Buffer.alloc(0)).toString("hex"),
    eventName: (firstBytes(fields, 12) ?? Buffer.alloc(0)).toString("utf8"),
    severityNumber: Number(firstVarint(fields, 2) ?? 0n),
    severityText: (firstBytes(fields, 3) ?? Buffer.alloc(0)).toString("utf8"),
    body:
      bodyBytes === undefined
        ? undefined
        : (() => {
            const value = decodeAnyValue(bodyBytes);
            return typeof value === "string" ? value : undefined;
          })(),
    timeUnixNanos: firstFixed64Raw(fields, 1) ?? 0n,
    observedTimeUnixNanos: firstFixed64Raw(fields, 11) ?? 0n,
    attributes: decodeKeyValues(fields, 6),
    resourceAttributes,
    scopeName,
  };
};

/** Every log record in one captured `ExportLogsServiceRequest` body. */
export const decodeExportedLogRecords = (body) => {
  const records = [];
  // ExportLogsServiceRequest.resource_logs is field 1; ResourceLogs.resource is 1
  // and .scope_logs is 2; ScopeLogs.scope is 1 and .log_records is 2.
  for (const resourceLogs of submessages(readFields(body), 1)) {
    const resourceFields = readFields(resourceLogs);
    const resourceBytes = firstBytes(resourceFields, 1);
    const resourceAttributes =
      resourceBytes === undefined ? {} : decodeKeyValues(readFields(resourceBytes), 1);
    for (const scopeLogs of submessages(resourceFields, 2)) {
      const scopeFields = readFields(scopeLogs);
      const scopeBytes = firstBytes(scopeFields, 1);
      const scopeName =
        scopeBytes === undefined
          ? ""
          : (firstBytes(readFields(scopeBytes), 1) ?? Buffer.alloc(0)).toString("utf8");
      for (const record of submessages(scopeFields, 2)) {
        records.push(decodeLogRecord(record, resourceAttributes, scopeName));
      }
    }
  }
  return records;
};

/** Every log record across a sequence of captured request bodies, in arrival order. */
export const decodeAllExportedLogRecords = (
  bodies,
) => bodies.flatMap((body) => decodeExportedLogRecords(body));
