/**
 * Minimal reader for the OTLP `ExportTraceServiceRequest` protobuf.
 *
 * The e2e harness deliberately asserts against raw bytes rather than decoding,
 * because a privacy assertion ("this text is nowhere in what we sent") is only
 * meaningful on the bytes themselves. Cross-process correlation needs the
 * opposite: trace ids, span ids, and parent span ids are *binary* fields, so
 * "the end process reused the start process's trace id" cannot be expressed as
 * a substring at all.
 *
 * This reads just enough of the wire format to answer that — no schema, no
 * generated code, no dependency — so an assertion about span identity is made
 * against what actually left the process.
 */

type WireField = {
  readonly number: number;
  readonly wireType: number;
  readonly bytes?: Buffer;
  readonly varint?: bigint;
  readonly fixed64?: Buffer;
};

const readVarint = (buffer: Buffer, start: number): { value: bigint; next: number } => {
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

const readFields = (buffer: Buffer): readonly WireField[] => {
  const fields: WireField[] = [];
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

const submessages = (fields: readonly WireField[], number: number): readonly Buffer[] =>
  fields.filter((field) => field.number === number && field.bytes !== undefined).map((field) => field.bytes as Buffer);

const firstBytes = (fields: readonly WireField[], number: number): Buffer | undefined =>
  fields.find((field) => field.number === number)?.bytes;

const firstVarint = (fields: readonly WireField[], number: number): bigint | undefined =>
  fields.find((field) => field.number === number)?.varint;

const firstFixed64 = (fields: readonly WireField[], number: number): bigint | undefined => {
  const raw = fields.find((field) => field.number === number)?.fixed64;
  return raw === undefined ? undefined : raw.readBigUInt64LE(0);
};

export type DecodedAttributeValue = string | number | boolean;

const decodeAnyValue = (buffer: Buffer): DecodedAttributeValue | undefined => {
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

export type DecodedSpan = {
  readonly traceId: string;
  readonly spanId: string;
  /** Empty string when the span is a trace root. */
  readonly parentSpanId: string;
  readonly name: string;
  readonly startMillis: number;
  readonly endMillis: number;
  readonly durationMillis: number;
  readonly statusCode: number;
  readonly attributes: Readonly<Record<string, DecodedAttributeValue>>;
  /**
   * Attributes of the `Resource` this span was exported under.
   *
   * Carried onto each span rather than returned separately so a test can assert
   * "this span went out with that service identity" in one place — which is what
   * a spool-replay assertion actually needs.
   */
  readonly resourceAttributes: Readonly<Record<string, DecodedAttributeValue>>;
};

/** Decode a repeated `KeyValue` field into a plain record. */
const decodeKeyValues = (
  fields: ReturnType<typeof readFields>,
  fieldNumber: number,
): Record<string, DecodedAttributeValue> => {
  const decoded: Record<string, DecodedAttributeValue> = {};
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
  buffer: Buffer,
  resourceAttributes: Readonly<Record<string, DecodedAttributeValue>>,
): DecodedSpan => {
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
export const decodeExportedSpans = (body: Buffer): readonly DecodedSpan[] => {
  const spans: DecodedSpan[] = [];
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
  bodies: readonly Buffer[],
): readonly DecodedSpan[] => bodies.flatMap((body) => decodeExportedSpans(body));
