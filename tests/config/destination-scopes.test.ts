import { describe, expect, it } from "vitest";

import {
  DEFAULT_EXPORTER_POLICY,
  describeExportDestinations,
  describeResolvedConfig,
  matchDestinationScope,
  normalizeRepositoryKey,
  otelHookConfigPatchSchema,
  resolveConfig,
  resolveExportDestinations,
  type ExporterPolicy,
} from "../../src/index.js";

const exporterWith = (destinations: ExporterPolicy["destinations"], logs = true): ExporterPolicy => ({
  ...DEFAULT_EXPORTER_POLICY,
  logs: { ...DEFAULT_EXPORTER_POLICY.logs, enabled: logs },
  destinations,
});

describe("normalizeRepositoryKey", () => {
  it.each([
    ["https://github.com/Acme/Widget.git", "github.com/acme/widget"],
    ["https://github.com/acme/widget/", "github.com/acme/widget"],
    ["https://user:secret@github.com:8443/acme/widget", "github.com/acme/widget"],
    ["git@github.com:acme/widget.git", "github.com/acme/widget"],
    ["ssh://git@github.com:22/acme/widget.git", "github.com/acme/widget"],
    ["github.com/acme/widget", "github.com/acme/widget"],
    ["  GITLAB.example/group/sub/repo  ", "gitlab.example/group/sub/repo"],
  ])("%s -> %s", (reference, key) => {
    expect(normalizeRepositoryKey(reference)).toBe(key);
  });

  it("trims trailing slashes in linear time", () => {
    const started = performance.now();
    expect(normalizeRepositoryKey(`github.com/acme/widget.git${"/".repeat(1_500)}`)).toBe("github.com/acme/widget");
    expect(performance.now() - started).toBeLessThan(500);
  });

  it.each(["", "   ", "/home/user/repo", "./repo", "file:///srv/repo.git", "https://github.com/", "C:\\repo"])(
    "names no repository: %j",
    (reference) => {
      expect(normalizeRepositoryKey(reference)).toBeUndefined();
    },
  );
});

describe("exporter.destinations[].scopes", () => {
  it("accepts the documented shape and rejects what it cannot match", () => {
    const ok = otelHookConfigPatchSchema.safeParse({
      exporter: {
        destinations: [
          {
            name: "hosted",
            endpoint: "https://ingest.example/v1/traces",
            signals: ["traces", "logs", "metrics"],
            scopes: [
              {
                repositories: ["https://github.com/acme/widget", "git@github.com:acme/gadget.git"],
                signals: ["traces", "metrics"],
                contentMode: "redact",
                includeSessionId: false,
              },
              { repositories: "*", signals: ["metrics"] },
            ],
          },
        ],
      },
    });
    expect(ok.success).toBe(true);

    for (const scopes of [
      [],
      [{ repositories: [] }],
      [{ repositories: ["/local/path"] }],
      [{ repositories: "all" }],
      [{ repositories: "*", contentMode: "everything" }],
      [{ repositories: "*", extra: true }],
    ]) {
      const parsed = otelHookConfigPatchSchema.safeParse({
        exporter: { destinations: [{ name: "hosted", endpoint: "https://ingest.example/v1/traces", scopes }] },
      });
      expect(parsed.success, JSON.stringify(scopes)).toBe(false);
    }
  });

  it("intersects scope signals with the destination's and normalizes repositories", () => {
    const [destination] = resolveExportDestinations(
      exporterWith(
        [
          {
            name: "hosted",
            endpoint: "https://ingest.example/v1/traces",
            signals: ["traces", "metrics"],
            scopes: [
              { repositories: ["https://github.com/Acme/Widget.git"] },
              { repositories: "*", signals: ["logs"] },
            ],
          },
        ],
        false,
      ),
    );
    expect(destination?.scopes).toHaveLength(2);
    const [first, second] = destination?.scopes ?? [];
    expect(first?.signals).toEqual({ traces: true, logs: false, metrics: true });
    expect(first?.includeSessionId).toBe(true);
    expect(first?.repositories).toEqual(new Set(["github.com/acme/widget"]));
    // Logs are neither the destination's nor enabled: the scope cannot add them.
    expect(second?.signals).toEqual({ traces: false, logs: false, metrics: false });
  });

  it("matches the first scope that lists the repository, and nothing without one", () => {
    const [destination] = resolveExportDestinations(
      exporterWith([
        {
          name: "hosted",
          endpoint: "https://ingest.example/v1/traces",
          scopes: [
            { repositories: ["github.com/acme/widget"], contentMode: "omit" },
            { repositories: "*", contentMode: "mask" },
          ],
        },
      ]),
    );
    const scopes = destination?.scopes ?? [];
    expect(matchDestinationScope(scopes, "github.com/acme/widget")?.contentMode).toBe("omit");
    expect(matchDestinationScope(scopes, "github.com/acme/other")?.contentMode).toBe("mask");
    expect(matchDestinationScope(scopes, undefined)).toBeUndefined();
  });

  it("leaves an unscoped destination without scopes", () => {
    const [destination] = resolveExportDestinations(
      exporterWith([{ name: "local", endpoint: "http://127.0.0.1:4318/v1/traces" }]),
    );
    expect(destination?.scopes).toBeUndefined();
  });

  it("describes scopes for doctor, but snapshots only their count", () => {
    const exporter = exporterWith([
      {
        name: "hosted",
        endpoint: "https://ingest.example/v1/traces",
        scopes: [{ repositories: ["git@github.com:acme/widget.git"], contentMode: "redact", includeSessionId: false }],
      },
      { name: "local", endpoint: "http://127.0.0.1:4318/v1/traces" },
    ]);
    const [hosted, local] = describeExportDestinations(exporter);
    expect(hosted?.scopes).toEqual([
      {
        repositories: ["github.com/acme/widget"],
        signals: ["traces", "logs"],
        contentMode: "redact",
        includeSessionId: false,
      },
    ]);
    expect(local?.scopes).toBeUndefined();

    const resolution = resolveConfig([{ source: "file", patch: { exporter } }]);
    expect(resolution.status).toBe("ok");
    if (resolution.status !== "ok") {
      return;
    }
    const snapshot = describeResolvedConfig(resolution.config);
    expect(snapshot["exporter.destination.hosted.scope_count"]).toBe(1);
    expect(JSON.stringify(snapshot)).not.toContain("acme/widget");
  });

  it("notes a scope that asks for more content than the installation discloses", () => {
    const resolution = resolveConfig([
      {
        source: "file",
        patch: {
          privacy: { contentMode: "mask" },
          exporter: {
            destinations: [
              {
                name: "hosted",
                endpoint: "https://ingest.example/v1/traces",
                scopes: [{ repositories: "*", contentMode: "raw" }],
              },
            ],
          },
        },
      },
    ]);
    expect(resolution.status).toBe("ok");
    expect(resolution.status === "ok" ? resolution.notes.join("\n") : "").toContain(
      "a scope can only lower disclosure",
    );
  });
});
