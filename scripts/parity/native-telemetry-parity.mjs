#!/usr/bin/env node
// Compare a provider's native OpenTelemetry output with otel-hook's output for
// the same session, category by category, and flag personal data on either side.
//
// Usage:
//   node scripts/parity/native-telemetry-parity.mjs --provider claude-code \
//     --native native.otlp.jsonl --otel-hook otel-hook.otlp.jsonl \
//     [--mapping scripts/parity/native-parity-categories.json] [--json] [--fail-on-gap]
//
// Inputs are capture files written by capture-receiver.mjs (format documented in
// otlp-capture.mjs). What counts as evidence for each category is data, in
// native-parity-categories.json, so a new provider or a renamed native metric is
// an edit to that file, not to this script.
//
// Observed verdict per category:
//   both          native and otel-hook both emitted evidence
//   gap           native emitted evidence, otel-hook did not
//   otel-hook-only otel-hook emitted evidence, native did not
//   neither       nothing on either side in this capture
// The documented status (covered / partial / derivable / impossible / unverified)
// is echoed from the mapping file next to it: a capture can show that both sides
// *have* token counts, not that they *agree*, so "partial" stays a reviewed call.
//
// Personal data is reported by attribute key and count only. Values are never
// printed, so the report itself is safe to paste into an issue.
//
// Exit status: 0 on success, 1 with --fail-on-gap when any category is a gap,
// 2 on a usage or input error.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { loadCapture } from "./otlp-capture.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MAPPING = path.join(__dirname, "native-parity-categories.json");

