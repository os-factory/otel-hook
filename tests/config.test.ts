import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONFIG,
  describeResolvedConfig,
  ENVIRONMENT_VARIABLES,
  invocationIdentitySchema,
  otelHookConfigPatchSchema,
  otelHookConfigSchema,
  parseEnvironmentConfig,
  resolveConfig,
  type ConfigLayer,
} from "../src/index.js";

describe("configuration defaults", () => {
  it("is valid and privacy-safe out of the box", () => {
    expect(otelHookConfigSchema.safeParse(DEFAULT_CONFIG).success).toBe(true);
    expect(DEFAULT_CONFIG.privacy.contentMode).toBe("omit");
    expect(DEFAULT_CONFIG.privacy.allowRawContent).toBe(false);
    expect(DEFAULT_CONFIG.detection.minimumConfidence).toBe("strong");
  });

  it("resolves to the defaults when no layer is supplied", () => {
    const resolution = resolveConfig();
    expect(resolution.status).toBe("ok");
    if (resolution.status === "ok") {
      expect(resolution.config).toEqual(DEFAULT_CONFIG);
      expect(resolution.provenance["privacy.contentMode"]).toBe("defaults");
    }
  });
});

describe("configuration precedence", () => {
  const layers: readonly ConfigLayer[] = [
    {
      source: "file",
      origin: "otel-hook.json",
      patch: {
        exporter: { endpoint: "https://collector.example/v1/traces", serviceName: "from-file" },
        privacy: { contentMode: "mask" },
      },
    },
    {
      source: "environment",
      patch: { exporter: { serviceName: "from-env" }, diagnostics: { logLevel: "debug" } },
    },
    { source: "inline-override", patch: { exporter: { serviceName: "from-inline" } } },
  ];

  it("applies inline over environment over file over defaults", () => {
    const resolution = resolveConfig(layers);
    expect(resolution.status).toBe("ok");
    if (resolution.status !== "ok") {
      return;
    }
    expect(resolution.config.exporter.serviceName).toBe("from-inline");
    expect(resolution.config.exporter.endpoint).toBe("https://collector.example/v1/traces");
    expect(resolution.config.privacy.contentMode).toBe("mask");
    expect(resolution.config.diagnostics.logLevel).toBe("debug");
    expect(resolution.config.exporter.timeoutMillis).toBe(DEFAULT_CONFIG.exporter.timeoutMillis);
  });

  it("records which layer supplied each leaf", () => {
    const resolution = resolveConfig(layers);
    if (resolution.status !== "ok") {
      throw new Error("expected ok");
    }
    expect(resolution.provenance["exporter.serviceName"]).toBe("inline-override");
    expect(resolution.provenance["exporter.endpoint"]).toBe("file");
    expect(resolution.provenance["diagnostics.logLevel"]).toBe("environment");
    expect(resolution.provenance["exporter.timeoutMillis"]).toBe("defaults");
  });

  it("is order-independent: layer order in the array does not change the result", () => {
    const forward = resolveConfig(layers);
    const reversed = resolveConfig([...layers].reverse());
    expect(forward).toEqual(reversed);
  });

  it("merges nested privacy limits per leaf", () => {
    const resolution = resolveConfig([
      { source: "file", patch: { privacy: { limits: { maxDepth: 2 } } } },
    ]);
    if (resolution.status !== "ok") {
      throw new Error("expected ok");
    }
    expect(resolution.config.privacy.limits.maxDepth).toBe(2);
    expect(resolution.config.privacy.limits.maxStringLength).toBe(
      DEFAULT_CONFIG.privacy.limits.maxStringLength,
    );
    expect(resolution.provenance["privacy.limits.maxDepth"]).toBe("file");
    expect(resolution.provenance["privacy.limits.maxStringLength"]).toBe("defaults");
  });

  it("rejects an invalid layer instead of applying it partially", () => {
    const resolution = resolveConfig([
      { source: "file", patch: { exporter: { timeoutMillis: -5 } } },
    ]);
    expect(resolution.status).toBe("invalid");
    if (resolution.status === "invalid") {
      expect(resolution.errors[0]?.code).toBe("configuration-invalid");
    }
  });

  it("notes a raw content mode that will be downgraded", () => {
    const resolution = resolveConfig([
      { source: "inline-override", patch: { privacy: { contentMode: "raw" } } },
    ]);
    if (resolution.status !== "ok") {
      throw new Error("expected ok");
    }
    expect(resolution.notes.join(" ")).toContain("downgraded");
  });
});

