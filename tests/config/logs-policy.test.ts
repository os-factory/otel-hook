import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONFIG,
  describeResolvedConfig,
  otelHookConfigPatchSchema,
  otelHookConfigSchema,
  parseEnvironmentConfig,
  resolveConfig,
} from "../../src/index.js";

describe("logs policy defaults", () => {
  it("ships the logs signal off, with content off", () => {
    // Two separate defaults, both off. Adding a signal must not change what an
    // existing installation sends, and enabling the signal must not change what it
    // discloses.
    expect(DEFAULT_CONFIG.exporter.logs.enabled).toBe(false);
    expect(DEFAULT_CONFIG.exporter.logs.includeContent).toBe(false);
    expect(DEFAULT_CONFIG.exporter.logs.endpoint).toBeUndefined();
    expect(otelHookConfigSchema.safeParse(DEFAULT_CONFIG).success).toBe(true);
  });

  it("rejects a logs endpoint that is not a URL", () => {
    expect(
      otelHookConfigPatchSchema.safeParse({ exporter: { logs: { endpoint: "not-a-url" } } }).success,
    ).toBe(false);
  });
});

describe("logs policy layering", () => {
  it("merges each logs field as its own leaf", () => {
    // The property the patch schema's unwrap-and-repartial exists for: a file may
    // enable the signal while the environment sets only the endpoint, without either
    // layer having to restate the rest.
    const resolution = resolveConfig([
      { source: "file", patch: { exporter: { logs: { enabled: true } } } },
      {
        source: "environment",
        patch: { exporter: { logs: { endpoint: "https://collector.example/v1/logs" } } },
      },
      { source: "inline-override", patch: { exporter: { logs: { includeContent: true } } } },
    ]);

    expect(resolution.status).toBe("ok");
    if (resolution.status !== "ok") {
      return;
    }
    expect(resolution.config.exporter.logs).toEqual({
      enabled: true,
      endpoint: "https://collector.example/v1/logs",
      includeContent: true,
      maxBatchSize: DEFAULT_CONFIG.exporter.logs.maxBatchSize,
    });
    expect(resolution.provenance["exporter.logs.enabled"]).toBe("file");
    expect(resolution.provenance["exporter.logs.endpoint"]).toBe("environment");
    expect(resolution.provenance["exporter.logs.includeContent"]).toBe("inline-override");
    // Untouched leaves keep their default provenance.
    expect(resolution.provenance["exporter.logs.maxBatchSize"]).toBe("defaults");
  });

  it("notes an enabled pipeline with nowhere to send to", () => {
    const resolution = resolveConfig([
      { source: "file", patch: { exporter: { logs: { enabled: true } } } },
    ]);
    expect(resolution.status).toBe("ok");
    if (resolution.status !== "ok") {
      return;
    }
    expect(resolution.notes.some((note) => note.includes("neither a logs endpoint"))).toBe(true);
  });

  it("notes content permitted on a pipeline with nothing disclosed to carry", () => {
    // The combination somebody lands on by enabling one gate and forgetting the
    // other. The symptom — every body withheld — otherwise looks like a bug.
    const resolution = resolveConfig([
      {
        source: "file",
        patch: {
          exporter: { endpoint: "https://collector.example/v1/traces", logs: { enabled: true, includeContent: true } },
        },
      },
    ]);
    expect(resolution.status).toBe("ok");
    if (resolution.status !== "ok") {
      return;
    }
    expect(resolution.notes.some((note) => note.includes("privacy.contentMode is omit"))).toBe(true);
  });

  it("does not note the pair when both gates agree", () => {
    const resolution = resolveConfig([
      {
        source: "file",
        patch: {
          exporter: { endpoint: "https://collector.example/v1/traces", logs: { enabled: true, includeContent: true } },
          privacy: { contentMode: "redact" },
        },
      },
    ]);
    expect(resolution.status).toBe("ok");
    if (resolution.status !== "ok") {
      return;
    }
    expect(resolution.notes.some((note) => note.includes("privacy.contentMode is omit"))).toBe(false);
  });
});

describe("logs policy from the environment", () => {
  it("reads the enable, endpoint, and content variables", () => {
    const { patch, warnings } = parseEnvironmentConfig({
      OTEL_HOOK_LOGS_ENABLED: "true",
      OTEL_HOOK_LOGS_ENDPOINT: "https://collector.example/v1/logs",
      OTEL_HOOK_LOGS_INCLUDE_CONTENT: "yes",
    });
    expect(warnings).toEqual([]);
    expect(patch.exporter?.logs).toEqual({
      enabled: true,
      endpoint: "https://collector.example/v1/logs",
      includeContent: true,
    });
  });

  it("prefers the library-specific logs endpoint over the standard per-signal one", () => {
    const { patch } = parseEnvironmentConfig({
      OTEL_HOOK_LOGS_ENDPOINT: "https://specific.example/v1/logs",
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://generic.example/v1/logs",
    });
    expect(patch.exporter?.logs?.endpoint).toBe("https://specific.example/v1/logs");
  });

  it("falls back to the standard per-signal variable", () => {
    const { patch } = parseEnvironmentConfig({
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://generic.example/v1/logs",
    });
    expect(patch.exporter?.logs?.endpoint).toBe("https://generic.example/v1/logs");
  });

  it("warns and skips an unusable boolean rather than enabling the signal", () => {
    const { patch, warnings } = parseEnvironmentConfig({ OTEL_HOOK_LOGS_ENABLED: "perhaps" });
    expect(patch).toEqual({});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe("configuration-invalid");
    // Fail-safe direction: an unreadable value leaves the signal off.
    const resolution = resolveConfig([{ source: "environment", patch }]);
    expect(resolution.status === "ok" && resolution.config.exporter.logs.enabled).toBe(false);
  });

  it("leaves the trace endpoint untouched, so the two signals stay separable", () => {
    const { patch } = parseEnvironmentConfig({
      OTEL_HOOK_LOGS_ENDPOINT: "https://logs.example/v1/logs",
    });
    expect(patch.exporter?.endpoint).toBeUndefined();
  });
});

describe("logs policy in a resolved-config snapshot", () => {
  it("reports the logs endpoint as an origin and never its query", () => {
    const snapshot = describeResolvedConfig({
      ...DEFAULT_CONFIG,
      exporter: {
        ...DEFAULT_CONFIG.exporter,
        logs: {
          ...DEFAULT_CONFIG.exporter.logs,
          enabled: true,
          includeContent: true,
          endpoint: "https://collector.example:4318/v1/logs?token=abc",
        },
      },
    });

    expect(snapshot["exporter.logs_enabled"]).toBe(true);
    expect(snapshot["exporter.logs_include_content"]).toBe(true);
    expect(snapshot["exporter.logs_endpoint_origin"]).toBe("https://collector.example:4318");
    expect(JSON.stringify(snapshot)).not.toContain("token=abc");
  });

  it("omits the logs endpoint origin when none is configured", () => {
    const snapshot = describeResolvedConfig(DEFAULT_CONFIG);
    expect(snapshot["exporter.logs_endpoint_origin"]).toBeUndefined();
    expect(snapshot["exporter.logs_enabled"]).toBe(false);
  });
});
