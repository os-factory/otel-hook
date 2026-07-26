import { z } from "zod";

import type { AttributionOutcome, AttributionReason, OtelHookErrorInfo } from "../errors/index.js";
import { canonicalEventTypeSchema, type CanonicalEvent, type CanonicalEventType } from "../model/events.js";
import type { IdentityClaim, InvocationIdentity } from "../model/identity.js";
import {
  detectionConfidenceSchema,
  nonEmptyStringSchema,
  providerIdSchema,
  resolvedProviderIdSchema,
  type ProviderId,
  type ResolvedProviderId,
  type SourceTransport,
} from "../model/primitives.js";
import { cacheCreationAccountingSchema, usageTemporalitySchema, type UsageTemporality } from "../model/usage.js";
import type { PrivacyLimits } from "../privacy/policy.js";
import type { PrivacyService } from "../privacy/service.js";
import type { Clock, IdGenerator, Logger } from "../runtime/ports.js";

/** Raw input offered to adapters. `payload` is `unknown` on purpose. */
export type ProviderDetectionInput = {
  /** Decoded but uninterpreted provider payload. Must not escape the adapter. */
  readonly payload: unknown;
  readonly transport: SourceTransport;
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** Caller's assertion of the provider, e.g. from a CLI flag. */
  readonly providerHint?: string;
};

export const providerDetectionSchema = z.strictObject({
  providerId: resolvedProviderIdSchema,
  confidence: detectionConfidenceSchema,
  /**
   * Short, non-sensitive justifications, e.g. `"payload.hook_event_name present"`.
   * Reasons are exported in diagnostics, so they must not quote payload values.
   */
  reasons: z.array(z.string().min(1).max(160)).max(8),
  providerVersion: nonEmptyStringSchema.optional(),
  /** The provider's own name for this event, when the payload states one. */
  sourceEventName: nonEmptyStringSchema.optional(),
});
export type ProviderDetection = z.infer<typeof providerDetectionSchema>;

/**
 * How much of a provider's hook traffic carries an identifier that survives a
 * redelivery.
 *
 * - `none`: no callback carries one. Redelivery is undetectable from the
 *   payload, and deduplication needs a host-supplied delivery id.
 * - `partial`: some callbacks do and some do not — typically per-tool-call and
 *   per-turn events do, while session and compaction edges do not.
 * - `all`: every callback the adapter recognizes carries one.
 *
 * Declared rather than probed for the same reason as the usage capabilities
 * below: "this callback has no stable id" and "this adapter never looked" are
 * indistinguishable downstream, and only the first is safe to build on.
 */
export const deliveryIdentifierSupportSchema = z.enum(["none", "partial", "all"]);
export type DeliveryIdentifierSupport = z.infer<typeof deliveryIdentifierSupportSchema>;

/**
 * Shape a delivery-identity component must have.
 *
 * Deliberately narrow. Provider identifiers, integer counters, hook event
 * names, and ISO-8601 timestamps all satisfy it; prose and filesystem paths do
 * not, because neither spaces nor `/` are allowed. So an adapter that
 * accidentally seeds a delivery identity with a prompt, a tool response, or a
 * home directory produces a *rejected claim* rather than a privacy incident —
 * the guard is structural, not a review convention.
 */
export const DELIVERY_COMPONENT_PATTERN = /^[A-Za-z0-9_.:@+=-]{1,256}$/;

export const deliveryComponentSchema = z
  .string()
  .regex(
    DELIVERY_COMPONENT_PATTERN,
    "delivery component must be identifier-shaped: no whitespace, no path separators",
  );

/** Most identifier-shaped fields one callback identity may be built from. */
export const MAX_DELIVERY_COMPONENTS = 8;

/**
 * An adapter's assertion that this callback has a replay-stable identity.
 *
 * The adapter reports *components* rather than a finished id: it knows which
 * payload fields are trustworthy, and the runtime owns how they are combined,
 * scoped, and digested. That split is what keeps a raw provider identifier from
 * becoming an on-disk key or a diagnostic attribute (see
 * `resolveDeliveryIdentity`).
 *
 * Returning nothing is always safe. Claiming an identity that is not actually
 * stable is not: it makes the runtime suppress a *genuine* second callback as if
 * it were a redelivery, which silently loses telemetry.
 */
