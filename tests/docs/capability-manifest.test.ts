import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { runProvidersCommand } from "../../src/cli/providers.js";
import type { CliIo } from "../../src/cli/context.js";
import {
  buildCapabilityManifest,
  renderCapabilityManifestText,
  renderCapabilityMatrixMarkdown,
  renderSignalCapabilityTable,
  serializeCapabilityManifest,
  SIGNAL_CAPABILITY_ROWS,
  stdoutProtocolLabel,
} from "../../src/cli/capability-manifest.js";
import { logSignalsForLifecycleEvents } from "../../src/telemetry/log-records.js";
import type { CanonicalEventType } from "../../src/model/events.js";
import { DIVERGENCE_MANIFEST } from "../parity/divergence-manifest.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

const readRepo = (relativePath: string): Promise<string> =>
  readFile(path.join(REPO_ROOT, relativePath), "utf8");

const markedRegion = (source: string, start: string, end: string): string => {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end);
  expect(startAt, start).toBeGreaterThanOrEqual(0);
  expect(endAt, end).toBeGreaterThan(startAt);
  return source.slice(startAt + start.length, endAt).replace(/^\n/, "").replace(/\n$/, "");
};

const captureIo = (): { readonly io: CliIo; readonly text: () => string } => {
  let out = "";
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      out += String(chunk);
      callback();
    },
  });
  const stderr = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  return {
    text: () => out,
    io: {
      argv: [],
      env: {},
      stdin: Readable.from([]),
      stdout,
      stderr,
    },
  };
};

const packageExportSpecifiers = (pkg: { readonly name: string; readonly exports: Readonly<Record<string, unknown>> }): readonly string[] =>
  Object.keys(pkg.exports).map((key) => (key === "." ? pkg.name : `${pkg.name}${key.slice(1)}`));

type NumberedLimitation = { readonly n: number; readonly text: string };

const parseKnownLimitations = (section: string): readonly NumberedLimitation[] => {
  const items: { n: number; lines: string[] }[] = [];
  let current: { n: number; lines: string[] } | undefined;
  for (const line of section.split("\n")) {
    const match = /^(\d+)\. (.*)$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      if (current !== undefined) {
        items.push(current);
      }
      current = { n: Number(match[1]), lines: [match[2]] };
      continue;
    }
    if (current !== undefined) {
      current.lines.push(line);
    }
  }
  if (current !== undefined) {
    items.push(current);
  }
  return items.map((item) => ({ n: item.n, text: item.lines.join("\n") }));
};

const renderUpstreamDivergences = (): string => {
  const rows = DIVERGENCE_MANIFEST.map(
    (entry) => `| \`${entry.id}\` | ${entry.dimension} | ${entry.title.replaceAll("|", "\\|")} |`,
  );
  return ["| Id | Dimension | Title |", "| --- | --- | --- |", ...rows].join("\n");
};

