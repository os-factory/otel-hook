/**
 * Names of the identity and target attributes otel-hook writes on its logs and
 * spans (docs/canonical-log-mapping.md).
 *
 * Deliberately import-free: published as `@osfactory/otel-hook/semconv` so a
 * consumer reading the records can match on them without installing the
 * OpenTelemetry SDK.
 */

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

export const ATTR_OTELHOOK_INVOCATION_ID = "otelhook.invocation.id";
export const ATTR_OTELHOOK_PROVIDER_ID = "otelhook.provider.id";
export const ATTR_OTELHOOK_PROVIDER_VERSION = "otelhook.provider.version";
/** Salted handle of the session's workspace; never a path. */
export const ATTR_OTELHOOK_WORKSPACE_ID = "otelhook.workspace.id";

/**
 * The provider's own subagent id (Claude Code `agent_id`), on every record of an
 * event emitted inside a subagent. Same class as `session.id`: a provider-minted
 * opaque identifier, exported verbatim so a consumer can join it to the
 * provider's own per-subagent records.
 */
export const ATTR_OTELHOOK_SUBAGENT_ID = "otelhook.subagent.id";

/**
 * Worktree an event targeted (ADR 0008): the one a tool call touched, or the one
 * a session runs in on its start and prompts. Branch under the OTel VCS
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