export const providerDeliveryClaimSchema = z.strictObject({
  /**
   * The provider's own session/conversation id. Scopes the callback identity, so
   * two sessions reusing one tool-call id never collide.
   */
  sessionId: nonEmptyStringSchema,
  /** The provider's own name for this callback, e.g. `PostToolUse`. */
  sourceEventName: deliveryComponentSchema,
  /**
   * Identifier-shaped payload fields that, together with `sourceEventName`,
   * name this callback within the session exactly once.
   */
  components: z.array(deliveryComponentSchema).min(1).max(MAX_DELIVERY_COMPONENTS).readonly(),
  /**
   * Short, non-sensitive justifications, e.g. `"payload.tool_use_id names one
   * tool call"`. Evidence reaches diagnostics, so it must name fields, never
   * quote their values.
   */
  evidence: z.array(z.string().min(1).max(160)).min(1).max(4).readonly(),
});
export type ProviderDeliveryClaim = z.infer<typeof providerDeliveryClaimSchema>;

/**
 * What an adapter can actually observe.
 *
 * Capabilities are declared rather than probed so consumers can distinguish
 * "this provider reports no cached tokens" from "this session used no cache" —
 * the two look identical in the data.
 */
export const providerCapabilitiesSchema = z.strictObject({
  /** Event types the adapter can produce. */
  lifecycleEvents: z.array(canonicalEventTypeSchema).max(32).readonly(),
  usageTemporality: usageTemporalitySchema,
  reportsCachedInput: z.boolean(),
  reportsCacheCreation: z.boolean(),
  cacheCreationAccounting: cacheCreationAccountingSchema,
  reportsReasoningOutput: z.boolean(),
  reportsProviderTotal: z.boolean(),
  reportsCost: z.boolean(),
  emitsSubagentEvents: z.boolean(),
  emitsCompactionEvents: z.boolean(),
  /** True when the provider reads a structured response from stdout. */
  requiresHookResponse: z.boolean(),
  /** How much of this provider's hook traffic is replay-identifiable. */
  deliveryIdentifier: deliveryIdentifierSupportSchema,
});
export type ProviderCapabilities = z.infer<typeof providerCapabilitiesSchema>;

/** Services an adapter is given. Note the absence of a filesystem or network. */
export type ProviderContext = {
  readonly privacy: PrivacyService;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly limits: PrivacyLimits;
};

export type ProviderIdentityInput = ProviderDetectionInput & {
  readonly detection: ProviderDetection;
};

export type ProviderParseInput = ProviderDetectionInput & {
  readonly detection: ProviderDetection;
  /** Resolved by the core; adapters never resolve identity themselves. */
  readonly identity: InvocationIdentity;
  /**
   * First sequence number the adapter may use. Sequences must be assigned
   * consecutively from here so event ids stay stable across replays.
   */
  readonly sequenceBase: number;
};

export type ProviderParseResult =
  | {
      readonly status: "parsed";
      readonly events: readonly CanonicalEvent[];
      readonly warnings?: readonly string[];
    }
  /** The input was recognized but carries no telemetry. Not an error. */
  | { readonly status: "ignored"; readonly reason: string }
  | { readonly status: "failed"; readonly error: OtelHookErrorInfo };

export const providerHookResponseSchema = z.strictObject({
  /**
   * Always 0. A telemetry hook that can fail the host agent is a liability, so
   * the type forbids expressing anything else (ADR 0004).
   */
  exitCode: z.literal(0),
  /** Protocol response text. Omit to write nothing at all. */
  stdout: z.string().max(8192).optional(),
  /** Non-sensitive diagnostic text for stderr. */
  stderr: z.string().max(8192).optional(),
  /** Declares which of the two stdout contracts this response follows. */
  contract: z.enum(["silent", "provider-protocol"]),
});
export type ProviderHookResponse = z.infer<typeof providerHookResponseSchema>;

/** The silent response: nothing on stdout, success to the host. */
export const SILENT_HOOK_RESPONSE: ProviderHookResponse = Object.freeze({
  exitCode: 0 as const,
  contract: "silent" as const,
});