const asList = (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

/** Whether one normalized item satisfies one matcher from the mapping file. */
export const matches = (matcher, item) => {
  if (matcher.signal !== undefined && matcher.signal !== item.signal) {
    return false;
  }
  if (matcher.name !== undefined && !asList(matcher.name).includes(item.name)) {
    return false;
  }
  if (matcher.namePattern !== undefined && !new RegExp(matcher.namePattern).test(item.name)) {
    return false;
  }
  for (const key of asList(matcher.hasAttributes)) {
    if (item.attributes[key] === undefined) {
      return false;
    }
  }
  for (const [key, expected] of Object.entries(matcher.attributes ?? {})) {
    if (!asList(expected).includes(item.attributes[key])) {
      return false;
    }
  }
  for (const [key, rejected] of Object.entries(matcher.notAttributes ?? {})) {
    if (asList(rejected).includes(item.attributes[key])) {
      return false;
    }
  }
  if (matcher.statusError === true && item.statusCode !== 2) {
    return false;
  }
  if (matcher.minSeverity !== undefined && (item.severityNumber ?? 0) < matcher.minSeverity) {
    return false;
  }
  return true;
};

const itemLabel = (item) => `${item.signal}:${item.name === "" ? "(unnamed)" : item.name}`;

const evidenceFor = (matchers, items) => {
  const hits = items.filter((item) => matchers.some((matcher) => matches(matcher, item)));
  return {
    count: hits.length,
    names: [...new Set(hits.map(itemLabel))].sort(),
  };
};

const verdictOf = (native, hook) => {
  if (native.count > 0 && hook.count > 0) return "both";
  if (native.count > 0) return "gap";
  if (hook.count > 0) return "otel-hook-only";
  return "neither";
};

/** Personal-data attribute keys on one side; values are deliberately dropped. */
export const scanPersonalData = (items, rules) => {
  const keys = new Set(rules.attributeKeys ?? []);
  const keyPatterns = (rules.keyPatterns ?? []).map((pattern) => new RegExp(pattern, "i"));
  const valuePatterns = (rules.valuePatterns ?? []).map((rule) => ({
    name: rule.name,
    pattern: new RegExp(rule.pattern),
  }));
  const found = new Map();
  const note = (attribute, where, reason) => {
    const id = `${where}\u0000${attribute}`;
    const entry = found.get(id) ?? { attribute, where, reason, count: 0 };
    entry.count += 1;
    found.set(id, entry);
  };
  for (const item of items) {
    for (const [where, attributes] of [
      ["attribute", item.attributes],
      ["resource", item.resourceAttributes],
    ]) {
      for (const [key, value] of Object.entries(attributes)) {
        if (keys.has(key)) {
          note(key, where, "known personal-data key");
          continue;
        }
        if (keyPatterns.some((pattern) => pattern.test(key))) {
          note(key, where, "key looks like personal data");
          continue;
        }
        const valueRule =
          typeof value === "string" ? valuePatterns.find((rule) => rule.pattern.test(value)) : undefined;
        if (valueRule !== undefined) {
          note(key, where, `value looks like ${valueRule.name}`);
        }
      }
    }
  }
  return [...found.values()].sort((a, b) => a.attribute.localeCompare(b.attribute) || a.where.localeCompare(b.where));
};

/** Compare two normalized captures for one provider under a mapping. */
export const compareCaptures = ({ provider, mapping, native, otelHook }) => {
  const providerMapping = mapping.providers?.[provider];
  if (providerMapping === undefined) {
    throw new Error(
      `provider "${provider}" has no entry in the mapping; known: ${Object.keys(mapping.providers ?? {}).join(", ")}`,
    );
  }
  const nativeMatchedItems = new Set();
  const hookMatchedItems = new Set();
  const categories = mapping.categories.map((category) => {
    const nativeMatchers = providerMapping.native?.[category.id] ?? [];
    const hookMatchers = providerMapping.otelHook?.[category.id] ?? mapping.otelHook?.[category.id] ?? [];
    for (const item of native.items) {
      if (nativeMatchers.some((matcher) => matches(matcher, item))) nativeMatchedItems.add(item);
    }
    for (const item of otelHook.items) {
      if (hookMatchers.some((matcher) => matches(matcher, item))) hookMatchedItems.add(item);
    }
    const nativeEvidence = evidenceFor(nativeMatchers, native.items);
    const hookEvidence = evidenceFor(hookMatchers, otelHook.items);
    const documented = providerMapping.documented?.[category.id];
    return {
      id: category.id,
      title: category.title,
      native: { ...nativeEvidence, mapped: nativeMatchers.length > 0 },
      otelHook: { ...hookEvidence, mapped: hookMatchers.length > 0 },
      observed: verdictOf(nativeEvidence, hookEvidence),
      documented: documented?.status ?? "unverified",
      ...(documented?.note === undefined ? {} : { note: documented.note }),
    };
  });
  const unmatched = (items, matched) =>
    [...new Set(items.filter((item) => !matched.has(item)).map(itemLabel))].sort();
  const rules = mapping.personalData ?? {};
  return {
    provider,
    native: { meta: native.meta, requests: native.requests, items: native.items.length },
    otelHook: { meta: otelHook.meta, requests: otelHook.requests, items: otelHook.items.length },
    categories,
    summary: Object.fromEntries(
      ["both", "gap", "otel-hook-only", "neither"].map((verdict) => [
        verdict,
        categories.filter((category) => category.observed === verdict).map((category) => category.id),
      ]),
    ),
    // Native names no category claims: the first sign a provider added or
    // renamed something the mapping (and the parity doc) should account for.
    unmappedNative: unmatched(native.items, nativeMatchedItems),
    unmappedOtelHook: unmatched(otelHook.items, hookMatchedItems),
    personalData: {
      native: scanPersonalData(native.items, rules),
      otelHook: scanPersonalData(otelHook.items, rules),
    },
  };
};

const pad = (value, width) => String(value).padEnd(width);

/** A plain-text rendering of a report, for a terminal or an issue comment. */
export const renderReport = (report) => {
  const lines = [];
  const metaLine = (side, info) =>
    `${side}: ${String(info.requests)} request(s), ${String(info.items)} item(s)` +
    (info.meta.synthetic === true ? " [SYNTHETIC]" : "") +
    (info.meta.providerVersion === undefined ? "" : ` provider ${String(info.meta.providerVersion)}`) +
    (info.meta.otelHookVersion === undefined ? "" : ` otel-hook ${String(info.meta.otelHookVersion)}`);
  lines.push(`Native telemetry parity: ${report.provider}`);
  lines.push(metaLine("native   ", report.native));
  lines.push(metaLine("otel-hook", report.otelHook));
  lines.push("");
  const width = Math.max(...report.categories.map((category) => category.id.length), 8) + 2;
  lines.push(`${pad("category", width)}${pad("observed", 16)}${pad("native", 8)}${pad("hook", 8)}documented`);
  for (const category of report.categories) {
    const count = (side) => (side.mapped ? String(side.count) : "-");
    lines.push(
      `${pad(category.id, width)}${pad(category.observed, 16)}${pad(count(category.native), 8)}` +
        `${pad(count(category.otelHook), 8)}${category.documented}`,
    );
  }
  lines.push("");
  lines.push(`gaps (native only): ${report.summary.gap.join(", ") || "none"}`);
  lines.push(`unmapped native names: ${report.unmappedNative.join(", ") || "none"}`);
  lines.push(`unmapped otel-hook names: ${report.unmappedOtelHook.join(", ") || "none"}`);
  lines.push("");
  for (const [side, entries] of [
    ["native", report.personalData.native],
    ["otel-hook", report.personalData.otelHook],
  ]) {
    lines.push(`personal data (${side}): ${entries.length === 0 ? "none found" : ""}`);
    for (const entry of entries) {
      lines.push(`  ${entry.attribute} [${entry.where}] x${String(entry.count)}: ${entry.reason}`);
    }
  }
  return `${lines.join("\n")}\n`;
};

export const runParity = async ({ provider, nativeFile, otelHookFile, mappingFile = DEFAULT_MAPPING }) => {
  const mapping = JSON.parse(await readFile(mappingFile, "utf8"));
  const [native, otelHook] = await Promise.all([loadCapture(nativeFile), loadCapture(otelHookFile)]);
  return compareCaptures({ provider, mapping, native, otelHook });
};

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        provider: { type: "string" },
        native: { type: "string" },
        "otel-hook": { type: "string" },
        mapping: { type: "string" },
        json: { type: "boolean", default: false },
        "fail-on-gap": { type: "boolean", default: false },
      },
    }));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
  if (values.provider === undefined || values.native === undefined || values["otel-hook"] === undefined) {
    process.stderr.write(
      "usage: native-telemetry-parity.mjs --provider <id> --native <capture> --otel-hook <capture> " +
        "[--mapping <file>] [--json] [--fail-on-gap]\n",
    );
    process.exit(2);
  }
  let report;
  try {
    report = await runParity({
      provider: values.provider,
      nativeFile: values.native,
      otelHookFile: values["otel-hook"],
      ...(values.mapping === undefined ? {} : { mappingFile: values.mapping }),
    });
  } catch (error) {
    process.stderr.write(`native-telemetry-parity: ${error.message}\n`);
    process.exit(2);
  }
  process.stdout.write(values.json ? `${JSON.stringify(report, null, 2)}\n` : renderReport(report));
  process.exitCode = values["fail-on-gap"] && report.summary.gap.length > 0 ? 1 : 0;
}
