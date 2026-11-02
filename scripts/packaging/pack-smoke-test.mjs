#!/usr/bin/env node
// Builds the package, packs it exactly as `npm publish` would, installs the
// resulting tarball into a throwaway scratch project (as an external consumer
// would), and exercises every public entry point and the CLI binary from
// there. Nothing is installed globally and nothing under the repository is
// mutated except dist/ (via the build step) and OS-temp scratch directories.
//
// Usage:
//   node scripts/packaging/pack-smoke-test.mjs [--json] [--skip-build]

import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

const withoutHookEnv = () => {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("OTEL_HOOK_") && value !== undefined) {
      env[key] = value;
    }
  }
  return env;
};

/**
 * Both local exporters, from the installed tarball: the CLI (privacy, stdout,
 * file mode) and the library entry points (envelope, forbidden paths).
 *
 * Unix mode bits are asserted only where the OS implements them. Windows still
 * runs the write, the stdout check, and the reserved-device refusal.
 */
/**
 * `execFile`'s `input` option does not end stdin for this Node, so `run` — which
 * reads stdin until EOF — would wait forever. Spawn and close stdin explicitly,
 * the same way the end-to-end harness drives the CLI.
 */
const runWithStdin = (executable, args, { cwd, env, input }) =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const error = new Error(`command exited ${String(code)}`);
      error.stdout = stdout;
      error.stderr = stderr;
      error.code = code;
      reject(error);
    });
    child.stdin.write(input);
    child.stdin.end();
  });

