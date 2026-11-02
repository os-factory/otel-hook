import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONFIG,
  describeResolvedConfig,
  otelHookConfigPatchSchema,
  otelHookConfigSchema,
  parseEnvironmentConfig,
  resolveConfig,
} from "../../src/index.js";

describe("local-export policy defaults", () => {
  it("ships JSONL and console off, so an upgrade writes no files", () => {
    expect(DEFAULT_CONFIG.localExport.jsonl.enabled).toBe(false);
    expect(DEFAULT_CONFIG.localExport.jsonl.path).toBeUndefined();
    expect(DEFAULT_CONFIG.localExport.jsonl.maxBytes).toBe(10 * 1024 * 1024);
    expect(DEFAULT_CONFIG.localExport.jsonl.maxFiles).toBe(3);
    expect(DEFAULT_CONFIG.localExport.console.enabled).toBe(false);
    expect(otelHookConfigSchema.safeParse(DEFAULT_CONFIG).success).toBe(true);
  });

  it("rejects a JSONL file bound below 1 KiB", () => {
    expect(
      otelHookConfigPatchSchema.safeParse({ localExport: { jsonl: { maxBytes: 512 } } }).success,
    ).toBe(false);
  });
});

describe("local-export policy layering", () => {
  it("merges each jsonl field as its own leaf, independently of OTLP", () => {
    const resolution = resolveConfig([
      { source: "file", patch: { localExport: { jsonl: { enabled: true } } } },
      { source: "environment", patch: { localExport: { jsonl: { path: "events.jsonl" } } } },
      { source: "inline-override", patch: { exporter: { enabled: false } } },
    ]);

    expect(resolution.status).toBe("ok");
    if (resolution.status !== "ok") {
      return;
    }
    expect(resolution.config.localExport.jsonl.enabled).toBe(true);
    expect(resolution.config.localExport.jsonl.path).toBe("events.jsonl");
    expect(resolution.config.localExport.jsonl.maxBytes).toBe(DEFAULT_CONFIG.localExport.jsonl.maxBytes);
    expect(resolution.config.exporter.enabled).toBe(false);
    expect(resolution.provenance["localExport.jsonl.enabled"]).toBe("file");
    expect(resolution.provenance["localExport.jsonl.path"]).toBe("environment");
    expect(resolution.provenance["localExport.jsonl.maxBytes"]).toBe("defaults");
    expect(resolution.provenance["exporter.enabled"]).toBe("inline-override");
  });

  it("notes an enabled JSONL pipeline with no path", () => {
    const resolution = resolveConfig([
      { source: "file", patch: { localExport: { jsonl: { enabled: true } } } },
    ]);
    expect(resolution.status).toBe("ok");
    if (resolution.status !== "ok") {
      return;
    }
    expect(resolution.notes.some((note) => note.includes("no path is configured"))).toBe(true);
  });

  it("notes a JSONL path that would write onto a process stream", () => {
    const resolution = resolveConfig([
      {
        source: "file",
        patch: { localExport: { jsonl: { enabled: true, path: "/dev/stdout" } } },
      },
    ]);
    expect(resolution.status).toBe("ok");
    if (resolution.status !== "ok") {
      return;
    }
    expect(resolution.notes.some((note) => note.includes("process stream"))).toBe(true);
  });
});

describe("local-export policy from the environment", () => {
  it("treats a JSONL path as an enable, without touching the OTLP exporter", () => {
    const { patch, warnings } = parseEnvironmentConfig({
      OTEL_HOOK_JSONL_PATH: "events.jsonl",
      OTEL_HOOK_CONSOLE: "true",
    });
    expect(warnings).toEqual([]);
    expect(patch.localExport).toEqual({
      jsonl: { enabled: true, path: "events.jsonl" },
      console: { enabled: true },
    });
    expect(patch.exporter).toBeUndefined();
  });

  it("warns and skips an unusable console boolean rather than enabling it", () => {
    const { patch, warnings } = parseEnvironmentConfig({ OTEL_HOOK_CONSOLE: "perhaps" });
    expect(patch).toEqual({});
    expect(warnings).toHaveLength(1);
    const resolution = resolveConfig([{ source: "environment", patch }]);
    expect(resolution.status === "ok" && resolution.config.localExport.console.enabled).toBe(false);
  });
});

describe("local-export policy in a resolved-config snapshot", () => {
  it("reports booleans and never the file path", () => {
    const snapshot = describeResolvedConfig({
      ...DEFAULT_CONFIG,
      localExport: {
        ...DEFAULT_CONFIG.localExport,
        jsonl: {
          ...DEFAULT_CONFIG.localExport.jsonl,
          enabled: true,
          path: "/home/operator/.local/state/otel-hook/events.jsonl",
        },
        console: { enabled: true },
      },
    });

    expect(snapshot["local_export.jsonl_enabled"]).toBe(true);
    expect(snapshot["local_export.console_enabled"]).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("/home/operator");
    expect(JSON.stringify(snapshot)).not.toContain("events.jsonl");
  });

  it("reports both exporters off on the default configuration", () => {
    const snapshot = describeResolvedConfig(DEFAULT_CONFIG);
    expect(snapshot["local_export.jsonl_enabled"]).toBe(false);
    expect(snapshot["local_export.console_enabled"]).toBe(false);
  });
});