export type ProviderHookResponseInput = {
  readonly attribution: AttributionOutcome;
  readonly attributionReason?: AttributionReason;
  readonly detection?: ProviderDetection;
  readonly emittedEvents: number;
  readonly errors: readonly OtelHookErrorInfo[];
};

/**
 * Contract every provider adapter implements.
 *
 * The four methods are deliberately separate: detection must be cheap and
 * side-effect free, identity must be expressible as claims the core can
 * arbitrate, parsing must be the only place that reads the payload, and the hook
 * response must be derivable from the outcome alone.
 */
export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly version: string;
  readonly capabilities: ProviderCapabilities;
  /**
   * Report whether this adapter recognizes the input. Must not throw; must not
   * read files or the network. Return `none` rather than guessing.
   */
  detect(input: ProviderDetectionInput, context: ProviderContext): ProviderDetection;
  /**
   * Contribute identity claims. Returning fewer claims is always safe;
   * fabricating a session id is not.
   */
  identify(input: ProviderIdentityInput, context: ProviderContext): readonly IdentityClaim[];
  /**
   * Report this callback's replay-stable identity, when the payload carries one.
   *
   * Called before `parse`, must be cheap and side-effect free, and must not
   * throw. Return `undefined` whenever the payload's identifying fields are
   * absent or would not survive a redelivery — under-reporting costs
   * deduplication, over-reporting loses real telemetry.
   */
  deliveryIdentity?(
    input: ProviderIdentityInput,
    context: ProviderContext,
  ): ProviderDeliveryClaim | undefined;
  /** Interpret the payload into canonical events. */
  parse(input: ProviderParseInput, context: ProviderContext): ProviderParseResult;
  /** Provider-specific hook response for the given outcome. */
  hookResponse(input: ProviderHookResponseInput, context: ProviderContext): ProviderHookResponse;
}

export const adapterSupports = (
  adapter: ProviderAdapter,
  eventType: CanonicalEventType,
): boolean => adapter.capabilities.lifecycleEvents.includes(eventType);

export type AdapterDescription = {
  readonly id: ResolvedProviderId;
  readonly version: string;
  readonly lifecycleEvents: readonly string[];
  readonly usageTemporality: UsageTemporality;
  readonly deliveryIdentifier: DeliveryIdentifierSupport;
};

export const describeAdapter = (adapter: ProviderAdapter): AdapterDescription => ({
  id: adapter.id,
  version: adapter.version,
  lifecycleEvents: [...adapter.capabilities.lifecycleEvents],
  usageTemporality: adapter.capabilities.usageTemporality,
  deliveryIdentifier: adapter.capabilities.deliveryIdentifier,
});

/**
 * Ask an adapter for a delivery claim, containing anything it does wrong.
 *
 * A `deliveryIdentity` that throws, or that returns a claim the schema rejects
 * (a component carrying prose, more components than the cap), degrades to "no
 * stable identity available" rather than failing the invocation: deduplication
 * is an optimization, and the host's telemetry is not.
 */
export const readDeliveryClaim = (
  adapter: ProviderAdapter,
  input: ProviderIdentityInput,
  context: ProviderContext,
): { readonly claim?: ProviderDeliveryClaim; readonly rejection?: string } => {
  if (adapter.deliveryIdentity === undefined) {
    return {};
  }
  let candidate: ProviderDeliveryClaim | undefined;
  try {
    candidate = adapter.deliveryIdentity(input, context);
  } catch {
    return { rejection: `adapter ${adapter.id} threw while reporting a delivery identity` };
  }
  if (candidate === undefined) {
    return {};
  }
  const parsed = providerDeliveryClaimSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      rejection: `adapter ${adapter.id} reported a malformed delivery identity: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"} ${issue.message}`)
        .join("; ")}`.slice(0, 240),
    };
  }
  return { claim: parsed.data };
};

export const asProviderId = (value: string): ProviderId => providerIdSchema.parse(value);

export const unknownDetection = (
  reasons: readonly string[] = ["no adapter recognized the input"],
): ProviderDetection =>
  providerDetectionSchema.parse({
    providerId: "unknown",
    confidence: "none",
    reasons: reasons.slice(0, 8),
  });
