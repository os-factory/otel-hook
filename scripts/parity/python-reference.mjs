#!/usr/bin/env node
// Runs synthetic parity fixtures through the pinned Python `opentelemetry-hooks`
// package and returns its emitted spans, for comparison against our own
// canonical event model. Never emits OTLP, never writes outside a throwaway
// temp directory, and never touches the invoking user's real state.
//
// Safety notes (see docs/shadow-mode.md and the differential-review notes this
// file's behavior is based on):
//   - OTEL_EXPORTER_OTLP_ENDPOINT is pinned empty: the package's bundled example
//     config would otherwise silently inject http://localhost:4317.
//   - IDE_OTEL_ENABLE_LOGS=false avoids its logs pipeline, which (unlike the
//     tracer pipeline) has no local-only bypass and always constructs a real
//     OTLP gRPC exporter, erroring loudly at an empty endpoint.
//   - IDE_OTEL_HOOK_HOME points at a fresh directory under the OS temp dir,
//     never the real user home, so nothing durable is written outside of it.
//   - Provider identity is pinned via the --claude/--cursor/... CLI flag
//     (highest-priority signal), never left to process-tree sniffing.
//
// Usage as a CLI:
//   node scripts/parity/python-reference.mjs --provider claude --session <dir-of-fixtures.json-in-order>
//   node scripts/parity/python-reference.mjs --probe   # print {"available": bool, "reason"?: string} and exit
//
// Usage as a module: import { isAvailable, runSession, PINNED_VERSION } from "./python-reference.mjs"

import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);

/** Runs a CLI with input piped to stdin, resolving once it exits (never rejects on a non-zero exit). */
const runWithStdin = (file, args, { env, input, timeout }) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { env });
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`${file} ${args.join(" ")} timed out after ${timeout}ms`));
      }
    }, timeout);

    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`${file} ${args.join(" ")} exited ${code}: ${stderr.slice(0, 2000)}`));
          return;
        }
        resolve();
      }
    });
    child.stdin?.write(input);
    child.stdin?.end();
  });

export const PINNED_VERSION = "0.14.0";

/** Reused across invocations within one process so the venv is only built once. */
const VENV_ROOT = path.join(tmpdir(), "otel-hook-parity-venv");

const SAFE_ENV_BASE = Object.freeze({
  OTEL_EXPORTER_OTLP_ENDPOINT: "",
  IDE_OTEL_ENABLE_LOGS: "false",
  IDE_OTEL_BATCH_ON_STOP: "false",
  IDE_OTEL_DISABLE_BATCH: "true",
  IDE_OTEL_LOCAL_SPANS: "1",
});

const findPython3 = () => {
  for (const candidate of ["python3", "python"]) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore" });
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
};

let cachedAvailability;

/**
 * Probe (once per process) whether the pinned Python package can be reached.
 * Never throws. Installs into a cached venv under the OS temp dir on first
 * use; subsequent calls, even across separate `node` invocations, reuse it
 * because the venv path is a pure function of PINNED_VERSION.
 */
