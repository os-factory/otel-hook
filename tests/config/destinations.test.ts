import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONFIG,
  DEFAULT_EXPORTER_POLICY,
  DEFAULT_SPOOL_POLICY,
  describeExportDestinations,
  describeResolvedConfig,
  effectiveSpoolPolicy,
  otelHookConfigPatchSchema,
  parseEnvironmentConfig,
  resolveConfig,
  resolveDestinationHeaders,
  resolveExportDestinations,
  type ExporterPolicy,
  type OtelHookConfigPatch,
} from "../../src/index.js";

const LANGFUSE = {
  name: "langfuse",
  endpoint: "https://langfuse.example/api/public/otel/v1/traces",
  headers: { authorization: "env:LANGFUSE_AUTH" },
  signals: ["traces"],
} as const;

const COLLECTOR = {
  name: "team-collector",
  endpoint: "http://127.0.0.1:4318/v1/traces",
} as const;

const resolveOk = (layers: Parameters<typeof resolveConfig>[0]) => {
  const resolution = resolveConfig(layers);
  if (resolution.status !== "ok") {
    throw new Error(JSON.stringify(resolution.errors));
  }
  return resolution;
};

const rejects = (patch: unknown): string => {
  const parsed = otelHookConfigPatchSchema.safeParse(patch);
  expect(parsed.success).toBe(false);
  return parsed.success ? "" : parsed.error.issues.map((issue) => issue.message).join("; ");
};