describe("identity is not configuration", () => {
  it("rejects identity fields in a configuration patch", () => {
    for (const patch of [
      { sessionId: "ses_1" },
      { invocationId: "inv_1" },
      { workspace: { workspaceId: "sha256:abc" } },
      { identity: { sessionId: "ses_1" } },
      { exporter: { sessionId: "ses_1" } },
    ]) {
      expect(otelHookConfigPatchSchema.safeParse(patch).success, JSON.stringify(patch)).toBe(false);
    }
  });

  it("shares no field names between configuration and invocation identity", () => {
    const configKeys = new Set(Object.keys(otelHookConfigSchema.shape));
    const identityKeys = Object.keys(invocationIdentitySchema.unwrap().shape);
    expect(identityKeys.filter((key) => configKeys.has(key))).toEqual([]);
  });

  it("exposes no environment variable that sets identity", () => {
    const identityish = /(_ID$|SESSION|WORKSPACE|TRACE|_USER)/i;
    const offenders = Object.values(ENVIRONMENT_VARIABLES).filter((name) =>
      identityish.test(name),
    );
    expect(offenders).toEqual([]);
  });
});

describe("environment configuration", () => {
  it("reads the documented variables", () => {
    const { patch, warnings } = parseEnvironmentConfig({
      OTEL_HOOK_ENABLED: "true",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example",
      OTEL_HOOK_CONTENT_MODE: "redact",
      OTEL_HOOK_MAX_DEPTH: "3",
      OTEL_HOOK_MIN_DETECTION_CONFIDENCE: "exact",
      OTEL_HOOK_LOG_LEVEL: "debug",
    });

    expect(warnings).toEqual([]);
    expect(patch).toEqual({
      exporter: { enabled: true, endpoint: "https://collector.example" },
      privacy: { contentMode: "redact", limits: { maxDepth: 3 } },
      detection: { minimumConfidence: "exact" },
      diagnostics: { logLevel: "debug" },
    });
  });

  it("prefers the library-specific endpoint over the generic one", () => {
    const { patch } = parseEnvironmentConfig({
      OTEL_HOOK_EXPORTER_ENDPOINT: "https://specific.example",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://generic.example",
    });
    expect(patch.exporter?.endpoint).toBe("https://specific.example");
  });

  it("warns and skips unusable values rather than failing resolution", () => {
    const { patch, warnings } = parseEnvironmentConfig({
      OTEL_HOOK_ENABLED: "perhaps",
      OTEL_HOOK_MAX_DEPTH: "deep",
      OTEL_HOOK_CONTENT_MODE: "everything",
      OTEL_HOOK_EXPORTER_PROTOCOL: "carrier-pigeon",
    });

    expect(patch).toEqual({});
    expect(warnings).toHaveLength(4);
    expect(warnings.every((warning) => warning.code === "configuration-invalid")).toBe(true);
    expect(resolveConfig([{ source: "environment", patch }]).status).toBe("ok");
  });

  it("ignores empty variables", () => {
    const { patch, warnings } = parseEnvironmentConfig({
      OTEL_HOOK_SERVICE_NAME: "",
      OTEL_HOOK_HASH_SALT: undefined,
    });
    expect(patch).toEqual({});
    expect(warnings).toEqual([]);
  });
});

describe("resolved configuration snapshots", () => {
  it("reduces the endpoint to an origin and never includes header values", () => {
    const snapshot = describeResolvedConfig({
      ...DEFAULT_CONFIG,
      exporter: {
        ...DEFAULT_CONFIG.exporter,
        endpoint: "https://collector.example:4318/v1/traces?token=abc",
        headerNames: ["authorization"],
      },
    });

    expect(snapshot["exporter.endpoint_origin"]).toBe("https://collector.example:4318");
    expect(JSON.stringify(snapshot)).not.toContain("token=abc");
    expect(snapshot["exporter.header_names"]).toEqual(["authorization"]);
  });

  it("reports whether hashing is salted without revealing the salt", () => {
    const snapshot = describeResolvedConfig({
      ...DEFAULT_CONFIG,
      privacy: { ...DEFAULT_CONFIG.privacy, hashSalt: "tenant-secret" },
    });
    expect(snapshot["privacy.hash_salted"]).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("tenant-secret");
  });
});
