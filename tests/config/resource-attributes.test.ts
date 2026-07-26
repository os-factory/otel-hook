import { readFileSync } from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { CLI_USAGE, parseCliArgs } from "../../src/cli/args.js";
import { policyFlagsToPatch } from "../../src/cli/context.js";
import {
  checkResourceAttributeKey,
  DEFAULT_CONFIG,
  describeResolvedConfig,
  ENVIRONMENT_VARIABLES,
  MAX_RESOURCE_ATTRIBUTES,
  MAX_RESOURCE_ATTRIBUTE_VALUE_LENGTH,
  otelHookConfigPatchSchema,
  parseEnvironmentConfig,
  parseResourceAttributesValue,
  RESERVED_RESOURCE_ATTRIBUTE_KEYS,
  resolveConfig,
  resourceAttributesSchema,
  sanitizeResourceAttributes,
  type ConfigLayer,
  type OtelHookConfig,
} from "../../src/index.js";

const okConfig = (layers: readonly ConfigLayer[]): OtelHookConfig => {
  const resolution = resolveConfig(layers);
  if (resolution.status !== "ok") {
    throw new Error(`expected ok, got ${JSON.stringify(resolution.errors)}`);
  }
  return resolution.config;
};

const runPolicy = (argv: readonly string[]) => {
  const parsed = parseCliArgs(argv);
  if (parsed.status !== "command" || parsed.command.name !== "run") {
    throw new Error(`expected a run command, got ${JSON.stringify(parsed)}`);
  }
  return parsed.command;
};

const cliErrors = (argv: readonly string[]): readonly string[] => {
  const parsed = parseCliArgs(argv);
  if (parsed.status !== "error") {
    throw new Error(`expected errors, got ${JSON.stringify(parsed)}`);
  }
  return parsed.errors;
};