describe("exporter.destinations schema", () => {
  it("is absent by default, so an existing configuration is unchanged", () => {
    expect(DEFAULT_CONFIG.exporter.destinations).toBeUndefined();
    expect(DEFAULT_CONFIG.exporter.spool).toBeUndefined();
    expect(Object.keys(DEFAULT_EXPORTER_POLICY)).not.toContain("destinations");
  });

  it("accepts a full destination list", () => {
    const parsed = otelHookConfigPatchSchema.safeParse({
      exporter: {
        destinations: [
          LANGFUSE,
          { ...COLLECTOR, protocol: "http/protobuf", enabled: true, signals: ["traces", "logs"] },
          {
            name: "split",
            tracesEndpoint: "https://split.example/t",
            logsEndpoint: "https://split.example/l",
            headers: { "x-scope-orgid": "tenant-a" },
          },
        ],
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("reserves the name default for the single-endpoint settings", () => {
    expect(rejects({ exporter: { destinations: [{ ...COLLECTOR, name: "default" }] } })).toContain(
      "reserved",
    );
  });

  it("refuses duplicate names", () => {
    expect(rejects({ exporter: { destinations: [COLLECTOR, COLLECTOR] } })).toContain("duplicate");
  });

  it("refuses names that would not be a safe, recognizable directory", () => {
    for (const name of ["", "Langfuse", "../up", "a/b", "-leading", "x".repeat(64)]) {
      rejects({ exporter: { destinations: [{ ...COLLECTOR, name }] } });
    }
  });

  it("requires some endpoint", () => {
    expect(rejects({ exporter: { destinations: [{ name: "nowhere" }] } })).toContain("endpoint");
  });

  it("refuses unknown fields, unknown signals, and non-URL endpoints", () => {
    rejects({ exporter: { destinations: [{ ...COLLECTOR, url: "http://x" }] } });
    rejects({ exporter: { destinations: [{ ...COLLECTOR, signals: ["profiles"] }] } });
    rejects({ exporter: { destinations: [{ ...COLLECTOR, signals: [] }] } });
    rejects({ exporter: { destinations: [{ name: "bad", endpoint: "not a url" }] } });
  });

  it("refuses malformed env: references and header values that span lines", () => {
    expect(
      rejects({ exporter: { destinations: [{ ...COLLECTOR, headers: { authorization: "env:" } }] } }),
    ).toContain("env:");
    rejects({ exporter: { destinations: [{ ...COLLECTOR, headers: { authorization: "env:1BAD" } }] } });
    rejects({ exporter: { destinations: [{ ...COLLECTOR, headers: { "x-a": "one\r\nx-b: two" } }] } });
    rejects({ exporter: { destinations: [{ ...COLLECTOR, headers: { "bad name": "v" } }] } });
    // The same value rule the OTEL_EXPORTER_OTLP_*HEADERS variables are held to.
    rejects({ exporter: { destinations: [{ ...COLLECTOR, headers: { "x-a": "bell\u0007" } }] } });
    rejects({ exporter: { destinations: [{ ...COLLECTOR, headers: { "x-a": "snow\u2603" } }] } });
  });

  it("bounds the list and each destination's headers", () => {
    const many = Array.from({ length: 17 }, (_, index) => ({ ...COLLECTOR, name: `d${String(index)}` }));
    rejects({ exporter: { destinations: many } });
    const headers = Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => [`x-h${String(index)}`, "v"]),
    );
    rejects({ exporter: { destinations: [{ ...COLLECTOR, headers }] } });
  });

  it("validates spool bounds and merges them per leaf", () => {
    rejects({ exporter: { spool: { maxBytes: 10 } } });
    rejects({ exporter: { spool: { maxAgeMillis: 0 } } });
    const resolution = resolveOk([
      { source: "file", patch: { exporter: { spool: { maxBytes: 4096 } } } },
      { source: "environment", patch: { exporter: { spool: { maxAgeMillis: 60_000 } } } },
    ]);
    expect(effectiveSpoolPolicy(resolution.config.exporter)).toEqual({
      maxBytes: 4096,
      maxAgeMillis: 60_000,
      maxBatches: DEFAULT_SPOOL_POLICY.maxBatches,
    });
    expect(resolution.provenance["exporter.spool.maxBytes"]).toBe("file");
    expect(resolution.provenance["exporter.spool.maxAgeMillis"]).toBe("environment");
  });
});

describe("exporter.destinations across merge layers", () => {
  const patch = (destinations: readonly unknown[]): OtelHookConfigPatch =>
    ({ exporter: { destinations } }) as OtelHookConfigPatch;

  it("defaults: no list, and no provenance entry for one", () => {
    const resolution = resolveOk([]);
    expect(resolution.config.exporter.destinations).toBeUndefined();
    expect(resolution.provenance["exporter.destinations"]).toBeUndefined();
  });

  it("file: the list a configuration file sets", () => {
    const resolution = resolveOk([{ source: "file", patch: patch([LANGFUSE, COLLECTOR]) }]);
    expect(resolution.config.exporter.destinations?.map((entry) => entry.name)).toEqual([
      "langfuse",
      "team-collector",
    ]);
    expect(resolution.provenance["exporter.destinations"]).toBe("file");
  });

  it("environment: a programmatic environment layer replaces the file's list whole", () => {
    const resolution = resolveOk([
      { source: "file", patch: patch([LANGFUSE, COLLECTOR]) },
      { source: "environment", patch: patch([COLLECTOR]) },
    ]);
    expect(resolution.config.exporter.destinations?.map((entry) => entry.name)).toEqual([
      "team-collector",
    ]);
    expect(resolution.provenance["exporter.destinations"]).toBe("environment");
  });

  it("inline-override: the highest layer wins the list", () => {
    const resolution = resolveOk([
      { source: "file", patch: patch([LANGFUSE]) },
      { source: "environment", patch: patch([COLLECTOR]) },
      { source: "inline-override", patch: patch([{ ...COLLECTOR, name: "flag-dest" }]) },
    ]);
    expect(resolution.config.exporter.destinations?.map((entry) => entry.name)).toEqual([
      "flag-dest",
    ]);
    expect(resolution.provenance["exporter.destinations"]).toBe("inline-override");
  });

  it("rejects an invalid list in any layer rather than applying part of it", () => {
    const resolution = resolveConfig([
      { source: "file", patch: patch([LANGFUSE]) },
      { source: "environment", patch: patch([{ name: "default", endpoint: COLLECTOR.endpoint }]) },
    ]);
    expect(resolution.status).toBe("invalid");
  });

  it("keeps the single-endpoint leaves independent of the list", () => {
    const resolution = resolveOk([
      { source: "file", patch: patch([LANGFUSE]) },
      { source: "environment", patch: { exporter: { endpoint: "http://127.0.0.1:9/v1/traces" } } },
    ]);
    expect(resolution.provenance["exporter.endpoint"]).toBe("environment");
    expect(resolution.provenance["exporter.destinations"]).toBe("file");
    expect(resolveExportDestinations(resolution.config.exporter).map((entry) => entry.name)).toEqual([
      "default",
      "langfuse",
    ]);
  });
});

describe("resolveExportDestinations", () => {
  const exporter = (overrides: Partial<ExporterPolicy>): ExporterPolicy => ({
    ...DEFAULT_EXPORTER_POLICY,
    ...overrides,
  });

  it("without a list: exactly one default destination, even with no endpoint", () => {
    expect(resolveExportDestinations(exporter({}))).toEqual([
      {
        name: "default",
        source: "exporter",
        protocol: "http/protobuf",
        signals: { traces: true, logs: false, metrics: false },
        headers: {},
      },
    ]);
  });

  it("maps the standard OTEL_EXPORTER_OTLP_* variables onto the default destination", () => {
    const { patch } = parseEnvironmentConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318/v1/traces",
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:4318/v1/logs",
      OTEL_HOOK_LOGS_ENABLED: "1",
    });
    const resolution = resolveOk([
      { source: "file", patch: { exporter: { destinations: [LANGFUSE] } } },
      { source: "environment", patch },
    ]);
    const [first, second] = resolveExportDestinations(resolution.config.exporter);
    expect(first).toMatchObject({
      name: "default",
      endpoint: "http://127.0.0.1:4318/v1/traces",
      logsEndpoint: "http://127.0.0.1:4318/v1/logs",
      signals: { traces: true, logs: true },
    });
    // The list entry opted out of logs, so it gets traces only.
    expect(second).toMatchObject({ name: "langfuse", signals: { traces: true, logs: false } });
  });

  it("with a list and no single endpoint: only the list, disabled entries left out", () => {
    const resolved = resolveExportDestinations(
      exporter({ destinations: [LANGFUSE, { ...COLLECTOR, enabled: false }] }),
    );
    expect(resolved.map((entry) => entry.name)).toEqual(["langfuse"]);
  });

  it("keeps the logs signal behind exporter.logs.enabled", () => {
    const off = resolveExportDestinations(exporter({ destinations: [COLLECTOR] }));
    expect(off[0]?.signals).toEqual({ traces: true, logs: false, metrics: false });
    const on = resolveExportDestinations(
      exporter({ destinations: [COLLECTOR], logs: { ...DEFAULT_EXPORTER_POLICY.logs, enabled: true } }),
    );
    expect(on[0]?.signals).toEqual({ traces: true, logs: true, metrics: false });
  });

  it("inherits the exporter protocol unless a destination sets its own", () => {
    const resolved = resolveExportDestinations(
      exporter({
        protocol: "http/json",
        destinations: [COLLECTOR, { ...LANGFUSE, protocol: "http/protobuf" }],
      }),
    );
    expect(resolved.map((entry) => entry.protocol)).toEqual(["http/json", "http/protobuf"]);
  });
});

describe("env: header references", () => {
  it("resolves against the supplied environment only", () => {
    const resolved = resolveDestinationHeaders(
      { authorization: "env:DEST_TOKEN", "x-tenant": "acme" },
      { DEST_TOKEN: "Bearer synthetic-token" },
    );
    expect(resolved).toEqual({
      values: { authorization: "Bearer synthetic-token", "x-tenant": "acme" },
      missingVariables: [],
    });
  });

  it("reports unset and empty variables by name, and leaves their header out", () => {
    const resolved = resolveDestinationHeaders(
      { authorization: "env:DEST_TOKEN", "x-key": "env:DEST_KEY", "x-again": "env:DEST_TOKEN" },
      { DEST_KEY: "" },
    );
    expect(resolved).toEqual({ values: {}, missingVariables: ["DEST_KEY", "DEST_TOKEN"] });
  });

  it("never reads the process environment implicitly", () => {
    const resolved = resolveDestinationHeaders({ path: "env:PATH" }, undefined);
    expect(resolved.missingVariables).toEqual(["PATH"]);
  });
});

describe("destinations in the resolved-config snapshot", () => {
  it("adds nothing when the list is absent", () => {
    const snapshot = describeResolvedConfig(DEFAULT_CONFIG);
    expect(Object.keys(snapshot).filter((key) => key.includes("destination"))).toEqual([]);
    expect(Object.keys(snapshot).filter((key) => key.includes("spool"))).toEqual([]);
  });

  it("reports names, origins, and variable names, never a header value", () => {
    const config = {
      ...DEFAULT_CONFIG,
      exporter: {
        ...DEFAULT_CONFIG.exporter,
        destinations: [
          LANGFUSE,
          { ...COLLECTOR, headers: { "x-tenant": "literal-tenant-value-must-not-appear" } },
          { ...COLLECTOR, name: "parked", enabled: false },
        ],
      },
    };
    const snapshot = describeResolvedConfig(config);
    expect(snapshot["exporter.destination_names"]).toEqual(["langfuse", "team-collector", "parked"]);
    expect(snapshot["exporter.destination.langfuse.traces_endpoint_origin"]).toBe(
      "https://langfuse.example",
    );
    expect(snapshot["exporter.destination.langfuse.header_names"]).toEqual(["authorization"]);
    expect(snapshot["exporter.destination.langfuse.header_variables"]).toEqual(["LANGFUSE_AUTH"]);
    expect(snapshot["exporter.destination.parked.enabled"]).toBe(false);
    expect(snapshot["exporter.spool_max_bytes"]).toBe(DEFAULT_SPOOL_POLICY.maxBytes);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("literal-tenant-value-must-not-appear");
    expect(serialized).not.toContain("/api/public/otel");
    expect(describeExportDestinations(config.exporter).map((entry) => entry.name)).toEqual([
      "langfuse",
      "team-collector",
      "parked",
    ]);
  });

  it("does not note a missing endpoint when destinations provide one", () => {
    const withList = resolveOk([
      { source: "file", patch: { exporter: { destinations: [COLLECTOR] } } },
    ]);
    expect(withList.notes).not.toContain("exporter.enabled is true but no endpoint is configured");
    const without = resolveOk([]);
    expect(without.notes).toContain("exporter.enabled is true but no endpoint is configured");
  });

  it("notes a destination that lists logs while the logs signal is off", () => {
    const resolution = resolveOk([
      {
        source: "file",
        patch: {
          exporter: { destinations: [{ ...COLLECTOR, signals: ["logs"] }] },
        },
      },
    ]);
    expect(resolution.notes.some((note) => note.includes("team-collector"))).toBe(true);
  });
});
