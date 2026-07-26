import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  NEW_DOCUMENT_MODE,
  writeDocumentAtomically,
} from "../../src/install/document.js";
import { FileLockTimeoutError, lockPathFor, withFileLock } from "../../src/install/file-lock.js";
import {
  checkManagedMarker,
  DEFAULT_MANAGED_COMMAND_MARKER,
  managedHookPredicate,
} from "../../src/install/planners.js";
import { runRegistrationLifecycle } from "../../src/install/lifecycle.js";
import { createFixedClock } from "../../src/runtime/clock.js";

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(tmpdir(), "otel-hook-install-safety-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

const isPosix = process.platform !== "win32";

describe("managed marker validation", () => {
  it("refuses an empty marker, which would match every hook already configured", () => {
    expect(checkManagedMarker("")).toBe("empty");
    // The concrete danger: `"".includes()` is true for any command, so an empty
    // marker turns `uninstall` into "delete every hook this developer has".
    expect(() => managedHookPredicate("")).toThrow(/every hook/);
  });

  it("refuses generic markers that would match unrelated commands", () => {
    // The failure mode length and alphanumerics cannot catch: each of these reads
    // as a deliberate marker and matches hooks this tool does not own.
    // `run` matches `npm run build` and `cargo run`; `npm` matches every npm
    // script hook; `node` matches every node-invoked hook on the machine.
    for (const generic of ["run", "npm", "node", "hook", "cli", "dist/cli.js", "-.-", "o"]) {
      expect(checkManagedMarker(generic)).toBe("not-ownership-bearing");
    }

    expect(checkManagedMarker(" otel-hook ")).toBe("untrimmed");
    expect(checkManagedMarker("x".repeat(201))).toBe("too-long");
    expect(checkManagedMarker("")).toBe("empty");
  });

  it("accepts a marker that names this tool, in any casing", () => {
    for (const owned of [
      "otel-hook",
      "otel-hook run --provider codex",
      "@osfactory/otel-hook",
      "Otel-Hook",
      "npx otel-hook",
    ]) {
      expect(checkManagedMarker(owned)).toBeUndefined();
    }
  });

  it("accepts an absolute path to an installed command on its specificity", () => {
    // A rooted path cannot appear inside an unrelated command line, so it is
    // ownership-bearing even when it does not spell out the package name — which is
    // what lets an operator point at a bespoke install location.
    for (const installed of [
      "/usr/local/lib/node_modules/@osfactory/otel-hook/dist/cli.js",
      "/opt/tools/oh/cli.js",
      "C:\\Program Files\\oh\\cli.js",
      "C:/Program Files/oh/cli.js",
      "\\\\build-host\\share\\oh\\cli.js",
    ]) {
      expect(checkManagedMarker(installed)).toBeUndefined();
    }

    // A relative path is not specific enough: `dist/cli.js` appears in plenty of
    // commands that are not this one.
    expect(checkManagedMarker("./dist/cli.js")).toBe("not-ownership-bearing");
    // Nor is a bare root.
    expect(checkManagedMarker("/opt")).toBe("not-ownership-bearing");
  });

  it("refuses a generic marker before opening a document", async () => {
    const project = path.join(rootDir, "generic");
    const settings = path.join(project, ".claude", "settings.json");
    const original = JSON.stringify(
      { hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "npm run telemetry" }] }] } },
      null,
      2,
    );
    await writeDocumentAtomically(settings, original);

    const report = await runRegistrationLifecycle({
      action: "uninstall",
      providerIds: ["claude-code"],
      scopes: ["project"],
      roots: { homeDir: path.join(rootDir, "home"), projectDir: project },
      managedMarker: "run",
      dryRun: false,
      clock: createFixedClock(),
    });

    expect(report.ok).toBe(false);
    expect(report.outcomes[0]?.status).toBe("blocked");
    // The unrelated npm hook, which "run" would have matched, is untouched.
    expect(await readFile(settings, "utf8")).toBe(original);
  });

  it("accepts the default marker and matches only commands containing it", () => {
    expect(checkManagedMarker(DEFAULT_MANAGED_COMMAND_MARKER)).toBeUndefined();
    const matches = managedHookPredicate(DEFAULT_MANAGED_COMMAND_MARKER);
    expect(matches({ type: "command", command: "otel-hook run --provider codex" })).toBe(true);
    expect(matches({ type: "command", command: "some-other-tool --flag" })).toBe(false);
  });

  it("refuses the whole run before opening a document, and changes nothing", async () => {
    const project = path.join(rootDir, "project");
    const settings = path.join(project, ".claude", "settings.json");
    const original = JSON.stringify(
      { hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "someone-elses-tool" }] }] } },
      null,
      2,
    );
    await writeDocumentAtomically(settings, original);

    const report = await runRegistrationLifecycle({
      action: "uninstall",
      providerIds: ["claude-code"],
      scopes: ["project"],
      roots: { homeDir: path.join(rootDir, "home"), projectDir: project },
      managedMarker: "",
      dryRun: false,
      clock: createFixedClock(),
    });

    expect(report.ok).toBe(false);
    expect(report.outcomes[0]?.status).toBe("blocked");
    expect(report.outcomes[0]?.problems.join(" ")).toContain("every hook");
    // The unrelated hook is still exactly as it was.
    expect(await readFile(settings, "utf8")).toBe(original);
  });
});

