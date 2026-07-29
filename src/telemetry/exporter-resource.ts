import { resourceFromAttributes, type Resource } from "@opentelemetry/resources";
import type { Attributes } from "@opentelemetry/api";

import {
  checkResourceAttributeKey,
  isReservedResourceAttributeKey,
  MAX_RESOURCE_ATTRIBUTE_VALUE_LENGTH,
  MAX_RESOURCE_ATTRIBUTES,
  sanitizeResourceAttributes,
} from "../config/resource-attributes.js";
import type { ExporterPolicy } from "../config/schema.js";
import { MAX_IDENTIFIER_LENGTH } from "../model/primitives.js";

/**
 * The OTLP `Resource` every record of a signal is exported under.
 *
 * Shared by the trace and log sinks rather than written twice: a resource carries
 * the service identity, so two sinks disagreeing about how it is built or
 * re-validated would attribute the same installation's two signals to two
 * services — and the divergence would only be visible in a backend, long after.
 */

/**
 * Resource for the live path, from exporter policy.
 *
 * Custom attributes first, then service identity: spread order makes the policy
 * fields structurally unoverridable. `sanitizeResourceAttributes` already drops
 * the reserved keys, so this is belt-and-braces for a caller who hand-built an
 * `ExporterPolicy` without running it through the schema — but between them,
 * `service.name` can only ever come from policy.
 */
export const resourceFromExporterPolicy = (policy: ExporterPolicy): Resource =>
  resourceFromAttributes({
    ...sanitizeResourceAttributes(policy.resourceAttributes),
    "service.name": policy.serviceName,
    ...(policy.serviceNamespace === undefined
      ? {}
      : { "service.namespace": policy.serviceNamespace }),
  });

/**
 * A spool file is a plain JSON file in a state directory, so everything read back
 * out of one is untrusted input — it can be hand-edited, truncated, or written by
 * an older release with a different schema. These bounds mirror the live path's,
 * because "what the exporter would have refused from a flag" and "what it accepts
 * from disk" diverging is the whole vulnerability.
 */
const isReplayableValue = (value: unknown): value is string | number | boolean =>
  (typeof value === "string" && value.length <= MAX_RESOURCE_ATTRIBUTE_VALUE_LENGTH) ||
  (typeof value === "number" && Number.isFinite(value)) ||
  typeof value === "boolean";

/**
 * Validate a service identity read back from a spool file.
 *
 * `service.name` decides which service every replayed record is attributed to, so
 * a spool that could set it freely could attribute this installation's telemetry
 * to somebody else's service — the one resource field where a forged value is a
 * reporting-integrity problem rather than a cosmetic one. It is therefore held to
 * the same contract as the typed policy field: a non-empty string within
 * {@link MAX_IDENTIFIER_LENGTH}. Anything else is not "replayed as recorded", it is
 * discarded in favour of the draining process's own policy.
 */
const replayableServiceIdentity = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH
    ? value
    : undefined;

/**
 * Rebuild the resource a spooled batch was recorded with.
 *
 * A recorded `service.name` is a fact about the process that made the observation,
 * not about the one draining the spool, so a *valid* one is replayed as recorded.
 * But every field is re-validated on the way out, at the same bounds the live path
 * enforces: custom keys must pass {@link checkResourceAttributeKey} (which refuses
 * reserved and secret-looking names), values must be primitives within the length
 * bound, the custom count is capped, and the two reserved service fields must look
 * like the identifiers they are. A batch that fails the service check falls back to
 * the live policy rather than exporting with no service identity, because a resource
 * without `service.name` is rejected or bucketed as "unknown_service" by most
 * collectors — losing the batch to a tampered byte would make the validation itself
 * the outage.
 */
export const replayResource = (attributes: Attributes, policy: ExporterPolicy): Resource => {
  const safe: Record<string, string | number | boolean> = {};
  let customCount = 0;
  for (const [key, value] of Object.entries(attributes)) {
    if (isReservedResourceAttributeKey(key)) {
      // Handled below against the policy fallback, never copied verbatim.
      continue;
    }
    if (!isReplayableValue(value)) {
      continue;
    }
    if (checkResourceAttributeKey(key) !== undefined || customCount >= MAX_RESOURCE_ATTRIBUTES) {
      continue;
    }
    customCount += 1;
    safe[key] = value;
  }

  // Reserved keys last and unconditionally, so a spooled custom attribute can
  // never occupy the slot a service field is about to be written into.
  const recordedName = replayableServiceIdentity(attributes["service.name"]);
  const recordedNamespace = replayableServiceIdentity(attributes["service.namespace"]);
  safe["service.name"] = recordedName ?? policy.serviceName;
  const namespace = recordedNamespace ?? policy.serviceNamespace;
  if (namespace !== undefined) {
    safe["service.namespace"] = namespace;
  }

  return resourceFromAttributes(safe);
};
