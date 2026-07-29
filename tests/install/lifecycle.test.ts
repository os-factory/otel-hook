import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  detectDocumentFormat,
  lockPathFor,
  renderJsonDocument,
  runRegistrationLifecycle,
  withFileLock,
  type RegistrationOutcome,
  type RegistrationScope,
} from "../../src/install/index.js";
import { createSystemClock } from "../../src/runtime/clock.js";

/**
 * The half of the registration lifecycle that touches real files.
 *
 * Every case here is about something that can only go wrong on disk: a file
 * that already exists with someone else's formatting, a file that does not
 * parse, two processes racing for the same document, a document that must be
 * byte-identical after setup-then-uninstall.
 */

const clock = createSystemClock();
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const scratch = async (): Promise<{ home: string; project: string }> => {
  const root = await mkdtemp(path.join(tmpdir(), "otel-hook-install-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
  return { home, project };
};

type RunOptions = {
  readonly action?: "setup" | "diagnose" | "uninstall";
  readonly providerIds?: readonly string[];
  readonly scopes?: readonly RegistrationScope[];
  readonly dryRun?: boolean;
  readonly command?: string;
  readonly events?: readonly string[];
  readonly configFile?: string;
};

const run = async (
  roots: { home: string; project: string },
  options: RunOptions = {},
): Promise<readonly RegistrationOutcome[]> => {
  const report = await runRegistrationLifecycle({
    action: options.action ?? "setup",
    providerIds: options.providerIds ?? ["claude-code"],
    scopes: options.scopes ?? ["project"],
    roots: { homeDir: roots.home, projectDir: roots.project },
    dryRun: options.dryRun ?? false,
    clock,
    ...(options.command === undefined ? {} : { command: options.command }),
    ...(options.events === undefined ? {} : { events: options.events }),
    ...(options.configFile === undefined ? {} : { configFile: options.configFile }),
  });
  return report.outcomes;
};

const claudeProjectPath = (roots: { project: string }): string =>
  path.join(roots.project, ".claude", "settings.json");

const readJson = async (filePath: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;

const only = (outcomes: readonly RegistrationOutcome[]): RegistrationOutcome => {
  expect(outcomes).toHaveLength(1);
  const [outcome] = outcomes;
  if (outcome === undefined) {
    throw new Error("expected exactly one outcome");
  }
  return outcome;
};

describe("setup", () => {
  it("creates the provider's documented path and reports what it added", async () => {
    const roots = await scratch();
    const outcome = only(await run(roots));

    expect(outcome.status).toBe("applied");
    expect(outcome.configPath).toBe(claudeProjectPath(roots));
    expect(outcome.evidence).toContain("code.claude.com");
    expect(outcome.changes.every((change) => change.action === "added")).toBe(true);

    const document = await readJson(claudeProjectPath(roots));
    const hooks = document.hooks as Record<string, readonly { hooks: readonly { command: string }[] }[]>;
    expect(hooks.PreToolUse?.[0]?.hooks[0]?.command).toBe("otel-hook run --provider claude-code");
  });

  it("writes to the global scope only when asked", async () => {
    const roots = await scratch();
    const outcome = only(await run(roots, { scopes: ["global"] }));

    expect(outcome.configPath).toBe(path.join(roots.home, ".claude", "settings.json"));
    await expect(readFile(claudeProjectPath(roots), "utf8")).rejects.toThrow();
  });

  it("is idempotent: repeated runs report unchanged and rewrite nothing", async () => {
    const roots = await scratch();
    await run(roots);
    const after = await readFile(claudeProjectPath(roots), "utf8");

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const outcome = only(await run(roots));
      expect(outcome.status, `attempt ${String(attempt)}`).toBe("unchanged");
      expect(outcome.changed).toBe(false);
      expect(await readFile(claudeProjectPath(roots), "utf8")).toBe(after);
    }
  });

  it("upgrades a registration written by an older version in place", async () => {
    const roots = await scratch();
    await run(roots, { command: "python3 /old/path/otel-hook.py" });

    const outcome = only(await run(roots, { command: "/opt/bin/otel-hook run --provider claude-code" }));
    expect(outcome.status).toBe("applied");
    expect(outcome.changes.every((change) => change.action === "updated")).toBe(true);

    const document = await readJson(claudeProjectPath(roots));
    const hooks = document.hooks as Record<string, readonly { hooks: readonly { command: string }[] }[]>;
    for (const [event, groups] of Object.entries(hooks)) {
      const commands = groups.flatMap((group) => group.hooks.map((hook) => hook.command));
      expect(commands, event).toEqual(["/opt/bin/otel-hook run --provider claude-code"]);
    }
  });

  it("preserves unrelated settings, other tools' hooks, and the file's own formatting", async () => {
    const roots = await scratch();
    const settingsPath = claudeProjectPath(roots);
    await mkdir(path.dirname(settingsPath), { recursive: true });
    // Four-space indent, CRLF, no trailing newline: three things a naive
    // rewrite would silently normalize into a noisy diff.
    const original = [
      "{",
      '    "permissions": {',
      '        "allow": [',
      '            "Bash(git *)"',
      "        ]",
      "    },",
      '    "hooks": {',
      '        "Stop": [',
      "            {",
      '                "hooks": [',
      "                    {",
      '                        "type": "command",',
      '                        "command": "./notify.sh"',
      "                    }",
      "                ]",
      "            }",
      "        ]",
      "    }",
      "}",
    ].join("\r\n");
    await writeFile(settingsPath, original, "utf8");

    await run(roots);
    const written = await readFile(settingsPath, "utf8");

    expect(written.split("\r\n")[1]).toBe('    "permissions": {');
    // Every line break is a CRLF, and the last line still has no break at all.
    expect(written.split("\n").slice(0, -1).every((line) => line.endsWith("\r"))).toBe(true);
    expect(written.endsWith("\n")).toBe(false);

    const document = JSON.parse(written) as Record<string, unknown>;
    expect(document.permissions).toEqual({ allow: ["Bash(git *)"] });
    const hooks = document.hooks as Record<string, readonly { hooks: readonly { command: string }[] }[]>;
    expect(hooks.Stop?.some((group) => group.hooks.some((hook) => hook.command === "./notify.sh"))).toBe(
      true,
    );
  });

  it("refuses a document that is not well-formed JSON and leaves every byte in place", async () => {
    const roots = await scratch();
    const settingsPath = claudeProjectPath(roots);
    await mkdir(path.dirname(settingsPath), { recursive: true });
    const malformed = '{ "hooks": { "Stop": [ ] }, // a comment JSON does not allow\n}';
    await writeFile(settingsPath, malformed, "utf8");

    const outcome = only(await run(roots));

    expect(outcome.status).toBe("blocked");
    expect(outcome.problems[0]).toContain("not well-formed JSON");
    expect(outcome.problems[0]).toContain("left untouched");
    expect(await readFile(settingsPath, "utf8")).toBe(malformed);
  });

  it("refuses a document whose hooks value is not the documented shape", async () => {
    const roots = await scratch();
    const settingsPath = claudeProjectPath(roots);
    await mkdir(path.dirname(settingsPath), { recursive: true });
    const surprising = JSON.stringify({ hooks: ["PreToolUse"] }, null, 2);
    await writeFile(settingsPath, surprising, "utf8");

    const outcome = only(await run(roots));

    expect(outcome.status).toBe("blocked");
    expect(outcome.conflicts[0]?.location).toBe("hooks");
    expect(await readFile(settingsPath, "utf8")).toBe(surprising);
  });

  it("populates an existing but empty file rather than refusing it", async () => {
    const roots = await scratch();
    const settingsPath = claudeProjectPath(roots);
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, "\n", "utf8");

    expect(only(await run(roots)).status).toBe("applied");
    expect((await readJson(settingsPath)).hooks).toBeDefined();
  });

  it("registers only the events the caller named", async () => {
    const roots = await scratch();
    await run(roots, { events: ["PreToolUse"] });

    const document = await readJson(claudeProjectPath(roots));
    expect(Object.keys(document.hooks as Record<string, unknown>)).toEqual(["PreToolUse"]);
  });

  it("reports Codex's documented hooks opt-out instead of editing config.toml", async () => {
    const roots = await scratch();
    const codexDir = path.join(roots.project, ".codex");
    await mkdir(codexDir, { recursive: true });
    const toml = "[features]\nhooks = false\n";
    await writeFile(path.join(codexDir, "config.toml"), toml, "utf8");

    const outcome = only(await run(roots, { providerIds: ["codex"] }));

    expect(outcome.status).toBe("applied");
    expect(outcome.notes.join(" ")).toContain("hooks = false");
    // config.toml is a read-only input to the diagnostic, never a write target.
    expect(await readFile(path.join(codexDir, "config.toml"), "utf8")).toBe(toml);
  });

  it("writes cursor's documented hooks.json, version key included", async () => {
    const roots = await scratch();
    const outcome = only(await run(roots, { providerIds: ["cursor"] }));

    expect(outcome.status).toBe("applied");
    expect(outcome.problems).toEqual([]);
    const written = JSON.parse(
      await readFile(path.join(roots.project, ".cursor", "hooks.json"), "utf8"),
    ) as { version: number; hooks: Record<string, { command: string; type: string }[]> };

    // Cursor's schema is `{ version, hooks: { <event>: [ { command } ] } }` — a
    // flat list per event, not the matcher-group nesting the other providers use.
    expect(written.version).toBe(1);
    expect(written.hooks.preToolUse?.[0]).toMatchObject({
      type: "command",
      command: "otel-hook run --provider cursor",
    });
    // The events that would double-count a shell or MCP call are not registered.
    expect(Object.keys(written.hooks)).not.toContain("beforeShellExecution");
    expect(Object.keys(written.hooks)).not.toContain("afterMCPExecution");
  });

  it("refuses antigravity without an explicit path, because none is verified", async () => {
    const roots = await scratch();
    const outcome = only(await run(roots, { providerIds: ["antigravity"] }));

    expect(outcome.status).toBe("unsupported");
    expect(outcome.problems[0]).toContain("--settings-file");
  });

  it("registers antigravity into a path the caller vouches for", async () => {
    const roots = await scratch();
    const hookFile = path.join(roots.project, "runner", "hooks.json");
    const outcome = only(await run(roots, { providerIds: ["antigravity"], configFile: hookFile }));

    expect(outcome.status).toBe("applied");
    expect(outcome.evidence).toContain("--settings-file");
    expect(Object.keys((await readJson(hookFile)).hooks as Record<string, unknown>)).toContain(
      "PreToolUse",
    );
  });
});

describe("setup --dry-run", () => {
  it("prints the exact bytes it would write and touches no filesystem entry", async () => {
    const roots = await scratch();
    const outcome = only(await run(roots, { dryRun: true }));

    expect(outcome.status).toBe("planned");
    expect(outcome.plannedContents).toBeDefined();
    await expect(readFile(claudeProjectPath(roots), "utf8")).rejects.toThrow();
    // Not even the directory: a read-only command that leaves `.claude/` behind
    // in a home directory is a bug.
    await expect(readFile(path.join(roots.project, ".claude"), "utf8")).rejects.toThrow();

    // The dry run's output must be exactly what the real run then writes.
    await run(roots);
    expect(await readFile(claudeProjectPath(roots), "utf8")).toBe(outcome.plannedContents);
  });
});

describe("uninstall", () => {
  const providers = ["claude-code", "codex", "gemini-cli"] as const;

  for (const providerId of providers) {
    it(`restores the ${providerId} document byte for byte`, async () => {
      const roots = await scratch();
      const setup = only(await run(roots, { providerIds: [providerId] }));
      const configPath = setup.configPath ?? "";

      const removed = only(await run(roots, { providerIds: [providerId], action: "uninstall" }));
      expect(removed.status).toBe("applied");
      expect(removed.changes.every((change) => change.action === "removed")).toBe(true);
      expect(await readFile(configPath, "utf8")).toBe(renderJsonDocument({}, detectDocumentFormat("")));
    });
  }

  it("leaves another tool's hooks and unrelated keys exactly as they were", async () => {
    const roots = await scratch();
    const settingsPath = claudeProjectPath(roots);
    await mkdir(path.dirname(settingsPath), { recursive: true });
    const original = `${JSON.stringify(
      {
        permissions: { allow: ["Bash(git *)"] },
        hooks: { Stop: [{ hooks: [{ type: "command", command: "./notify.sh" }] }] },
      },
      null,
      2,
    )}\n`;
    await writeFile(settingsPath, original, "utf8");

    await run(roots);
    await run(roots, { action: "uninstall" });

    expect(await readFile(settingsPath, "utf8")).toBe(original);
  });

  it("is a no-op when nothing is registered and when the file does not exist", async () => {
    const roots = await scratch();
    expect(only(await run(roots, { action: "uninstall" })).status).toBe("absent");

    await run(roots);
    await run(roots, { action: "uninstall" });
    expect(only(await run(roots, { action: "uninstall" })).status).toBe("absent");
  });

  it("refuses a malformed document rather than deleting what it cannot read", async () => {
    const roots = await scratch();
    const settingsPath = claudeProjectPath(roots);
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, "not json at all", "utf8");

    const outcome = only(await run(roots, { action: "uninstall" }));
    expect(outcome.status).toBe("blocked");
    expect(await readFile(settingsPath, "utf8")).toBe("not json at all");
  });
});

