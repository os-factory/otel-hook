import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";

/**
 * Official `otelcol` image used when Docker can start it.
 *
 * The in-process gRPC receiver covers the exporter wire format everywhere.
 * This helper is the real collector: it receives OTLP/gRPC and forwards
 * OTLP/HTTP to a local capturing server. Linux host networking is required
 * because the collector and the test share `127.0.0.1`.
 */
export const OTELCOL_IMAGE = "otel/opentelemetry-collector:0.139.0";

export const officialCollectorAvailable = (): boolean => {
  if (process.platform !== "linux") {
    return false;
  }
  const docker = spawnSync("docker", ["info"], { stdio: "ignore", timeout: 8_000 });
  return docker.status === 0;
};

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address !== null && typeof address !== "string" ? address.port : 0;
      server.close(() => resolve(port));
    });
  });

export type OfficialCollector = {
  /** Plaintext gRPC base URL the trace sink should export to. */
  readonly grpcUrl: string;
  close(): Promise<void>;
};

/**
 * Start otelcol, or return undefined when this machine cannot run it.
 *
 * A failed `docker run` throws. Callers must not treat that as success.
 */
export const startOfficialCollector = async (otlpHttpBaseUrl: string): Promise<OfficialCollector | undefined> => {
  if (!officialCollectorAvailable()) {
    return undefined;
  }
  const inspected = spawnSync("docker", ["image", "inspect", OTELCOL_IMAGE], { stdio: "ignore" });
  if (inspected.status !== 0) {
    const pulled = spawnSync("docker", ["pull", OTELCOL_IMAGE], { stdio: "ignore", timeout: 120_000 });
    if (pulled.status !== 0) {
      throw new Error(`could not pull ${OTELCOL_IMAGE}`);
    }
  }

  const grpcPort = await freePort();
  const directory = await mkdtemp(path.join(tmpdir(), "otel-hook-otelcol-"));
  const configPath = path.join(directory, "config.yaml");
  const name = `otel-hook-col-${String(grpcPort)}`;
  await writeFile(
    configPath,
    [
      "receivers:",
      "  otlp:",
      "    protocols:",
      "      grpc:",
      `        endpoint: 127.0.0.1:${String(grpcPort)}`,
      "exporters:",
      "  otlphttp:",
      `    endpoint: ${otlpHttpBaseUrl}`,
      "    compression: none",
      "    tls:",
      "      insecure: true",
      "service:",
      "  telemetry:",
      "    logs:",
      "      level: info",
      "  pipelines:",
      "    traces:",
      "      receivers: [otlp]",
      "      exporters: [otlphttp]",
      "",
    ].join("\n"),
  );

  const started = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "-d",
      "--name",
      name,
      "--network",
      "host",
      "-v",
      `${configPath}:/etc/otelcol-hook/config.yaml:ro`,
      OTELCOL_IMAGE,
      "--config",
      "/etc/otelcol-hook/config.yaml",
    ],
    { encoding: "utf8" },
  );
  if (started.status !== 0) {
    await rm(directory, { recursive: true, force: true });
    throw new Error(`otelcol did not start: ${started.stderr || started.stdout}`);
  }

  const close = async (): Promise<void> => {
    spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    await rm(directory, { recursive: true, force: true });
  };

  const deadline = Date.now() + 20_000;
  let logs = "";
  while (Date.now() < deadline) {
    const read = spawnSync("docker", ["logs", name], { encoding: "utf8" });
    logs = `${read.stdout}\n${read.stderr}`;
    if (logs.includes("Everything is ready")) {
      return { grpcUrl: `http://127.0.0.1:${String(grpcPort)}`, close };
    }
    if (logs.includes("error") && logs.toLowerCase().includes("failed")) {
      await close();
      throw new Error(`otelcol failed while starting:\n${logs}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await close();
  throw new Error(`otelcol was not ready:\n${logs}`);
};
