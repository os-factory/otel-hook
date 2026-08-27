#!/usr/bin/env node
/**
 * Assert a provider live-lab run: hook coverage, OTLP canonical events, frozen
 * tokens, and the privacy default (synthetic secret never leaves the process).
 *
 * Provider-specific hook names and usage contracts live on the scenario, not
 * in this checker.
 */

import { fileURLToPath } from "node:url";

const parseJsonl = (text) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`jsonl line ${String(index + 1)} is not JSON: ${error instanceof Error ? error.message : "parse"}`);
      }
    });

const failures = [];
const notes = [];

const expect = (ok, message) => {
  if (!ok) {
    failures.push(message);
  }
};

export const assertLab = (input) => {
  failures.length = 0;
  notes.length = 0;

  const scenario = input.scenario;
  const secret = scenario.secret;
  const requiredHooks = scenario.requiredHookEvents ?? [];
  const requiredTypes = scenario.requiredCanonicalTypes ?? [];
  const agentStdout = input.agentStdout ?? "";
  const agentResult = input.agentResult;
  const agentExitCode = input.agentExitCode;
  const spans = input.spans ?? [];
  const logs = input.logs ?? [];
  const wireText = input.wireText ?? "";

  const hooks = parseJsonl(input.hooksJsonl ?? "");
  const hookNames = hooks.map((row) => row.hook_event_name);
  const types = logs
    .map((record) => record.attributes?.["otelhook.event.type"])
    .filter((value) => typeof value === "string");

  const blob = [input.hooksJsonl ?? "", wireText, agentStdout, JSON.stringify(agentResult ?? null)].join("\n");
  expect(!blob.includes(secret), `synthetic secret leaked into lab artifacts: ${secret}`);

  for (const name of requiredHooks) {
    expect(hookNames.includes(name), `missing hook event ${name} (saw: ${hookNames.join(", ") || "none"})`);
  }

  for (const type of requiredTypes) {
    expect(types.includes(type), `missing OTLP event type ${type} (saw: ${types.join(", ") || "none"})`);
  }

  const toolName = scenario.toolName;
  expect(
    spans.some((span) => span.attributes?.["gen_ai.tool.name"] === toolName || span.name === `tool ${toolName}`),
    `no tool span named ${toolName} (saw: ${spans.map((span) => span.name).join(", ") || "none"})`,
  );

  const promptLogs = logs.filter((record) => record.attributes?.["otelhook.event.type"] === "prompt.submitted");
  for (const record of promptLogs) {
    expect(
      record.body === undefined || record.body === "",
      "prompt.submitted log carried a body; default privacy is omit",
    );
  }

  const stopName = scenario.stopHookEvent ?? "Stop";
  const stopHooks = hooks.filter((row) => row.hook_event_name === stopName);
  expect(stopHooks.length > 0, `wrapper dump has no ${stopName} event`);
  const stop = stopHooks.at(-1);
  if (stop?.had_usage_before_wrapper === true) {
    notes.push(`${stopName} already carried usage; wrapper did not inject`);
  } else if (stop?.usage_attached === true) {
    notes.push(input.provider?.usageContract ?? `wrapper attached mock last-usage onto ${stopName}`);
  } else if (stop !== undefined) {
    notes.push(`${stopName} had no usage and the wrapper did not attach any; token assertion will fail`);
  }

  const generation = [...spans].reverse().find((span) => String(span.name).startsWith("generation"));
  const expected = scenario.canonicalStopUsage;
  if (generation === undefined) {
    failures.push("no generation span in OTLP traces");
  } else if (expected !== undefined) {
    const attrs = generation.attributes ?? {};
    expect(attrs["gen_ai.usage.input_tokens"] === expected.inputTokens, `gen_ai.usage.input_tokens=${JSON.stringify(attrs["gen_ai.usage.input_tokens"])} expected ${String(expected.inputTokens)}`);
    expect(attrs["gen_ai.usage.output_tokens"] === expected.outputTokens, `gen_ai.usage.output_tokens=${JSON.stringify(attrs["gen_ai.usage.output_tokens"])} expected ${String(expected.outputTokens)}`);
    expect(attrs["gen_ai.usage.cache_read.input_tokens"] === expected.cachedInputTokens, `gen_ai.usage.cache_read.input_tokens=${JSON.stringify(attrs["gen_ai.usage.cache_read.input_tokens"])} expected ${String(expected.cachedInputTokens)}`);
    expect(attrs["gen_ai.usage.cache_creation.input_tokens"] === expected.cacheCreationInputTokens, `gen_ai.usage.cache_creation.input_tokens=${JSON.stringify(attrs["gen_ai.usage.cache_creation.input_tokens"])} expected ${String(expected.cacheCreationInputTokens)}`);
  }

  if (agentStdout.length > 0) {
    expect(agentStdout.includes(scenario.finalText), `agent print output did not contain ${scenario.finalText}`);
  }

  const printUsage = scenario.agentPrintUsage;
  const actualPrintUsage = agentResult?.usage;
  if (printUsage !== undefined && actualPrintUsage !== undefined) {
    for (const [key, value] of Object.entries(printUsage)) {
      expect(
        actualPrintUsage[key] === value,
        `agent print usage.${key}=${JSON.stringify(actualPrintUsage[key])} expected ${JSON.stringify(value)} (sum of mocked turns)`,
      );
    }
  }

  expect(agentExitCode === 0, `agent exited ${String(agentExitCode)}`);

  return {
    ok: failures.length === 0,
    failures: [...failures],
    notes: [...notes],
    summary: {
      hookEvents: hookNames,
      canonicalTypes: types,
      spanNames: spans.map((span) => span.name),
      stopUsageSource:
        stop?.had_usage_before_wrapper === true ? "agent" : stop?.usage_attached === true ? "wrapper" : "absent",
      generationUsage: generation === undefined ? null : generation.attributes,
    },
  };
};

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const { readFile } = await import("node:fs/promises");
  const reportPath = process.argv[2];
  if (reportPath === undefined) {
    process.stderr.write("usage: assert.mjs <lab-report.json>\n");
    process.exit(2);
  }
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const result = assertLab(report);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.ok ? 0 : 1);
}
