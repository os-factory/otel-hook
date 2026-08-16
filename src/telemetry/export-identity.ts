import type { Attributes } from "@opentelemetry/api";
import type { Resource } from "@opentelemetry/resources";
import { ATTR_SESSION_ID } from "@opentelemetry/semantic-conventions/incubating";

import type { CanonicalEvent } from "../model/events.js";

/**
 * W3C hex identity attributes on every log and span.
 *
 * Mission Control (and any consumer that decodes OTLP protobuf with a JSON
 * `toObject` that stringifies bytes as UTF-8) cannot recover a usable id from
 * the protobuf `trace_id` / `span_id` fields. These attributes are already hex
 * in the OpenTelemetry JS API; they are copied onto the attribute map so a
 * consumer never has to stringify binary ids.
 */
export const ATTR_TRACE_ID = "trace_id";
export const ATTR_SPAN_ID = "span_id";
export const ATTR_PARENT_SPAN_ID = "parent_span_id";

/** Provider session id, kept when `session.id` is an externally supplied key. */
export const ATTR_OTELHOOK_SESSION_ID = "otelhook.session.id";
/** Same provider session id under the gen_ai conversation attribute. */
export const ATTR_GEN_AI_CONVERSATION_ID = "gen_ai.conversation.id";

export const TRACE_ID_HEX_PATTERN = /^[0-9a-f]{32}$/;
export const SPAN_ID_HEX_PATTERN = /^[0-9a-f]{16}$/;

const ATTR_OTELHOOK_INVOCATION_ID = "otelhook.invocation.id";
const ATTR_OTELHOOK_PROVIDER_ID = "otelhook.provider.id";
const ATTR_OTELHOOK_PROVIDER_VERSION = "otelhook.provider.version";
const ATTR_OTELHOOK_WORKSPACE_ID = "otelhook.workspace.id";

const HAR_SESSION_KEY = "har.session_key";

const isPrimitiveAttribute = (value: unknown): value is string | number | boolean =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean";

/**
 * Resource attributes a HAR (or similar) launcher put on the process.
 *
 * Copied onto every log and span so a consumer that reads record attributes
 * rather than the resource still sees them. Only `har.*` primitives are
 * forwarded; nothing is invented when they are absent.
 */
export const passthroughHarAttributes = (resource: Resource): Attributes => {
  const attributes: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(resource.attributes)) {
    if (key.startsWith("har.") && isPrimitiveAttribute(value)) {
      attributes[key] = value;
    }
  }
  return attributes;
};

/**
 * Session id to put on `session.id`, preferring a HAR-supplied key.
 *
 * The provider's own session id is never discarded: it is returned separately
 * so callers can emit it as `otelhook.session.id` / `gen_ai.conversation.id`.
 */
export const resolveExportedSessionId = (
  eventSessionId: string,
  resource: Resource,
): { readonly sessionId: string; readonly providerSessionId: string } => {
  const har = resource.attributes[HAR_SESSION_KEY];
  if (typeof har === "string") {
    const trimmed = har.trim();
    if (trimmed.length > 0) {
      return { sessionId: trimmed, providerSessionId: eventSessionId };
    }
  }
  return { sessionId: eventSessionId, providerSessionId: eventSessionId };
};

export type ExportedTraceIds = {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
};

/**
 * Hex-only trace/span attributes. A value that is not W3C hex is omitted
 * rather than stringified — binary blobs must never appear in id fields.
 */
export const hexTraceAttributes = (ids: ExportedTraceIds): Attributes => ({
  ...(TRACE_ID_HEX_PATTERN.test(ids.traceId) ? { [ATTR_TRACE_ID]: ids.traceId } : {}),
  ...(SPAN_ID_HEX_PATTERN.test(ids.spanId) ? { [ATTR_SPAN_ID]: ids.spanId } : {}),
  ...(ids.parentSpanId !== undefined && SPAN_ID_HEX_PATTERN.test(ids.parentSpanId)
    ? { [ATTR_PARENT_SPAN_ID]: ids.parentSpanId }
    : {}),
});

/**
 * Identity attributes shared by the log and span mappings.
 *
 * `session.id` is the HAR session key when the resource carries one, otherwise
 * the provider session id. The provider id is always also emitted under
 * `otelhook.session.id` and `gen_ai.conversation.id`.
 */
export const exportIdentityAttributes = (
  event: CanonicalEvent,
  resource: Resource,
  ids: ExportedTraceIds,
): Attributes => {
  const { sessionId, providerSessionId } = resolveExportedSessionId(event.sessionId, resource);
  return {
    [ATTR_SESSION_ID]: sessionId,
    [ATTR_OTELHOOK_SESSION_ID]: providerSessionId,
    [ATTR_GEN_AI_CONVERSATION_ID]: providerSessionId,
    [ATTR_OTELHOOK_INVOCATION_ID]: event.invocationId,
    [ATTR_OTELHOOK_PROVIDER_ID]: event.provenance.providerId,
    ...(event.provenance.providerVersion === undefined
      ? {}
      : { [ATTR_OTELHOOK_PROVIDER_VERSION]: event.provenance.providerVersion }),
    [ATTR_OTELHOOK_WORKSPACE_ID]: event.workspace.workspaceId,
    ...passthroughHarAttributes(resource),
    ...hexTraceAttributes(ids),
  };
};
