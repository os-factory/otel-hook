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
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const runNpm = (args, options = {}) =>
  process.env.npm_execpath
    ? execFileAsync(process.execPath, [process.env.npm_execpath, ...args], options)
    : execFileAsync("npm", args, options);

const pathExists = async (target) => {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
};

const readPackageJson = async () =>
  JSON.parse(await readFile(path.join(REPO_ROOT, "package.json"), "utf8"));

/** Every export condition declared in package.json's "exports" map, e.g. "@osfactory/otel-hook/model". */
const exportSpecifiers = (pkg) =>
  Object.keys(pkg.exports).map((key) => (key === "." ? pkg.name : `${pkg.name}${key.slice(1)}`));

const runSmokeTest = async ({ skipBuild = false } = {}) => {
  const steps = [];
  const pkg = await readPackageJson();

  if (!skipBuild) {
    await runNpm(["run", "build"], { cwd: REPO_ROOT });
    steps.push("build: ok");
  }

  const packDestination = await mkdtemp(path.join(tmpdir(), "otel-hook-pack-"));
  const { stdout: packStdout } = await runNpm(
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
    await runNpm(["install", "--no-audit", "--no-fund", tarballPath], {
      cwd: consumerDir,
    });
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
        const binExecutable = path.join(consumerDir, "node_modules", pkg.name, binPath);
        const runBin = (args) => execFileAsync(process.execPath, [binExecutable, ...args]);
        const { stdout } = await runBin(["--version"]);
        steps.push(`bin ${binName} (${binPath}) --version: ${stdout.trim()}`);

        // The installed binary must be able to reach every provider adapter it
        // claims to ship: a subpath that resolves in the tarball says nothing
        // about whether the bundled CLI can actually construct the adapters.
        const { stdout: providersJson } = await runBin(["providers", "--json"]);
        const providers = JSON.parse(providersJson);
        if (!Array.isArray(providers) || providers.length === 0) {
          throw new Error(`bin ${binName} providers --json returned no adapters`);
        }
        for (const entry of providers) {
          if (typeof entry.id !== "string" || typeof entry.maturity !== "string") {
            throw new Error(`bin ${binName} providers --json entry is missing id/maturity`);
          }
        }
        steps.push(
          `bin ${binName} providers --json: ${providers.map((entry) => `${entry.id}/${entry.maturity}`).join(" ")}`,
        );

        // doctor exits 1 with no endpoint configured, which is the healthy
        // outcome to assert here: it proves the diagnostic path runs end to end
        // in an installed package rather than only in the source tree.
        let doctorStdout;
        try {
          ({ stdout: doctorStdout } = await execFileAsync(process.execPath, [binExecutable, "doctor", "--json"], {
            env: { ...process.env, OTEL_HOOK_STATE_DIR: path.join(consumerDir, ".otel-hook-state") },
          }));
        } catch (error) {
          if (typeof error?.stdout !== "string" || error.stdout.length === 0) {
            throw error;
          }
          doctorStdout = error.stdout;
        }
        const report = JSON.parse(doctorStdout);
        if (typeof report.ok !== "boolean" || !Array.isArray(report.checks)) {
          throw new Error(`bin ${binName} doctor --json returned an unexpected report shape`);
        }
        steps.push(`bin ${binName} doctor --json: ${report.checks.length} check(s), ok=${String(report.ok)}`);

        // The registration lifecycle must work from an installed package on
        // every platform this ships to, so it is exercised here rather than
        // only in the source tree. A dry run against a scratch project root
        // proves the whole path — planner, scope resolution, formatting,
        // rendering — without writing into anyone's real configuration.
        const scratchProject = path.join(consumerDir, "scratch-project");
        const { stdout: setupJson } = await runBin([
          "setup",
          "--provider",
          "claude-code",
          "--provider",
          "codex",
          "--provider",
          "gemini-cli",
          "--scope",
          "project",
          "--project-dir",
          scratchProject,
          "--dry-run",
          "--json",
        ]);
        const setupReport = JSON.parse(setupJson);
        if (setupReport.ok !== true || setupReport.dryRun !== true) {
          throw new Error(`bin ${binName} setup --dry-run --json did not report a clean dry run`);
        }
        for (const outcome of setupReport.outcomes) {
          if (outcome.status !== "planned" || typeof outcome.plannedContents !== "string") {
            throw new Error(
              `bin ${binName} setup --dry-run planned nothing for ${String(outcome.providerId)}`,
            );
          }
          JSON.parse(outcome.plannedContents);
        }
        if (await pathExists(scratchProject)) {
          throw new Error(`bin ${binName} setup --dry-run wrote to disk`);
        }
        steps.push(
          `bin ${binName} setup --dry-run --json: planned ${setupReport.outcomes.length} target(s), wrote nothing`,
        );

        // An unsupported provider must fail loudly and machine-readably rather
        // than write a guessed configuration shape.
        let cursorStdout;
        try {
          ({ stdout: cursorStdout } = await runBin([
            "setup",
            "--provider",
            "cursor",
            "--project-dir",
            scratchProject,
            "--json",
          ]));
          throw new Error(`bin ${binName} setup --provider cursor unexpectedly succeeded`);
        } catch (error) {
          if (typeof error?.stdout !== "string" || error.stdout.length === 0) {
            throw error;
          }
          cursorStdout = error.stdout;
        }
        const cursorReport = JSON.parse(cursorStdout);
        if (cursorReport.ok !== false || cursorReport.outcomes[0]?.status !== "unsupported") {
          throw new Error(`bin ${binName} setup --provider cursor did not report "unsupported"`);
        }
        steps.push(`bin ${binName} setup --provider cursor: unsupported, exit 1`);
      }
    }

    return { ok: true, steps };
  } finally {
    await rm(consumerDir, { recursive: true, force: true });
    await rm(packDestination, { recursive: true, force: true });
  }
};

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
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