describe("diagnose", () => {
  it("reports nothing registered without creating anything", async () => {
    const roots = await scratch();
    const report = await runRegistrationLifecycle({
      action: "diagnose",
      providerIds: ["claude-code", "codex", "gemini-cli"],
      scopes: ["global", "project"],
      roots: { homeDir: roots.home, projectDir: roots.project },
      dryRun: false,
      clock,
    });

    expect(report.ok).toBe(true);
    expect(report.outcomes).toHaveLength(6);
    expect(report.outcomes.every((outcome) => outcome.status === "absent")).toBe(true);
    await expect(readFile(path.join(roots.home, ".claude"), "utf8")).rejects.toThrow();
  });

  it("lists the events actually registered", async () => {
    const roots = await scratch();
    await run(roots, { events: ["PreToolUse", "Stop"] });

    const outcome = only(await run(roots, { action: "diagnose", scopes: ["project"] }));
    expect(outcome.status).toBe("unchanged");
    expect(outcome.registeredEvents).toEqual(["PreToolUse", "Stop"]);
  });

  it("flags a partial registration as a problem so CI can gate on it", async () => {
    const roots = await scratch();
    await run(roots, { events: ["PreToolUse"] });

    const outcome = only(await run(roots, { action: "diagnose", scopes: ["project"] }));
    expect(outcome.missingEvents.length).toBeGreaterThan(0);
    expect(outcome.problems.join(" ")).toContain("re-run setup");
  });

  it("notes a command that differs from the one setup would write, without failing", async () => {
    const roots = await scratch();
    await run(roots, { command: "otel-hook run --provider claude-code --endpoint https://c/v1/traces" });

    const outcome = only(await run(roots, { action: "diagnose", scopes: ["project"] }));
    expect(outcome.problems).toEqual([]);
    expect(outcome.notes.join(" ")).toContain("differs from");
  });

  it("reports duplicate registrations left by an older tool as a problem", async () => {
    const roots = await scratch();
    const settingsPath = claudeProjectPath(roots);
    await mkdir(path.dirname(settingsPath), { recursive: true });
    const entry = { type: "command", command: "otel-hook run --provider claude-code" };
    await writeFile(
      settingsPath,
      JSON.stringify({ hooks: { Stop: [{ hooks: [entry, { ...entry, timeout: 30 }] }] } }, null, 2),
      "utf8",
    );

    const outcome = only(await run(roots, { action: "diagnose", scopes: ["project"] }));
    expect(outcome.problems.join(" ")).toContain("more than one registration");

    // …and setup repairs exactly that.
    await run(roots, { events: ["Stop"] });
    const repaired = only(await run(roots, { action: "diagnose", scopes: ["project"] }));
    expect(repaired.problems.join(" ")).not.toContain("more than one registration");
  });
});

