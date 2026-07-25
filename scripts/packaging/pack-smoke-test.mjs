#!/usr/bin/env node
// Builds the package, packs it exactly as `npm publish` would, installs the
// resulting tarball into a throwaway scratch project (as an external consumer
// would), and exercises every public entry point and the CLI binary from
// there. Nothing is installed globally and nothing under the repository is
// mutated except dist/ (via the build step) and OS-temp scratch directories.
//
// Usage:
//   node scripts/packaging/pack-smoke-test.mjs [--json] [--skip-build]

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

const readPackageJson = async () =>
  JSON.parse(await readFile(path.join(REPO_ROOT, "package.json"), "utf8"));

/** Every export condition declared in package.json's "exports" map, e.g. "@osfactory/otel-hook/model". */
const exportSpecifiers = (pkg) =>
  Object.keys(pkg.exports).map((key) => (key === "." ? pkg.name : `${pkg.name}${key.slice(1)}`));

const runSmokeTest = async ({ skipBuild = false } = {}) => {
  const steps = [];
  const pkg = await readPackageJson();

  if (!skipBuild) {
    await execFileAsync("npm", ["run", "build"], { cwd: REPO_ROOT });
    steps.push("build: ok");
  }

  const packDestination = await mkdtemp(path.join(tmpdir(), "otel-hook-pack-"));
  const { stdout: packStdout } = await execFileAsync(
    "npm",
    ["pack", "--json", "--pack-destination", packDestination],
    { cwd: REPO_ROOT },
  );
  const [packInfo] = JSON.parse(packStdout);
  const tarballPath = path.join(packDestination, packInfo.filename);
  steps.push(`pack: ${packInfo.filename} (${String(packInfo.entryCount)} entries)`);

  const packedPaths = packInfo.files.map((file) => file.path);
  const allowedPrefixes = ["dist/", "README.md", "LICENSE", "package.json"];
  const unexpected = packedPaths.filter(
    (packedPath) => !allowedPrefixes.some((prefix) => packedPath === prefix || packedPath.startsWith(prefix)),
  );
  if (unexpected.length > 0) {
    throw new Error(`tarball contains unexpected paths outside package.json's "files": ${unexpected.join(", ")}`);
  }
  steps.push(`pack contents: only ${allowedPrefixes.join(", ")} (${String(packedPaths.length)} paths)`);

  const missingBin = pkg.bin
    ? Object.values(pkg.bin).filter((binPath) => !packedPaths.includes(binPath))
    : [];
  if (missingBin.length > 0) {
    throw new Error(`tarball is missing declared bin target(s): ${missingBin.join(", ")}`);
  }

  const consumerDir = await mkdtemp(path.join(tmpdir(), "otel-hook-consumer-"));
  try {
    await writeFile(
      path.join(consumerDir, "package.json"),
      JSON.stringify({ name: "otel-hook-packaging-smoke", version: "0.0.0", private: true, type: "module" }, null, 2),
    );
    await execFileAsync("npm", ["install", "--no-audit", "--no-fund", tarballPath], { cwd: consumerDir });
    steps.push("install: ok (installed from packed tarball, not the workspace source)");

    for (const specifier of exportSpecifiers(pkg)) {
      const { stdout } = await execFileAsync(
        process.execPath,
        ["--input-type=module", "-e", `import * as mod from ${JSON.stringify(specifier)}; console.log(Object.keys(mod).length);`],
        { cwd: consumerDir },
      );
      const exportCount = Number(stdout.trim());
      if (!(exportCount > 0)) {
        throw new Error(`import("${specifier}") resolved but exposed no exports`);
      }
      steps.push(`import ${specifier}: ok (${String(exportCount)} exports)`);
    }

    if (pkg.bin) {
      for (const [binName, binPath] of Object.entries(pkg.bin)) {
        const binExecutable = path.join(consumerDir, "node_modules", ".bin", binName);
        const { stdout } = await execFileAsync(binExecutable, ["--version"]);
        steps.push(`bin ${binName} (${binPath}) --version: ${stdout.trim()}`);
      }
    }

    return { ok: true, steps };
  } finally {
    await rm(consumerDir, { recursive: true, force: true });
    await rm(packDestination, { recursive: true, force: true });
  }
};

const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  const json = process.argv.includes("--json");
  const skipBuild = process.argv.includes("--skip-build");
  try {
    const result = await runSmokeTest({ skipBuild });
    if (json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      for (const step of result.steps) {
        process.stdout.write(`${step}\n`);
      }
    }
    process.exitCode = 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
    } else {
      process.stderr.write(`FAILED: ${message}\n`);
    }
    process.exitCode = 1;
  }
}

export { runSmokeTest };
