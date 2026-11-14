import type { Attributes } from "@opentelemetry/api";
import type { Resource } from "@opentelemetry/resources";
import { ATTR_SESSION_ID } from "@opentelemetry/semantic-conventions/incubating";

import type { CanonicalEvent } from "../model/events.js";
import type { CanonicalUsage } from "../model/usage.js";

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

/**
 * The provider's own subagent id (Claude Code `agent_id`), on every record of an
 * event emitted inside a subagent. Same class as `session.id`: a provider-minted
 * opaque identifier, exported verbatim so a consumer can join it to the
 * provider's own per-subagent records.
 */
export const ATTR_OTELHOOK_SUBAGENT_ID = "otelhook.subagent.id";

/**
 * Worktree a tool event targeted (ADR 0008). Branch under the OTel VCS
 * attribute; the worktree root, and its repository's main worktree root, only
 * as salted `git-root` handles.
 */
export const ATTR_VCS_REF_HEAD_NAME = "vcs.ref.head.name";
export const ATTR_OTELHOOK_TARGET_WORKSPACE_ID = "otelhook.target.workspace.id";
export const ATTR_OTELHOOK_TARGET_SOURCE = "otelhook.target.source";
export const ATTR_OTELHOOK_TARGET_REPOSITORY_ID = "otelhook.target.repository.id";
export const ATTR_OTELHOOK_TARGET_WORKTREE_KIND = "otelhook.target.worktree.kind";

/** Whether `gen_ai.usage.*` on this record is a delta or a running total. */
export const ATTR_OTELHOOK_USAGE_TEMPORALITY = "otelhook.usage.temporality";

/** Target attributes for a tool event; empty when the core resolved none. */
export const targetAttributes = (event: CanonicalEvent): Attributes => {
  if ((event.type !== "tool.start" && event.type !== "tool.end") || event.target === undefined) {
    return {};
  }
  const { target } = event;
  return {
    [ATTR_OTELHOOK_TARGET_WORKSPACE_ID]: target.workspaceId,
    [ATTR_OTELHOOK_TARGET_SOURCE]: target.source,
    ...(target.vcsBranchName === undefined ? {} : { [ATTR_VCS_REF_HEAD_NAME]: target.vcsBranchName }),
    ...(target.repositoryId === undefined
      ? {}
      : { [ATTR_OTELHOOK_TARGET_REPOSITORY_ID]: target.repositoryId }),
    ...(target.worktreeKind === undefined
      ? {}
      : { [ATTR_OTELHOOK_TARGET_WORKTREE_KIND]: target.worktreeKind }),
  };
};

/** Temporality of reported usage, so a consumer never sums running totals. */
export const usageTemporalityAttributes = (usage: CanonicalUsage | undefined): Attributes =>
  usage === undefined ? {} : { [ATTR_OTELHOOK_USAGE_TEMPORALITY]: usage.temporality };

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
    ...(event.subagentId === undefined ? {} : { [ATTR_OTELHOOK_SUBAGENT_ID]: event.subagentId }),
    ...passthroughHarAttributes(resource),
    ...hexTraceAttributes(ids),
  };
};
