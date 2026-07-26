import type { DeliveryIdentifierSupport, ProviderDeliveryClaim } from "../providers/adapter.js";
import type { IdGenerator } from "./ports.js";

/**
 * Where a delivery identity came from.
 *
 * `host` is an id the embedding host passed in; `provider` is one normalized
 * from payload fields the selected adapter vouched for. The two are kept
 * distinguishable because they carry different guarantees: a host id is unique
 * by construction, a provider-derived one is only as good as the adapter's
 * evidence.
 */
export type DeliveryOrigin = "host" | "provider";

/**
 * A delivery identity reduced to the two opaque strings deduplication needs.
 *
 * Both are digests, never raw payload values. That matters because the pair
 * becomes a state-store key and a diagnostic attribute: a provider's session id,
 * tool-call id, or turn id would otherwise be written to disk and logged as a
 * side effect of deduplication, which is not a disclosure anybody asked for.
 */
export type ResolvedDeliveryIdentity = {
  /** Namespace the callback id is unique within. */
  readonly scope: string;
  /** Opaque identity of this callback within that scope. */
  readonly callbackId: string;
  readonly origin: DeliveryOrigin;
  /** Non-sensitive justifications, for diagnostics. Empty for a host id. */
  readonly evidence: readonly string[];
};

/** Why no replay-stable delivery identity could be established. */
export type DeliveryUnavailableReason =
  /** No adapter was selected, so nothing could vouch for an identifier. */
  | "provider-unattributed"
  /** The adapter declares that no callback of this provider carries one. */
  | "provider-declares-none"
  /** The adapter supports some callbacks, but not this one. */
  | "callback-not-identifiable"
  /** The adapter offered an identity that failed the contract's own guards. */
  | "claim-rejected"
  /**
   * An identity was established but the state store could not be read or written,
   * so nothing could be claimed against it.
   */
  | "state-unavailable";

export type DeliveryResolution =
  | { readonly status: "resolved"; readonly identity: ResolvedDeliveryIdentity }
  | {
      readonly status: "unavailable";
      readonly reason: DeliveryUnavailableReason;
      /** Present once a provider has been selected. */
      readonly providerId?: string;
      /** The adapter's declared coverage, when there is an adapter. */
      readonly capability?: DeliveryIdentifierSupport;
      /** Detail for a rejected claim. Never contains payload values. */
      readonly detail?: string;
    };

/**
 * Scope prefix for provider-derived identities.
 *
 * Kept distinct from a host-chosen scope so the two id spaces cannot be
 * confused, and so a host that starts supplying `--callback-id` does not inherit
 * whatever the adapter had already recorded for the same callbacks.
 */
const PROVIDER_SCOPE_PREFIX = "provider-session";

/**
 * Namespace a host-supplied delivery id.
 *
 * Deliberately *not* scoped by session or installation: the host documented its
 * id as unique between distinct callbacks, so narrowing the scope here would
 * make a host id that repeats across two sessions stop being recognized as the
 * redelivery the host said it was.
 */
export const hostDeliveryIdentity = (
  callbackId: string,
  scope?: string,
): ResolvedDeliveryIdentity => ({
  scope: scope ?? "delivery",
  callbackId,
  origin: "host",
  evidence: [],
});

/**
 * Reduce an adapter's delivery claim to an opaque, replay-stable identity.
 *
 * Scoping runs provider id, installation, and the provider's own session id
 * through the digest, so the same tool-call id observed by two installations, two
 * providers, or two sessions is three different callbacks. The callback digest
 * covers the event name and the adapter's components, so a `PreToolUse` and a
 * `PostToolUse` sharing one `tool_use_id` stay distinct.
 *
 * The digest comes from the injected {@link IdGenerator}, which is
 * content-addressed by default — that is precisely what makes the identity
 * survive a process restart: a later process with the same namespace recomputes
 * the identical pair without reading any state.
 */
export const resolveDeliveryIdentity = (input: {
  readonly ids: IdGenerator;
  readonly providerId: string;
  readonly installationId: string;
  readonly claim: ProviderDeliveryClaim;
}): ResolvedDeliveryIdentity => {
  const { ids, providerId, installationId, claim } = input;
  return {
    scope: `${PROVIDER_SCOPE_PREFIX}:${ids.newOpaqueId([
      "delivery-scope",
      providerId,
      installationId,
      claim.sessionId,
    ])}`,
    callbackId: ids.newOpaqueId([
      "delivery-callback",
      providerId,
      claim.sessionId,
      claim.sourceEventName,
      ...claim.components,
    ]),
    origin: "provider",
    evidence: [...claim.evidence],
  };
};
