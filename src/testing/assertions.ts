import { isContentFactConsistent, type ContentDisclosure, type ContentFact } from "../model/content.js";
import type { CanonicalEvent } from "../model/events.js";

/** Every content fact attached to an event, regardless of field name. */
export const collectEventContentFacts = (event: CanonicalEvent): readonly ContentFact[] => {
  const facts: ContentFact[] = [];
  const push = (fact: ContentFact | undefined): void => {
    if (fact !== undefined) {
      facts.push(fact);
    }
  };
  switch (event.type) {
    case "prompt.submitted":
      push(event.content);
      break;
    case "generation.start":
      facts.push(...(event.inputContent ?? []));
      break;
    case "generation.end":
      facts.push(...(event.outputContent ?? []));
      break;
    case "tool.start":
      push(event.input);
      break;
    case "tool.end":
      push(event.output);
      break;
    case "error.raised":
      push(event.message);
      break;
    default:
      break;
  }
  return facts;
};

/** Disclosed text across a batch, for assertions about what escaped. */
export const collectContentText = (events: readonly CanonicalEvent[]): readonly string[] => {
  const texts: string[] = [];
  for (const event of events) {
    for (const fact of collectEventContentFacts(event)) {
      if (fact.text !== undefined) {
        texts.push(fact.text);
      }
    }
  }
  return texts;
};

export type ContentDisclosureViolation = {
  readonly eventId: string;
  readonly eventType: string;
  readonly kind: string;
  readonly disclosure: ContentDisclosure;
  readonly reason: "unexpected-disclosure" | "inconsistent-fact";
};

/**
 * Find content facts that disclose more than the expected mode allows.
 *
 * Provider suites are expected to assert this returns nothing under the default
 * `omit` policy.
 */
export const findDisclosureViolations = (
  events: readonly CanonicalEvent[],
  expected: ContentDisclosure = "omitted",
): readonly ContentDisclosureViolation[] => {
  const violations: ContentDisclosureViolation[] = [];
  for (const event of events) {
    for (const fact of collectEventContentFacts(event)) {
      if (fact.disclosure !== expected) {
        violations.push({
          eventId: event.eventId,
          eventType: event.type,
          kind: fact.kind,
          disclosure: fact.disclosure,
          reason: "unexpected-disclosure",
        });
        continue;
      }
      if (!isContentFactConsistent(fact)) {
        violations.push({
          eventId: event.eventId,
          eventType: event.type,
          kind: fact.kind,
          disclosure: fact.disclosure,
          reason: "inconsistent-fact",
        });
      }
    }
  }
  return violations;
};

/**
 * Search a serialized batch for a literal substring.
 *
 * Used to prove a secret or prompt fragment is absent from everything a sink
 * would receive, including attributes and extensions.
 */
export const batchContains = (events: readonly CanonicalEvent[], needle: string): boolean =>
  JSON.stringify(events).includes(needle);
