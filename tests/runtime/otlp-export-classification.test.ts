import { describe, expect, it } from "vitest";

import { classifyExportFailure } from "../../src/telemetry/otlp-export-classification.js";

describe("classifyExportFailure", () => {
  it("treats the OTLP retryable status codes as retryable for both transports", () => {
    for (const code of [1, 4, 8, 10, 11, 14, 15, 429, 502, 503, 504]) {
      expect(classifyExportFailure(Object.assign(new Error("export failed"), { code })), String(code)).toBe(
        "retryable",
      );
    }
    expect(classifyExportFailure(new Error("Export failed with retryable status"))).toBe("retryable");
  });

  it("treats terminal HTTP and gRPC statuses as terminal", () => {
    for (const code of [3, 5, 7, 16, 400, 401, 403, 404]) {
      expect(classifyExportFailure(Object.assign(new Error("export failed"), { code })), String(code)).toBe(
        "terminal",
      );
    }
  });

  it("keeps an unclassified transport failure retryable", () => {
    expect(classifyExportFailure(new Error("connect ECONNREFUSED"))).toBe("retryable");
    expect(classifyExportFailure(undefined)).toBe("retryable");
    expect(classifyExportFailure({ code: "ECONNREFUSED" })).toBe("retryable");
  });
});