describe("resource attribute validation", () => {
  it("defaults to none, which keeps the exported resource unchanged", () => {
    expect(DEFAULT_CONFIG.exporter.resourceAttributes).toEqual({});
    expect(Object.isFrozen(DEFAULT_CONFIG.exporter.resourceAttributes)).toBe(true);
  });

  it("accepts string, number, and boolean values", () => {
    const parsed = resourceAttributesSchema.safeParse({
      "deployment.environment": "staging",
      "deployment.replica": 3,
      "deployment.canary": true,
    });
    expect(parsed.success).toBe(true);
  });

  it("refuses an array value, which no configuration layer can express uniformly", () => {
    expect(resourceAttributesSchema.safeParse({ "deployment.zones": ["a", "b"] }).success).toBe(
      false,
    );
  });

  it("names why each unusable key is unusable", () => {
    expect(checkResourceAttributeKey("deployment.environment")).toBeUndefined();
    expect(checkResourceAttributeKey("service.instance.id")).toBeUndefined();
    expect(checkResourceAttributeKey("k8s.pod/name")).toBeUndefined();
    expect(checkResourceAttributeKey("")).toBe("empty");
    expect(checkResourceAttributeKey("x".repeat(256))).toBe("too-long");
    expect(checkResourceAttributeKey("9lives")).toBe("malformed");
    expect(checkResourceAttributeKey("has space")).toBe("malformed");
    expect(checkResourceAttributeKey("newline\nkey")).toBe("malformed");
    expect(checkResourceAttributeKey("service.name")).toBe("reserved");
    expect(checkResourceAttributeKey("Service.Name")).toBe("reserved");
    expect(checkResourceAttributeKey("service.namespace")).toBe("reserved");
    expect(checkResourceAttributeKey("api_key")).toBe("secret-like");
    expect(checkResourceAttributeKey("tenant.auth_header")).toBe("secret-like");
  });

  it("bounds the number of attributes and the length of a value", () => {
    const tooMany = Object.fromEntries(
      Array.from({ length: MAX_RESOURCE_ATTRIBUTES + 1 }, (_unused, index) => [
        `attr.n${String(index)}`,
        "v",
      ]),
    );
    expect(resourceAttributesSchema.safeParse(tooMany).success).toBe(false);
    expect(
      resourceAttributesSchema.safeParse({
        "deployment.note": "x".repeat(MAX_RESOURCE_ATTRIBUTE_VALUE_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it("refuses a configuration layer that sets service identity as a resource attribute", () => {
    for (const key of RESERVED_RESOURCE_ATTRIBUTE_KEYS) {
      const patch = { exporter: { resourceAttributes: { [key]: "sneaky" } } };
      expect(otelHookConfigPatchSchema.safeParse(patch).success, key).toBe(false);
    }
    const resolution = resolveConfig([
      { source: "file", origin: "otel-hook.json", patch: { exporter: { resourceAttributes: { "service.name": "sneaky" } } } },
    ]);
    expect(resolution.status).toBe("invalid");
    if (resolution.status === "invalid") {
      // Loud, not silent: the operator is told which knob actually sets it.
      expect(resolution.errors[0]?.message).toContain("--service-name");
    }
  });

  it("filters anything unusable at the last gate before the exporter", () => {
    // Reached only by a caller who hand-built an ExporterPolicy without the schema.
    const unchecked = {
      "deployment.environment": "prod",
      "service.name": "hijacked",
      api_key: "sk-should-never-be-exported",
      "9bad": "x",
    };
    expect(sanitizeResourceAttributes(unchecked)).toEqual({ "deployment.environment": "prod" });
  });
});

describe("OTEL_RESOURCE_ATTRIBUTES parsing", () => {
  it("reads comma-separated key=value pairs, trimming optional whitespace", () => {
    const parsed = parseResourceAttributesValue(
      "  deployment.environment = staging , service.instance.id=abc-123 ",
    );
    expect(parsed.warnings).toEqual([]);
    expect(parsed.attributes).toEqual({
      "deployment.environment": "staging",
      "service.instance.id": "abc-123",
    });
  });

  it("percent-decodes values, so an encoded comma or equals survives the split", () => {
    const parsed = parseResourceAttributesValue("deployment.note=a%2Cb%3Dc,region=eu%20west");
    expect(parsed.warnings).toEqual([]);
    expect(parsed.attributes).toEqual({ "deployment.note": "a,b=c", region: "eu west" });
  });

  it("splits on the first equals only, so an unencoded one stays in the value", () => {
    expect(parseResourceAttributesValue("deployment.note=k=v").attributes).toEqual({
      "deployment.note": "k=v",
    });
  });

  it("ignores W3C Baggage metadata and strips surrounding quotes", () => {
    expect(
      parseResourceAttributesValue('deployment.environment=staging;metadata=1').attributes,
    ).toEqual({ "deployment.environment": "staging" });
    expect(parseResourceAttributesValue('deployment.environment="staging"').attributes).toEqual({
      "deployment.environment": "staging",
    });
  });

  it("tolerates empty entries and a trailing comma", () => {
    expect(parseResourceAttributesValue("a.one=1,,b.two=2,").attributes).toEqual({
      "a.one": "1",
      "b.two": "2",
    });
    expect(parseResourceAttributesValue("").attributes).toEqual({});
  });

  it("takes the last value when a key repeats", () => {
    expect(parseResourceAttributesValue("deployment.environment=a,deployment.environment=b")
      .attributes).toEqual({ "deployment.environment": "b" });
  });

  it("skips a malformed entry and keeps the well-formed ones", () => {
    const parsed = parseResourceAttributesValue("garbage,deployment.note=%zz,team.name=platform");
    expect(parsed.attributes).toEqual({ "team.name": "platform" });
    expect(parsed.warnings).toEqual([
      "entry 1 is not a key=value pair",
      "entry 2 has a malformed percent-encoded value",
    ]);
  });

  it("drops an over-long value rather than truncating it into a wrong fact", () => {
    const parsed = parseResourceAttributesValue(
      `deployment.note=${"x".repeat(MAX_RESOURCE_ATTRIBUTE_VALUE_LENGTH + 1)}`,
    );
    expect(parsed.attributes).toEqual({});
    expect(parsed.warnings[0]).toContain("longer than");
  });

  it("bounds the attribute count and says so", () => {
    const raw = Array.from(
      { length: MAX_RESOURCE_ATTRIBUTES + 5 },
      (_unused, index) => `attr.n${String(index)}=v`,
    ).join(",");
    const parsed = parseResourceAttributesValue(raw);
    expect(Object.keys(parsed.attributes)).toHaveLength(MAX_RESOURCE_ATTRIBUTES);
    expect(parsed.warnings.join(" ")).toContain("the excess was dropped");
  });

  it("routes service identity to exporter policy instead of into the attribute map", () => {
    const parsed = parseResourceAttributesValue(
      "service.name=migrated-agent,service.namespace=platform,team.name=core",
    );
    expect(parsed.serviceName).toBe("migrated-agent");
    expect(parsed.serviceNamespace).toBe("platform");
    expect(parsed.attributes).toEqual({ "team.name": "core" });
    expect(parsed.warnings).toEqual([]);
  });
});

describe("resource attribute precedence across layers", () => {
  const layers: readonly ConfigLayer[] = [
    {
      source: "file",
      origin: "otel-hook.json",
      patch: {
        exporter: {
          resourceAttributes: { "deployment.environment": "from-file", "team.name": "core" },
        },
      },
    },
    {
      source: "environment",
      patch: {
        exporter: {
          resourceAttributes: {
            "deployment.environment": "from-env",
            "service.instance.id": "i-1",
          },
        },
      },
    },
    {
      source: "inline-override",
      patch: { exporter: { resourceAttributes: { "deployment.environment": "from-cli" } } },
    },
  ];

  it("merges per attribute key, with the highest-precedence layer winning that key", () => {
    expect(okConfig(layers).exporter.resourceAttributes).toEqual({
      "deployment.environment": "from-cli",
      "team.name": "core",
      "service.instance.id": "i-1",
    });
  });

  it("records provenance per attribute key", () => {
    const resolution = resolveConfig(layers);
    if (resolution.status !== "ok") {
      throw new Error("expected ok");
    }
    expect(resolution.provenance["exporter.resourceAttributes.deployment.environment"]).toBe(
      "inline-override",
    );
    expect(resolution.provenance["exporter.resourceAttributes.team.name"]).toBe("file");
    expect(resolution.provenance["exporter.resourceAttributes.service.instance.id"]).toBe(
      "environment",
    );
  });

  it("does not depend on the order layers are supplied in", () => {
    expect(resolveConfig(layers)).toEqual(resolveConfig([...layers].reverse()));
  });

  it("keeps service.name from exporter policy no matter what the layers do", () => {
    const config = okConfig([
      ...layers,
      { source: "environment", patch: { exporter: { serviceName: "policy-name" } } },
    ]);
    expect(config.exporter.serviceName).toBe("policy-name");
    expect(config.exporter.resourceAttributes).not.toHaveProperty("service.name");
  });
});

describe("environment layer", () => {
  it("reads OTEL_RESOURCE_ATTRIBUTES into the exporter patch", () => {
    const { patch, warnings } = parseEnvironmentConfig({
      OTEL_RESOURCE_ATTRIBUTES: "deployment.environment=staging,team.name=core",
    });
    expect(warnings).toEqual([]);
    expect(patch).toEqual({
      exporter: {
        resourceAttributes: { "deployment.environment": "staging", "team.name": "core" },
      },
    });
  });

  it("honours service.name from the standard variable as the weakest source", () => {
    const { patch } = parseEnvironmentConfig({
      OTEL_RESOURCE_ATTRIBUTES: "service.name=from-resource-attributes,team.name=core",
    });
    expect(patch.exporter?.serviceName).toBe("from-resource-attributes");
    expect(patch.exporter?.resourceAttributes).toEqual({ "team.name": "core" });
  });

  it("prefers OTEL_SERVICE_NAME over service.name, and OTEL_HOOK_SERVICE_NAME over both", () => {
    expect(
      parseEnvironmentConfig({
        OTEL_SERVICE_NAME: "standard",
        OTEL_RESOURCE_ATTRIBUTES: "service.name=from-resource-attributes",
      }).patch.exporter?.serviceName,
    ).toBe("standard");

    expect(
      parseEnvironmentConfig({
        OTEL_HOOK_SERVICE_NAME: "library-specific",
        OTEL_SERVICE_NAME: "standard",
        OTEL_RESOURCE_ATTRIBUTES: "service.name=from-resource-attributes",
      }).patch.exporter?.serviceName,
    ).toBe("library-specific");
  });

  it("warns when service-name sources disagree, naming the variables and not the values", () => {
    const { warnings } = parseEnvironmentConfig({
      OTEL_HOOK_SERVICE_NAME: "library-specific",
      OTEL_RESOURCE_ATTRIBUTES: "service.name=from-resource-attributes",
    });
    expect(warnings).toHaveLength(1);
    const [warning] = warnings;
    expect(warning?.message).toContain("service.name in OTEL_RESOURCE_ATTRIBUTES");
    expect(warning?.message).toContain("overridden by OTEL_HOOK_SERVICE_NAME");
    expect(JSON.stringify(warning)).not.toContain("from-resource-attributes");
  });

  it("stays quiet when the sources agree", () => {
    expect(
      parseEnvironmentConfig({
        OTEL_HOOK_SERVICE_NAME: "same",
        OTEL_RESOURCE_ATTRIBUTES: "service.name=same",
      }).warnings,
    ).toEqual([]);
  });

  it("reports an unusable entry as a warning and still applies the rest", () => {
    const { patch, warnings } = parseEnvironmentConfig({
      OTEL_RESOURCE_ATTRIBUTES: "garbage,deployment.environment=staging",
    });
    expect(patch.exporter?.resourceAttributes).toEqual({ "deployment.environment": "staging" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe("configuration-invalid");
    // Reporting must never disable telemetry (ADR 0004).
    expect(resolveConfig([{ source: "environment", patch }]).status).toBe("ok");
  });

  it("adds no environment variable that could set identity", () => {
    const identityish = /(_ID$|SESSION|WORKSPACE|TRACE|_USER)/i;
    expect(Object.values(ENVIRONMENT_VARIABLES).filter((name) => identityish.test(name))).toEqual(
      [],
    );
  });
});

describe("--resource-attr", () => {
  it("collects repeatable pairs into exporter policy, not identity", () => {
    const command = runPolicy([
      "run",
      "--resource-attr",
      "deployment.environment=prod",
      "--resource-attr=team.name=core",
      "--attr",
      "tenant=acme",
    ]);
    expect(command.policy.resourceAttributes).toEqual({
      "deployment.environment": "prod",
      "team.name": "core",
    });
    // The two attribute channels stay entirely separate.
    expect(command.consumerAttributes).toEqual({ tenant: "acme" });
    expect(command.policy.resourceAttributes).not.toHaveProperty("tenant");
    expect(command.consumerAttributes).not.toHaveProperty("deployment.environment");
  });

  it("becomes an inline-override configuration patch", () => {
    const command = runPolicy(["run", "--resource-attr", "deployment.environment=prod"]);
    expect(policyFlagsToPatch(command.policy)).toEqual({
      exporter: { resourceAttributes: { "deployment.environment": "prod" } },
    });
    expect(policyFlagsToPatch(runPolicy(["run"]).policy)).toEqual({});
  });

  it("rejects a reserved key and points at the flag that does set it", () => {
    const [error] = cliErrors(["run", "--resource-attr", "service.name=hijacked"]);
    expect(error).toContain("--service-name");
    expect(error).not.toContain("hijacked");
  });

  it("rejects a malformed pair, a malformed key, and a secret-looking key", () => {
    expect(cliErrors(["run", "--resource-attr", "novalue"])[0]).toContain("expects key=value");
    expect(cliErrors(["run", "--resource-attr", "9bad=x"])[0]).toContain("must start with a letter");
    expect(cliErrors(["run", "--resource-attr", "api_key=x"])[0]).toContain("secret-name pattern");
  });

  it("is accepted by doctor and refused for providers", () => {
    expect(parseCliArgs(["doctor", "--resource-attr", "team.name=core"]).status).toBe("command");
    expect(cliErrors(["providers", "--resource-attr", "team.name=core"])[0]).toContain(
      'not accepted by "providers"',
    );
  });
});

describe("resource attributes in diagnostics", () => {
  it("reports attribute names but never a value", () => {
    const snapshot = describeResolvedConfig({
      ...DEFAULT_CONFIG,
      exporter: {
        ...DEFAULT_CONFIG.exporter,
        resourceAttributes: {
          "team.name": "core",
          "deployment.environment": "tenant-secret-value",
        },
      },
    });
    expect(snapshot["exporter.resource_attribute_names"]).toEqual([
      "deployment.environment",
      "team.name",
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("tenant-secret-value");
    expect(JSON.stringify(snapshot)).not.toContain("core");
  });

  it("never echoes an environment value in a warning, however malformed", () => {
    const { warnings } = parseEnvironmentConfig({
      OTEL_RESOURCE_ATTRIBUTES:
        "api_key=sk-live-must-not-appear,deployment.note=%zz-must-not-appear,Bearer sk-also-not",
    });
    const serialized = JSON.stringify(warnings);
    expect(serialized).not.toContain("sk-live-must-not-appear");
    expect(serialized).not.toContain("%zz-must-not-appear");
    expect(serialized).not.toContain("sk-also-not");
    expect(warnings).toHaveLength(3);
  });

  it("documents the flag, the variable, and the reserved-key rule", () => {
    const readme = readFileSync(
      path.join(import.meta.dirname, "..", "..", "README.md"),
      "utf8",
    );
    for (const fragment of [
      "--resource-attr",
      "OTEL_RESOURCE_ATTRIBUTES",
      "OTEL_SERVICE_NAME",
      "Baggage",
      "percent-encoded values",
      "per attribute key",
      "**`service.name` is never set by a resource attribute.**",
    ]) {
      expect(readme, fragment).toContain(fragment);
    }
    expect(CLI_USAGE).toContain("--resource-attr");
    expect(CLI_USAGE).toContain("service.name and service.namespace are");
  });

  it("drops a secret-looking key everywhere, so its value can never reach a resource", () => {
    const { patch } = parseEnvironmentConfig({
      OTEL_RESOURCE_ATTRIBUTES: "tenant.api_key=sk-live-1,team.name=core",
    });
    expect(patch.exporter?.resourceAttributes).toEqual({ "team.name": "core" });
    expect(okConfig([{ source: "environment", patch }]).exporter.resourceAttributes).toEqual({
      "team.name": "core",
    });
  });
});
