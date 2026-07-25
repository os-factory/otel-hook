import { describe, expect, it } from "vitest";

import {
  contentFactSchema,
  createPrivacyService,
  DEFAULT_PRIVACY_POLICY,
  resolvePrivacyPolicy,
  type PrivacyLimits,
  type PrivacyPolicy,
} from "../src/index.js";
import { createSeededRandom } from "./helpers/random.js";

type PolicyOverrides = Partial<Omit<PrivacyPolicy, "limits">> & {
  readonly limits?: Partial<PrivacyLimits>;
};

const policy = (overrides: PolicyOverrides = {}): PrivacyPolicy => ({
  ...DEFAULT_PRIVACY_POLICY,
  ...overrides,
  limits: { ...DEFAULT_PRIVACY_POLICY.limits, ...overrides.limits },
});

const SECRET = "sk-abcdefghijklmnopqrstuvwx";

describe("content disclosure modes", () => {
  it("omits content by default", () => {
    const service = createPrivacyService(policy());
    const fact = service.describeContent({ kind: "prompt", text: `please use ${SECRET}` });

    expect(service.policy.contentMode).toBe("omit");
    expect(fact.disclosure).toBe("omitted");
    expect(fact.text).toBeUndefined();
    expect(fact.characterLength).toBeGreaterThan(0);
    expect(fact.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(contentFactSchema.safeParse(fact).success).toBe(true);
  });

  it("masks non-whitespace characters while preserving shape", () => {
    const service = createPrivacyService(policy({ contentMode: "mask" }));
    const fact = service.describeContent({ kind: "prompt", text: "hello world" });

    expect(fact.disclosure).toBe("masked");
    expect(fact.text).toBe("***** *****");
  });

  it("redacts secret-looking spans", () => {
    const service = createPrivacyService(policy({ contentMode: "redact" }));
    const fact = service.describeContent({
      kind: "prompt",
      text: `token is ${SECRET} and key AKIAIOSFODNN7EXAMPLE`,
    });

    expect(fact.disclosure).toBe("redacted");
    expect(fact.text).not.toContain(SECRET);
    expect(fact.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(fact.text).toContain("[redacted]");
    expect(fact.secretsRedacted).toBe(2);
  });

  it("refuses raw mode unless it is explicitly allowed", () => {
    const service = createPrivacyService(policy({ contentMode: "raw" }));
    const fact = service.describeContent({ kind: "prompt", text: "hello" });

    expect(service.policy.contentMode).toBe("omit");
    expect(fact.text).toBeUndefined();
    expect(service.policyNotes.join(" ")).toContain("downgraded to omit");

    const resolution = resolvePrivacyPolicy(policy({ contentMode: "raw" }));
    expect(resolution.policy.contentMode).toBe("omit");
  });

  it("discloses raw text only with both switches set", () => {
    const service = createPrivacyService(policy({ contentMode: "raw", allowRawContent: true }));
    const fact = service.describeContent({ kind: "prompt", text: "hello" });
    expect(fact.disclosure).toBe("raw");
    expect(fact.text).toBe("hello");
  });

  it("bounds disclosed text and reports truncation", () => {
    const service = createPrivacyService(
      policy({ contentMode: "raw", allowRawContent: true, limits: { maxStringLength: 8 } }),
    );
    const fact = service.describeContent({ kind: "prompt", text: "0123456789abcdef" });

    expect(fact.text).toBe("01234567");
    expect(fact.truncated).toBe(true);
    expect(fact.characterLength).toBe(16);
  });

  it("measures code points and bytes separately", () => {
    const service = createPrivacyService(policy());
    const fact = service.describeContent({ kind: "prompt", text: "héllo 🌍" });

    expect(fact.characterLength).toBe(7);
    expect(fact.byteLength).toBe(11);
  });
});

describe("stable hashing", () => {
  it("is stable across services and sensitive to content", () => {
    const first = createPrivacyService(policy());
    const second = createPrivacyService(policy());

    expect(first.hash("abc")).toBe(second.hash("abc"));
    expect(first.hash("abc")).not.toBe(first.hash("abd"));
  });

  it("changes with the salt so hashes are not correlatable across deployments", () => {
    const unsalted = createPrivacyService(policy());
    const salted = createPrivacyService(policy({ hashSalt: "tenant-a" }));

    expect(salted.hash("abc")).not.toBe(unsalted.hash("abc"));
  });

  it("namespaces opaque ids", () => {
    const service = createPrivacyService(policy());
    expect(service.deriveOpaqueId("a", "x")).not.toBe(service.deriveOpaqueId("b", "x"));
  });
});

describe("secret key handling", () => {
  const service = createPrivacyService(policy());

  it("recognizes secret-looking keys in several spellings", () => {
    for (const key of [
      "token",
      "api_key",
      "apiKey",
      "AWS_SECRET_ACCESS_KEY",
      "authorization",
      "user.password",
      "set-cookie",
      "private_key",
    ]) {
      expect(service.isSecretKey(key), key).toBe(true);
    }
    for (const key of ["tokenizer", "keyboard", "model", "prompt_length"]) {
      expect(service.isSecretKey(key), key).toBe(false);
    }
  });

  it("replaces secret values recursively at every depth", () => {
    const result = service.sanitizeStructured({
      level1: {
        token: "t0p-secret",
        level2: [{ password: "hunter2" }, { safe: "value" }],
      },
    });

    const serialized = JSON.stringify(result.value);
    expect(serialized).not.toContain("t0p-secret");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).toContain("value");
    expect(result.stats.redactedKeys).toBe(2);
  });

  it("redacts secret keys in flat attribute bags", () => {
    const attributes = service.sanitizeAttributes({ authorization: "Bearer abc", tier: "gold" });
    expect(attributes.authorization).toBe("[redacted]");
    expect(attributes.tier).toBe("gold");
  });
});

describe("structural bounds", () => {
  const service = createPrivacyService(
    policy({ limits: { maxDepth: 3, maxArrayLength: 2, maxStringLength: 5, maxObjectKeys: 2 } }),
  );

  it("stops at the configured depth", () => {
    const result = service.sanitizeStructured({ a: { b: { c: { d: { e: 1 } } } } });
    expect(JSON.stringify(result.value)).toContain("<depth-exceeded>");
    expect(result.stats.depthExceeded).toBeGreaterThan(0);
  });

  it("truncates arrays and objects", () => {
    const result = service.sanitizeStructured({ list: [1, 2, 3, 4, 5], a: 1, b: 2, c: 3 });
    expect(result.stats.truncatedArrays).toBe(1);
    expect(result.stats.truncatedObjects).toBe(1);
    expect(Object.keys(result.value as Record<string, unknown>)).toHaveLength(2);
  });

  it("truncates strings", () => {
    const result = service.sanitizeStructured({ text: "0123456789" });
    expect(result.value).toEqual({ text: "01234" });
    expect(result.stats.truncatedStrings).toBe(1);
  });

  it("contains circular references instead of overflowing the stack", () => {
    const cyclic: Record<string, unknown> = { name: "root" };
    cyclic.self = cyclic;
    const result = service.sanitizeStructured(cyclic);

    expect(JSON.stringify(result.value)).toContain("<circular>");
    expect(result.stats.circularReferences).toBe(1);
  });

  it("drops values that cannot be represented as attributes", () => {
    // A service with room for every key, so truncation cannot mask the drops.
    const spacious = createPrivacyService(policy());
    const result = spacious.sanitizeStructured({
      fn: () => undefined,
      sym: Symbol("s"),
      nan: Number.NaN,
      big: 10n,
      when: new Date(0),
    });

    expect(result.value).toEqual({
      fn: null,
      sym: null,
      nan: null,
      big: "10",
      when: "1970-01-01T00:00:00.000Z",
    });
    expect(result.stats.droppedValues).toBe(3);
  });
});

describe("structured content facts", () => {
  it("never discloses secret-keyed values, even in raw mode", () => {
    const service = createPrivacyService(policy({ contentMode: "raw", allowRawContent: true }));
    const fact = service.describeStructured({
      kind: "tool-input",
      value: { command: "deploy", api_key: SECRET },
    });

    expect(fact.text).toBeDefined();
    expect(fact.text).not.toContain(SECRET);
    expect(fact.text).toContain("deploy");
    expect(fact.secretsRedacted).toBeGreaterThan(0);
    // The hash and lengths still describe the original value.
    expect(fact.characterLength).toBeGreaterThan(0);
  });

  it("hashes structurally equal values identically regardless of key order", () => {
    const service = createPrivacyService(policy());
    const first = service.describeStructured({ kind: "tool-input", value: { a: 1, b: 2 } });
    const second = service.describeStructured({ kind: "tool-input", value: { b: 2, a: 1 } });
    expect(first.contentHash).toBe(second.contentHash);
  });
});

describe("extension sanitization", () => {
  const service = createPrivacyService(policy());

  it("keeps namespaced primitives and drops everything else", () => {
    const result = service.sanitizeExtensions({
      "acme.tier": "gold",
      "acme.count": 3,
      unnamespaced: "dropped",
      "otelhook.reserved": "dropped",
      "acme.nested": { deep: true },
    });

    expect(result.extensions).toEqual({ "acme.tier": "gold", "acme.count": 3 });
    expect([...result.droppedKeys].sort()).toEqual([
      "acme.nested",
      "otelhook.reserved",
      "unnamespaced",
    ]);
  });

  it("redacts secret-looking namespaced keys rather than dropping them silently", () => {
    const result = service.sanitizeExtensions({ "acme.api_key": "abc" });
    expect(result.extensions["acme.api_key"]).toBe("[redacted]");
  });
});

describe("privacy properties", () => {
  const random = createSeededRandom(0xc0ffee);

  it("never discloses text under the default policy, for 300 random inputs", () => {
    const service = createPrivacyService(policy());
    for (let iteration = 0; iteration < 300; iteration += 1) {
      const text = random.string(200);
      const fact = service.describeContent({ kind: "prompt", text });
      expect(fact.text).toBeUndefined();
      expect(fact.disclosure).toBe("omitted");
      expect(fact.characterLength).toBe([...text].length);
      expect(fact.byteLength).toBe(Buffer.byteLength(text, "utf8"));
      expect(service.hash(text)).toBe(service.hash(text));
    }
  });

  it("respects every structural bound for randomly generated nested values", () => {
    const bounded = createPrivacyService(
      policy({ limits: { maxDepth: 4, maxArrayLength: 3, maxStringLength: 10, maxObjectKeys: 4 } }),
    );

    const build = (depth: number): unknown => {
      if (depth > 6) {
        return random.string(30);
      }
      const choice = random.int(0, 2);
      if (choice === 0) {
        return random.string(30);
      }
      if (choice === 1) {
        return Array.from({ length: random.int(0, 6) }, () => build(depth + 1));
      }
      const record: Record<string, unknown> = {};
      for (let index = 0; index < random.int(0, 6); index += 1) {
        record[`k${index}`] = build(depth + 1);
      }
      return record;
    };

    const measure = (value: unknown, depth = 0): void => {
      expect(depth).toBeLessThanOrEqual(4);
      if (typeof value === "string") {
        expect([...value].length).toBeLessThanOrEqual(Math.max(10, "<depth-exceeded>".length));
        return;
      }
      if (Array.isArray(value)) {
        expect(value.length).toBeLessThanOrEqual(3);
        for (const entry of value) {
          measure(entry, depth + 1);
        }
        return;
      }
      if (value !== null && typeof value === "object") {
        const entries = Object.entries(value);
        expect(entries.length).toBeLessThanOrEqual(4);
        for (const [, entry] of entries) {
          measure(entry, depth + 1);
        }
      }
    };

    for (let iteration = 0; iteration < 100; iteration += 1) {
      measure(bounded.sanitizeStructured(build(0)).value);
    }
  });
});