describe("provider capability manifest", () => {
  const manifest = buildCapabilityManifest();

  it("derives log signals, stdout, and registration from adapter declarations", () => {
    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.exportSignals).toEqual({
      traces: "otlp-http-protobuf",
      logs: "otlp-http-protobuf",
      metrics: "unsupported",
    });
    expect(manifest.providers.map((provider) => provider.id)).toEqual([
      "antigravity",
      "claude-code",
      "codex",
      "cursor",
      "gemini-cli",
    ]);

    const cursor = manifest.providers.find((provider) => provider.id === "cursor");
    expect(cursor?.stdoutProtocol).toBe("provider-json");
    expect(cursor?.registrationLocation).toBe("global-and-project");
    expect(
      manifest.providers
        .filter((provider) => provider.stdoutProtocol === "provider-json")
        .map((provider) => provider.id),
    ).toEqual(["cursor"]);

    const antigravity = manifest.providers.find((provider) => provider.id === "antigravity");
    expect(antigravity?.maturity).toBe("experimental");
    expect(antigravity?.registrationLocation).toBe("settings-file");
    expect(antigravity?.agent).toBe("Google Antigravity");

    const codex = manifest.providers.find((provider) => provider.id === "codex");
    expect(codex?.cumulativeUsageSeries).toBe("session-lifetime");

    for (const provider of manifest.providers) {
      expect(provider.logSignals).toEqual(
        logSignalsForLifecycleEvents(provider.lifecycleEvents as readonly CanonicalEventType[]),
      );
      expect(provider.registrationSupported).toBe(true);
    }
  });

  it("prints JSON and text from the same manifest", () => {
    const json = captureIo();
    expect(
      runProvidersCommand({ name: "providers", json: true, includeExperimental: true }, json.io),
    ).toBe(0);
    expect(JSON.parse(json.text())).toEqual(manifest);

    const text = captureIo();
    expect(
      runProvidersCommand({ name: "providers", json: false, includeExperimental: true }, text.io),
    ).toBe(0);
    expect(text.text()).toBe(renderCapabilityManifestText(manifest));
    expect(text.text()).toContain("manifest version   1");
    expect(text.text()).toContain("metrics=unsupported");
    for (const provider of manifest.providers) {
      expect(text.text()).toContain(stdoutProtocolLabel(provider.stdoutProtocol));
      expect(text.text()).toContain(provider.registrationLocation);
      expect(text.text()).toContain(provider.logSignals.join(", ") || "(none)");
    }

    const stable = captureIo();
    runProvidersCommand({ name: "providers", json: true, includeExperimental: false }, stable.io);
    const stableManifest = JSON.parse(stable.text()) as { providers: readonly { id: string }[] };
    expect(stableManifest.providers.map((provider) => provider.id)).not.toContain("antigravity");
  });

  it("keeps the committed manifest, README matrix, and log-signal table in step", async () => {
    expect(await readRepo("docs/provider-capability-manifest.json")).toBe(
      serializeCapabilityManifest(manifest),
    );

    const readme = await readRepo("README.md");
    expect(markedRegion(readme, "<!-- capability-matrix:start -->", "<!-- capability-matrix:end -->")).toBe(
      renderCapabilityMatrixMarkdown(manifest),
    );

    const mapping = await readRepo("docs/canonical-log-mapping.md");
    expect(
      markedRegion(mapping, "<!-- log-signal-capabilities:start -->", "<!-- log-signal-capabilities:end -->"),
    ).toBe(renderSignalCapabilityTable());

    for (const row of SIGNAL_CAPABILITY_ROWS) {
      const signals = logSignalsForLifecycleEvents(row.events)
        .map((signal) => `\`${signal}\``)
        .join(", ");
      expect(renderSignalCapabilityTable()).toContain(`| ${row.label} | ${signals} |`);
    }
  });

  it("names every upstream divergence in the compatibility policy", async () => {
    const policy = await readRepo("docs/compatibility-policy.md");
    expect(
      markedRegion(policy, "<!-- upstream-divergences:start -->", "<!-- upstream-divergences:end -->"),
    ).toBe(renderUpstreamDivergences());
    expect(DIVERGENCE_MANIFEST.map((entry) => entry.id)).toEqual([
      "DIVERGENCE-001",
      "DIVERGENCE-002",
      "DIVERGENCE-003",
      "DIVERGENCE-004",
      "DIVERGENCE-005",
      "DIVERGENCE-006",
      "DIVERGENCE-007",
      "DIVERGENCE-008",
      "DIVERGENCE-009",
      "DIVERGENCE-010",
    ]);
  });

  it("documents the same public exports as package.json and the README", async () => {
    const pkg = JSON.parse(await readRepo("package.json")) as {
      name: string;
      exports: Record<string, unknown>;
    };
    const expected = [...packageExportSpecifiers(pkg)].sort();

    const readme = await readRepo("README.md");
    const entryPoints = readme.slice(readme.indexOf("### Entry points"), readme.indexOf("## Registration planners"));
    const readmeSpecifiers = [...entryPoints.matchAll(/^\| `(@osfactory\/otel-hook[^`]*)`/gm)].map(
      (match) => match[1] ?? "",
    );
    expect([...readmeSpecifiers].sort()).toEqual(expected);

    const policy = await readRepo("docs/compatibility-policy.md");
    const surface = policy.slice(policy.indexOf("## Public API surface"), policy.indexOf("## Package shape"));
    const policySpecifiers = [...surface.matchAll(/^- `(@osfactory\/otel-hook[^`]*)`$/gm)].map(
      (match) => match[1] ?? "",
    );
    expect([...policySpecifiers].sort()).toEqual(expected);
  });

  it("numbers known limitations from 1 with no gaps, and resolves cross-references", async () => {
    const readme = await readRepo("README.md");
    const section = readme.slice(readme.indexOf("## Known limitations"), readme.indexOf("## Architecture decisions"));
    const items = parseKnownLimitations(section);
    expect(items.length).toBeGreaterThanOrEqual(13);
    expect(items.map((item) => item.n)).toEqual(items.map((_, index) => index + 1));
    expect(items[1]?.text).toMatch(/at-least-once/);
    expect(items[6]?.text).toMatch(/Cursor/);
    expect(items[9]?.text).toMatch(/OTLP HTTP\/protobuf/);
    expect(items[9]?.text).toMatch(/no metrics pipeline/);

    const docs = (await readdir(path.join(REPO_ROOT, "docs"))).filter((name) => name.endsWith(".md"));
    const files = ["README.md", ...docs.map((name) => path.join("docs", name))];
    const references: { file: string; n: number }[] = [];
    for (const file of files) {
      const source = await readRepo(file);
      for (const match of source.matchAll(/limitation (\d+)/gi)) {
        const raw = match[1];
        if (raw !== undefined) {
          references.push({ file, n: Number(raw) });
        }
      }
    }
    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      const item = items.find((candidate) => candidate.n === reference.n);
      expect(item, `${reference.file} limitation ${String(reference.n)}`).toBeDefined();
    }
  });
});