const exercisePackedLocalExporters = async ({ consumerDir, binExecutable, steps }) => {
  const secret = "packaging-secret-do-not-export";
  const stateDir = path.join(consumerDir, "local-export-state");
  const jsonlPath = path.join(consumerDir, "events.jsonl");
  const env = withoutHookEnv();
  const payload = JSON.stringify({
    hook_event_name: "UserPromptSubmit",
    session_id: "ses-pack-local",
    cwd: "/workspace/fixture-repo",
    prompt: secret,
  });
  const run = (args) =>
    runWithStdin(process.execPath, [binExecutable, ...args], {
      cwd: consumerDir,
      env,
      input: payload,
    });

  let result;
  try {
    result = await run([
      "run",
      "--provider",
      "claude-code",
      "--no-export",
      "--jsonl",
      jsonlPath,
      "--console",
      "--log-level",
      "silent",
      "--state-dir",
      stateDir,
    ]);
  } catch (error) {
    const detail =
      typeof error === "object" && error !== null && "stderr" in error
        ? String(error.stderr)
        : error instanceof Error
          ? error.message
          : String(error);
    throw new Error(`packed CLI local export exited non-zero: ${detail}`, { cause: error });
  }
  const { stdout, stderr } = result;
  if (stdout !== "") {
    throw new Error("packed CLI local export wrote to stdout");
  }
  if (!stderr.includes('"schema":"otelhook.local-export"') || !stderr.includes('"schemaVersion":1')) {
    throw new Error("packed CLI console exporter did not write the versioned envelope to stderr");
  }
  if (stderr.includes(secret) || stderr.includes("/workspace/fixture-repo")) {
    throw new Error("packed CLI console exporter received data before privacy filtering");
  }
  const body = await readFile(jsonlPath, "utf8");
  if (!body.includes('"schema":"otelhook.local-export"') || !body.includes('"schemaVersion":1')) {
    throw new Error("packed CLI JSONL exporter did not write a versioned envelope");
  }
  if (body.includes(secret) || body.includes("/workspace/fixture-repo")) {
    throw new Error("packed CLI JSONL exporter received data before privacy filtering");
  }
  if (process.platform !== "win32") {
    const mode = (await stat(jsonlPath)).mode & 0o777;
    if (mode !== 0o600) {
      throw new Error(`packed CLI JSONL file mode was ${mode.toString(8)}, expected 600`);
    }
  }
  steps.push("local export CLI: jsonl + stderr console, empty stdout, privacy held");

  for (const forbidden of ["/dev/stdout", "/dev/fd/1", "CON.jsonl", String.raw`\\.\CON`]) {
    const refused = await run([
      "run",
      "--provider",
      "claude-code",
      "--no-export",
      "--jsonl",
      forbidden,
      "--log-level",
      "silent",
      "--state-dir",
      stateDir,
    ]);
    if (refused.stdout !== "" || refused.stdout.includes("otelhook.local-export")) {
      throw new Error(`packed CLI wrote stdout for forbidden JSONL path ${forbidden}`);
    }
  }
  if (await pathExists(path.join(consumerDir, "CON.jsonl"))) {
    throw new Error("packed CLI created CON.jsonl");
  }
  steps.push("local export CLI: refused stdout and Windows reserved-device paths");

  const scriptPath = path.join(consumerDir, "exercise-local-export.mjs");
  const libraryJsonl = path.join(consumerDir, "library-events.jsonl");
  await writeFile(
    scriptPath,
    [
      'import { createConsoleSink, createFixedClock, createJsonlSink, isForbiddenJsonlPath, parseCanonicalEvent, CANONICAL_SCHEMA_VERSION, LOCAL_EXPORT_SCHEMA } from "@osfactory/otel-hook";',
      'import { createTestIdentity } from "@osfactory/otel-hook/testing";',
      "const forbidden = ['/dev/stdout', '/dev/stderr', '/dev/fd/1', '/dev/fd/2', '/proc/self/fd/1', '/proc/self/fd/2', '-', 'stdout', 'CON', 'CON.jsonl', 'NUL.txt', 'COM1', 'LPT1', String.raw`\\\\.\\CON`];",
      "for (const candidate of forbidden) {",
      "  if (!isForbiddenJsonlPath(candidate)) {",
      "    process.stderr.write(`allowed forbidden path ${candidate}\\n`);",
      "    process.exit(1);",
      "  }",
      "}",
      "if (isForbiddenJsonlPath('events.jsonl') || isForbiddenJsonlPath('C:/logs/events.jsonl')) {",
      "  process.stderr.write('rejected a regular jsonl path\\n');",
      "  process.exit(1);",
      "}",
      "const identity = createTestIdentity();",
      "const event = parseCanonicalEvent({",
      "  schemaVersion: CANONICAL_SCHEMA_VERSION,",
      "  invocationId: identity.invocationId,",
      "  sessionId: identity.sessionId,",
      "  provenance: identity.provenance,",
      "  workspace: identity.workspace,",
      "  extensions: {},",
      "  eventId: 'evt_0000000000000001',",
      "  sequence: 1,",
      "  occurredAt: 1700000000000,",
      "  type: 'session.start',",
      "  sessionKind: 'interactive',",
      "});",
      "const clock = createFixedClock({ tickMillis: 0 });",
      "const lines = [];",
      "const consoleSink = createConsoleSink({ write: (line) => lines.push(line) });",
      "const jsonlSink = createJsonlSink({ path: process.argv[2], maxBytes: 1048576, maxFiles: 2, clock });",
      "const consoleResult = await consoleSink.emit([event]);",
      "const jsonlResult = await jsonlSink.emit([event]);",
      "if (consoleResult.accepted !== 1 || jsonlResult.accepted !== 1) {",
      "  process.stderr.write('local sinks rejected the event\\n');",
      "  process.exit(1);",
      "}",
      "if (!lines[0]?.includes(LOCAL_EXPORT_SCHEMA)) {",
      "  process.stderr.write('console sink omitted the envelope\\n');",
      "  process.exit(1);",
      "}",
      "process.stderr.write(lines[0] ?? '');",
    ].join("\n"),
  );
  const library = await runWithStdin(process.execPath, [scriptPath, libraryJsonl], {
    cwd: consumerDir,
    env: process.env,
    input: "",
  });
  if (library.stdout !== "") {
    throw new Error("packed library console sink wrote to stdout");
  }
  if (!library.stderr.includes('"schema":"otelhook.local-export"')) {
    throw new Error("packed library console sink did not emit the envelope");
  }
  const libraryBody = await readFile(libraryJsonl, "utf8");
  if (!libraryBody.includes('"schema":"otelhook.local-export"') || !libraryBody.includes('"schemaVersion":1')) {
    throw new Error("packed library JSONL sink did not write a versioned envelope");
  }
  if (process.platform !== "win32") {
    const mode = (await stat(libraryJsonl)).mode & 0o777;
    if (mode !== 0o600) {
      throw new Error(`packed library JSONL file mode was ${mode.toString(8)}, expected 600`);
    }
  }
  steps.push("local export library: jsonl + console from the installed package");
};

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
          "cursor",
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

        // A provider whose install *location* is unverified must fail loudly and
        // machine-readably rather than write a guessed path into a home directory.
        let refusedStdout;
        try {
          ({ stdout: refusedStdout } = await runBin([
            "setup",
            "--provider",
            "antigravity",
            "--project-dir",
            scratchProject,
            "--json",
          ]));
          throw new Error(`bin ${binName} setup --provider antigravity unexpectedly succeeded`);
        } catch (error) {
          if (typeof error?.stdout !== "string" || error.stdout.length === 0) {
            throw error;
          }
          refusedStdout = error.stdout;
        }
        const refusedReport = JSON.parse(refusedStdout);
        if (refusedReport.ok !== false || refusedReport.outcomes[0]?.status !== "unsupported") {
          throw new Error(`bin ${binName} setup --provider antigravity did not report "unsupported"`);
        }
        steps.push(`bin ${binName} setup --provider antigravity: unsupported, exit 1`);
      }
      const [binName, binPath] = Object.entries(pkg.bin)[0];
      const binExecutable = path.join(consumerDir, "node_modules", pkg.name, binPath);
      await exercisePackedLocalExporters({ consumerDir, binExecutable, steps });
      steps.push(`local export exercised via bin ${binName}`);
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