describe("atomic document replacement and file modes", () => {
  it.runIf(isPosix)("creates a new document owner-readable only", async () => {
    const target = path.join(rootDir, "fresh", "settings.json");
    await writeDocumentAtomically(target, "{}\n");

    // A rename replaces the inode, so the mode travels with the temp file. Left to
    // the umask this would typically be 0644 — and a hook command line can carry
    // an endpoint token.
    expect((await stat(target)).mode & 0o777).toBe(NEW_DOCUMENT_MODE);
  });

  it.runIf(isPosix)("preserves the mode a developer chose, both narrower and wider", async () => {
    for (const mode of [0o600, 0o640, 0o644]) {
      const target = path.join(rootDir, `mode-${mode.toString(8)}.json`);
      await writeFile(target, "{}\n", "utf8");
      await chmod(target, mode);

      await writeDocumentAtomically(target, '{"hooks":{}}\n');

      expect((await stat(target)).mode & 0o777).toBe(mode);
      expect(await readFile(target, "utf8")).toBe('{"hooks":{}}\n');
    }
  });

  it("leaves no temp file behind on success", async () => {
    const target = path.join(rootDir, "clean", "settings.json");
    await writeDocumentAtomically(target, "{}\n");
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(path.dirname(target))).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
});

describe("install file lock ownership", () => {
  const clock = (): ReturnType<typeof createFixedClock> => createFixedClock();

  it("does not let a stale-reclaimed holder unlink its successor's lock", async () => {
    const target = path.join(rootDir, "settings.json");
    const lockPath = lockPathFor(target);

    // The sequence this guards against: a holder is slow enough to be declared
    // stale, a waiter reclaims and creates its *own* lock at the same path, and
    // then the original holder finishes and releases. Release means "unlink this
    // path", which would destroy the successor's lock — leaving the file
    // unprotected while the successor still believes it holds it, and letting a
    // third process run concurrently with it.
    //
    // The takeover is written directly rather than raced, so the assertion is
    // about ownership rather than about timing.
    await withFileLock(target, { clock: clock() }, async () => {
      const mine = JSON.parse(await readFile(lockPath, "utf8")) as { token: string };
      expect(typeof mine.token).toBe("string");
      await writeFile(
        lockPath,
        JSON.stringify({ token: "successor-token", pid: 4_242, acquiredAt: 0 }),
      );
    });

    const survivor = JSON.parse(await readFile(lockPath, "utf8")) as { token: string };
    expect(survivor.token).toBe("successor-token");
  });

  it("restores a live lock it captured while trying to release its own", async () => {
    const target = path.join(rootDir, "restore.json");
    const lockPath = lockPathFor(target);

    // The exact TOCTOU that a read-then-unlink release cannot close: between the
    // ownership check and the delete, the lock is replaced by a live one. The
    // tombstone protocol captures whatever is at the path by rename, and on finding
    // a token that is not its own, puts it back.
    await withFileLock(target, { clock: clock() }, async () => {
      await writeFile(
        lockPath,
        JSON.stringify({ token: "live-successor", pid: 4_242, acquiredAt: 0 }),
      );
    });

    const survivor = JSON.parse(await readFile(lockPath, "utf8")) as { token: string };
    expect(survivor.token).toBe("live-successor");

    // And no tombstone is left lying around on the success path.
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(rootDir)).filter((n) => n.endsWith(".releasing"))).toEqual([]);
  });

  it("lets only one of two simultaneous reclaimers remove the lock it judged stale", async () => {
    const target = path.join(rootDir, "contested.json");
    const lockPath = lockPathFor(target);
    await writeFile(lockPath, JSON.stringify({ token: "dead", pid: 9, acquiredAt: 0 }));

    const stale = (): ReturnType<typeof createFixedClock> => {
      const c = createFixedClock();
      c.advance(120_000);
      return c;
    };

    // Both see the same abandoned lock and both reclaim. Exactly one may end up
    // holding it, and neither may delete the other's.
    const holders: string[] = [];
    await Promise.all(
      ["a", "b"].map((name) =>
        withFileLock(target, { clock: stale(), staleMillis: 1_000, timeoutMillis: 5_000 }, async () => {
          const held = JSON.parse(await readFile(lockPath, "utf8")) as { token: string };
          holders.push(`${name}:${held.token}`);
          // Whoever is inside must still find its *own* lock at the path.
          await Promise.resolve();
        }),
      ),
    );

    expect(holders).toHaveLength(2);
    // Each holder saw a distinct token, so neither ran under the other's lock.
    expect(new Set(holders.map((h) => h.split(":")[1])).size).toBe(2);
    // The lock is fully released afterwards.
    await expect(readFile(lockPath, "utf8")).rejects.toThrow();
  });

  it("takes fresh ownership when reclaiming, rather than inheriting the dead token", async () => {
    const target = path.join(rootDir, "handover.json");
    const lockPath = lockPathFor(target);
    await writeFile(lockPath, JSON.stringify({ token: "dead-token", pid: 7, acquiredAt: 0 }));

    const held = createFixedClock();
    held.advance(120_000);
    let reclaimedToken: string | undefined;
    await withFileLock(
      target,
      { clock: held, staleMillis: 1_000, timeoutMillis: 1_000 },
      async () => {
        reclaimedToken = (JSON.parse(await readFile(lockPath, "utf8")) as { token: string }).token;
      },
    );

    // A reclaimer that reused the dead token could have its lock unlinked by the
    // very holder it displaced, so ownership must be freshly minted.
    expect(reclaimedToken).toBeDefined();
    expect(reclaimedToken).not.toBe("dead-token");
    await expect(readFile(lockPath, "utf8")).rejects.toThrow();
  });

  it("writes an ownership token and removes its own lock on the way out", async () => {
    const target = path.join(rootDir, "token.json");
    const lockPath = lockPathFor(target);

    let seen: { token?: unknown; pid?: unknown } = {};
    await withFileLock(target, { clock: clock() }, async () => {
      seen = JSON.parse(await readFile(lockPath, "utf8")) as typeof seen;
    });

    expect(typeof seen.token).toBe("string");
    expect((seen.token as string).length).toBeGreaterThanOrEqual(32);
    expect(seen.pid).toBe(process.pid);
    await expect(readFile(lockPath, "utf8")).rejects.toThrow();
  });

  it("reclaims a genuinely abandoned lock rather than wedging forever", async () => {
    const target = path.join(rootDir, "abandoned.json");
    await writeFile(
      lockPathFor(target),
      JSON.stringify({ token: "dead-holder", pid: 999_999, acquiredAt: 0 }),
    );

    const held = createFixedClock();
    held.advance(120_000);
    let ran = false;
    await withFileLock(target, { clock: held, staleMillis: 1_000, timeoutMillis: 1_000 }, () => {
      ran = true;
      return Promise.resolve();
    });
    expect(ran).toBe(true);
  });

  it("times out rather than stealing a lock a live peer still holds", async () => {
    const target = path.join(rootDir, "contended.json");
    // `acquiredAt` at the fixed clock's own start, so the lock reads as freshly
    // taken rather than as debris.
    const ticking = createFixedClock({ startMillis: 1_700_000_000_000, tickMillis: 40 });
    await writeFile(
      lockPathFor(target),
      JSON.stringify({ token: "live-holder", pid: 1, acquiredAt: 1_700_000_000_000 }),
    );

    await expect(
      withFileLock(
        target,
        { clock: ticking, staleMillis: 600_000, timeoutMillis: 80, pollIntervalMillis: 1 },
        () => Promise.resolve("should not run"),
      ),
    ).rejects.toBeInstanceOf(FileLockTimeoutError);

    // And the live holder's lock is untouched.
    const still = JSON.parse(await readFile(lockPathFor(target), "utf8")) as { token: string };
    expect(still.token).toBe("live-holder");
  });
});
