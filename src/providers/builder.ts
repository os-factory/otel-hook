import { OtelHookError } from "../errors/index.js";
import {
  canonicalEventSchema,
  type CanonicalEvent,
  type CompactionPerformedEvent,
  type ErrorRaisedEvent,
  type GenerationEndEvent,
  type GenerationStartEvent,
  type PromptSubmittedEvent,
  type SessionEndEvent,
  type SessionStartEvent,
  type SubagentEndEvent,
  type SubagentStartEvent,
  type ToolEndEvent,
  type ToolStartEvent,
} from "../model/events.js";
import type { InvocationIdentity } from "../model/identity.js";
import { CANONICAL_SCHEMA_VERSION } from "../model/version.js";
import type { ProviderContext } from "./adapter.js";

/** Fields the factory supplies; an adapter never sets them itself. */
type ManagedFields =
  | "schemaVersion"
  | "eventId"
  | "invocationId"
  | "sessionId"
  | "sequence"
  | "provenance"
  | "workspace"
  | "extensions"
  | "occurredAt";

type Draft<TEvent extends CanonicalEvent> = Omit<TEvent, ManagedFields> & {
  /** Defaults to the clock reading at build time. */
  readonly occurredAt?: number;
  /** Sanitized and namespace-checked before it is attached. */
  readonly extensions?: Readonly<Record<string, unknown>>;
  /** Mixed into the derived event id when one event type repeats. */
  readonly idDiscriminator?: string;
};

export type CanonicalEventDraft =
  | Draft<SessionStartEvent>
  | Draft<SessionEndEvent>
  | Draft<PromptSubmittedEvent>
  | Draft<GenerationStartEvent>
  | Draft<GenerationEndEvent>
  | Draft<ToolStartEvent>
  | Draft<ToolEndEvent>
  | Draft<SubagentStartEvent>
  | Draft<SubagentEndEvent>
  | Draft<CompactionPerformedEvent>
  | Draft<ErrorRaisedEvent>;

/**
 * Helper adapters use to emit canonical events.
 *
 * It owns every field that must stay consistent across an invocation —
 * identity, provenance, sequence numbering, derived event ids — so an adapter
 * cannot accidentally renumber a sequence or attach the wrong session. Sequences
 * are consecutive from `sequenceBase`, which keeps derived ids stable on replay.
 */
export interface EventFactory {
  build(draft: CanonicalEventDraft): CanonicalEvent;
  /** Events built so far, in build order. */
  events(): readonly CanonicalEvent[];
  /** Next sequence number that will be assigned. */
  nextSequence(): number;
  /** Extension keys rejected during building, for diagnostics. */
  droppedExtensionKeys(): readonly string[];
}

export type EventFactoryInput = {
  readonly identity: InvocationIdentity;
  readonly sequenceBase: number;
  readonly context: ProviderContext;
};

export const createEventFactory = (input: EventFactoryInput): EventFactory => {
  const { identity, context } = input;
  const built: CanonicalEvent[] = [];
  const dropped: string[] = [];
  let sequence = input.sequenceBase;

  return {
    build: (draft: CanonicalEventDraft): CanonicalEvent => {
      const { occurredAt, extensions, idDiscriminator, ...rest } = draft;
      const sanitized =
        extensions === undefined
          ? { extensions: {}, droppedKeys: [] as readonly string[] }
          : context.privacy.sanitizeExtensions(extensions);
      dropped.push(...sanitized.droppedKeys);

      const currentSequence = sequence;
      sequence += 1;

      const candidate = {
        ...rest,
        schemaVersion: CANONICAL_SCHEMA_VERSION,
        eventId: context.ids.newEventId({
          invocationId: identity.invocationId,
          sequence: currentSequence,
          eventType: rest.type,
          ...(idDiscriminator === undefined ? {} : { discriminator: idDiscriminator }),
        }),
        invocationId: identity.invocationId,
        sessionId: identity.sessionId,
        sequence: currentSequence,
        occurredAt: occurredAt ?? context.clock.now(),
        provenance: identity.provenance,
        workspace: identity.workspace,
        extensions: sanitized.extensions,
      };

      const parsed = canonicalEventSchema.safeParse(candidate);
      if (!parsed.success) {
        throw OtelHookError.of({
          code: "schema-validation-failed",
          phase: "parsing",
          detail: `event ${rest.type} rejected: ${parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "<root>"} ${issue.message}`)
            .join("; ")}`.slice(0, 480),
          details: { "event.type": rest.type, "event.sequence": currentSequence },
        });
      }
      built.push(parsed.data);
      return parsed.data;
    },
    events: (): readonly CanonicalEvent[] => [...built],
    nextSequence: (): number => sequence,
    droppedExtensionKeys: (): readonly string[] => [...dropped],
  };
};