export const isAvailable = async () => {
  if (cachedAvailability !== undefined) {
    return cachedAvailability;
  }

  const python3 = findPython3();
  if (python3 === undefined) {
    cachedAvailability = { available: false, reason: "no python3/python interpreter on PATH" };
    return cachedAvailability;
  }

  const venvDir = `${VENV_ROOT}-${PINNED_VERSION}`;
  const venvPython = path.join(venvDir, "bin", "python3");

  try {
    await mkdir(path.dirname(venvDir), { recursive: true });
    await execFileAsync(python3, ["-m", "venv", venvDir]);
  } catch (error) {
    cachedAvailability = {
      available: false,
      reason: `could not create python venv: ${error instanceof Error ? error.message : String(error)}`,
    };
    return cachedAvailability;
  }

  try {
    const { stdout } = await execFileAsync(venvPython, [
      "-c",
      "import importlib.metadata as m\nprint(m.version('opentelemetry-hooks'))",
    ]);
    if (stdout.trim() === PINNED_VERSION) {
      cachedAvailability = { available: true, venvPython };
      return cachedAvailability;
    }
  } catch {
    // Not installed yet in this venv; fall through to install.
  }

  try {
    await execFileAsync(
      venvPython,
      ["-m", "pip", "install", "--quiet", `opentelemetry-hooks==${PINNED_VERSION}`],
      { timeout: 120_000 },
    );
    const { stdout } = await execFileAsync(venvPython, [
      "-c",
      "import importlib.metadata as m\nprint(m.version('opentelemetry-hooks'))",
    ]);
    if (stdout.trim() !== PINNED_VERSION) {
      cachedAvailability = {
        available: false,
        reason: `installed version "${stdout.trim()}" does not match pinned ${PINNED_VERSION}`,
      };
      return cachedAvailability;
    }
    cachedAvailability = { available: true, venvPython };
    return cachedAvailability;
  } catch (error) {
    cachedAvailability = {
      available: false,
      reason: `pip install opentelemetry-hooks==${PINNED_VERSION} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
    return cachedAvailability;
  }
};

const CLI_FLAG_BY_PROVIDER = Object.freeze({
  "claude-code": "--claude",
  cursor: "--cursor",
  codex: "--codex",
  windsurf: "--windsurf",
  copilot: "--copilot",
  gemini: "--gemini",
  opencode: "--opencode",
});

/**
 * Run one ordered sequence of raw hook payloads (one JSON object per event, as
 * a real hook driver would invoke the CLI once per event) through the pinned
 * package, in an isolated, pre-warmed IDE_OTEL_HOOK_HOME, and return the parsed
 * local-spans JSONL it produced for that session.
 *
 * Returns `{ available: false, reason }` if the reference is not usable, or
 * `{ available: true, spans }` otherwise. Never throws.
 */
export const runSession = async (provider, payloads) => {
  const availability = await isAvailable();
  if (!availability.available) {
    return { available: false, reason: availability.reason };
  }
  const flag = CLI_FLAG_BY_PROVIDER[provider];
  if (flag === undefined) {
    return { available: false, reason: `unsupported provider "${provider}"` };
  }

  const hookHome = await mkdtemp(path.join(tmpdir(), "otel-hook-parity-home-"));
  const otelHookBin = path.join(path.dirname(availability.venvPython), "otel-hook");

  try {
    for (const payload of payloads) {
      await runWithStdin(otelHookBin, [flag], {
        env: { ...process.env, ...SAFE_ENV_BASE, IDE_OTEL_HOOK_HOME: hookHome },
        input: JSON.stringify(payload),
        timeout: 30_000,
      });
    }

    const spansDir = path.join(hookHome, ".state", "local_spans");
    let files;
    try {
      files = await readdir(spansDir);
    } catch {
      return { available: true, spans: [] };
    }

    const spans = [];
    for (const file of files) {
      const contents = await readFile(path.join(spansDir, file), "utf8");
      for (const line of contents.split("\n")) {
        if (line.trim().length === 0) {
          continue;
        }
        spans.push(JSON.parse(line));
      }
    }
    return { available: true, spans };
  } catch (error) {
    return {
      available: false,
      reason: `otel-hook invocation failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    // The pinned package can still be flushing state into IDE_OTEL_HOOK_HOME as
    // the last child exits, which races the directory walk and surfaces as
    // ENOTEMPTY. Retry, and never let cleanup of a temp directory fail a parity
    // run: the directory is under the OS temp root either way.
    await rm(hookHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(
      () => undefined,
    );
  }
};

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  if (process.argv.includes("--probe")) {
    const availability = await isAvailable();
    process.stdout.write(`${JSON.stringify(availability)}\n`);
    process.exitCode = availability.available ? 0 : 1;
  } else {
    const providerFlagIndex = process.argv.indexOf("--provider");
    if (providerFlagIndex === -1 || process.argv[providerFlagIndex + 1] === undefined) {
      process.stderr.write(
        "usage:\n" +
          "  node scripts/parity/python-reference.mjs --probe\n" +
          "  node scripts/parity/python-reference.mjs --provider <id> < payloads.json\n" +
          "    (payloads.json is a JSON array of raw hook payload objects, in session order)\n",
      );
      process.exitCode = 1;
    } else {
      const provider = process.argv[providerFlagIndex + 1];
      const payloads = JSON.parse(await readStdin());
      const result = await runSession(provider, payloads);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exitCode = result.available ? 0 : 1;
    }
  }
}