describe("concurrent writes", () => {
  it("keeps every provider's registration when three setups race on one document", async () => {
    const roots = await scratch();
    const shared = path.join(roots.project, "shared", "hooks.json");
    await mkdir(path.dirname(shared), { recursive: true });
    await writeFile(shared, JSON.stringify({ keep: true }, null, 2), "utf8");

    // Three commands, one file. Without the lock each would read the original
    // document and the last writer would erase the other two registrations.
    const commands = [
      "otel-hook run --provider claude-code --tag a",
      "otel-hook run --provider claude-code --tag b",
      "otel-hook run --provider claude-code --tag c",
    ];
    await Promise.all(
      commands.map((command) =>
        runRegistrationLifecycle({
          action: "setup",
          providerIds: ["claude-code"],
          scopes: ["project"],
          roots: { homeDir: roots.home, projectDir: roots.project },
          configFile: shared,
          command,
          events: ["Stop"],
          // Each command is its own registration here, so they must not
          // recognize one another as the same managed entry.
          managedMarker: command,
          dryRun: false,
          clock,
        }),
      ),
    );

    const document = await readJson(shared);
    expect(document.keep).toBe(true);
    const hooks = document.hooks as Record<string, readonly { hooks: readonly { command: string }[] }[]>;
    const written = (hooks.Stop ?? []).flatMap((group) => group.hooks.map((hook) => hook.command));
    expect(written.sort()).toEqual([...commands].sort());
  });

  it("never leaves a half-written document behind, even under repeated races", async () => {
    const roots = await scratch();
    const shared = path.join(roots.project, ".claude", "settings.json");

    for (let round = 0; round < 5; round += 1) {
      await Promise.all([
        run(roots, { events: ["Stop"] }),
        run(roots, { events: ["PreToolUse"] }),
        run(roots, { action: "uninstall" }),
      ]);
      // Whatever order they landed in, the file must still parse.
      const raw = await readFile(shared, "utf8").catch(() => "{}");
      expect(() => JSON.parse(raw) as unknown, `round ${String(round)}`).not.toThrow();
    }
  });

  it("reports a timeout instead of writing when a stale-but-live lock is held", async () => {
    const roots = await scratch();
    const settingsPath = claudeProjectPath(roots);

    let release: (() => void) | undefined;
    const held = withFileLock(
      settingsPath,
      { clock, staleMillis: 60_000 },
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    // Wait until the lock file is really on disk before racing it.
    while (release === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const report = await runRegistrationLifecycle({
      action: "setup",
      providerIds: ["claude-code"],
      scopes: ["project"],
      roots: { homeDir: roots.home, projectDir: roots.project },
      dryRun: false,
      clock,
      lock: { timeoutMillis: 60, pollIntervalMillis: 10, staleMillis: 60_000 },
    });

    release();
    await held;

    const outcome = only(report.outcomes);
    expect(outcome.status).toBe("failed");
    expect(outcome.problems[0]).toContain("timed out");
    await expect(readFile(settingsPath, "utf8")).rejects.toThrow();
  });

  it("does not steal a lock that exists but has not been written yet", async () => {
    // `open(path, "wx")` creates the file before its contents land, so a waiter
    // can see an empty lock that is legitimately held. Treating that as
    // abandoned would let two processes run the read-merge-write at once and
    // lose one of the two registrations — rarely enough to look like flakiness.
    const roots = await scratch();
    const settingsPath = claudeProjectPath(roots);
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(lockPathFor(settingsPath), "", "utf8");

    const report = await runRegistrationLifecycle({
      action: "setup",
      providerIds: ["claude-code"],
      scopes: ["project"],
      roots: { homeDir: roots.home, projectDir: roots.project },
      dryRun: false,
      clock,
      lock: { timeoutMillis: 60, pollIntervalMillis: 10 },
    });

    expect(only(report.outcomes).status).toBe("failed");
    await expect(readFile(settingsPath, "utf8")).rejects.toThrow();
  });

  it("reclaims a lock abandoned by a crashed process", async () => {
    const roots = await scratch();
    const settingsPath = claudeProjectPath(roots);
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(
      lockPathFor(settingsPath),
      JSON.stringify({ pid: 999_999, acquiredAt: clock.now() - 120_000 }),
      "utf8",
    );

    const outcome = only(await run(roots));
    expect(outcome.status).toBe("applied");
  });
});
