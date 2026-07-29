import { describe, expect, it } from "vitest";

import { CANONICAL_SCHEMA_VERSION, VERSION } from "../src/index.js";

describe("package bootstrap", () => {
  it("exports package and schema versions", () => {
    expect(VERSION).toBe("0.1.0");
    expect(CANONICAL_SCHEMA_VERSION).toBe(1);
  });
});
