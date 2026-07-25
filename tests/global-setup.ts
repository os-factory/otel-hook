import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

/**
 * Build the package exactly once, before any test file runs.
 *
 * Two suites need `dist/`: the end-to-end suite spawns `dist/cli.js` as a child
 * process, and the packaging suite packs and installs the tarball. Letting either
 * one build on demand is a race — `tsup` is configured with `clean: true`, so a
 * rebuild deletes `dist/` out from under a concurrently spawned binary, which
 * surfaces as a test that fails only under a full parallel run. Building here
 * makes the artifact a precondition of the whole run instead of a side effect of
 * whichever file got there first.
 */
export const setup = async (): Promise<void> => {
  await execFileAsync("npx", ["tsup"], { cwd: REPO_ROOT, timeout: 300_000 });
};
