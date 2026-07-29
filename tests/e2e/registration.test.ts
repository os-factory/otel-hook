import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { ensureBuiltCli, makeStateDir, runCliProcess } from "./harness.js";

/**
 * The registration lifecycle, driven as a coding agent's operator would drive
 * it: the built binary, in a child process, against throwaway home and project
 * directories.
 *
 * These run unchanged on Linux, macOS, and Windows. `--home-dir` and
 * `--project-dir` exist partly for this: resolving the scopes from flags rather
 * than from `HOME`/`USERPROFILE` means one assertion covers all three platforms,
 * and no test can ever reach a real `~/.claude/settings.json`.
 */

beforeAll(async () => {
  await ensureBuiltCli();
}, 300_000);

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

type Roots = { readonly home: string; readonly project: string };

const withRoots = async (): Promise<Roots> => {
  const state = await makeStateDir();
  cleanups.push(() => state.remove());
  const home = path.join(state.dir, "home");
  const project = path.join(state.dir, "project");
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
  return { home, project };
};

type Outcome = {
  readonly providerId: string;
  readonly scope: string;
  readonly configPath?: string;
  readonly status: string;
  readonly changed: boolean;
  readonly changes: readonly { readonly event: string; readonly action: string }[];
  readonly registeredEvents: readonly string[];
  readonly missingEvents: readonly string[];
  readonly notes: readonly string[];
  readonly problems: readonly string[];
  readonly plannedContents?: string;
};

type Report = {
  readonly action: string;
  readonly dryRun: boolean;
  readonly ok: boolean;
  readonly outcomes: readonly Outcome[];
};

const runRegistration = async (
  args: readonly string[],
  roots: Roots,
): Promise<{ readonly code: number | null; readonly report: Report; readonly stderr: string }> => {
  const result = await runCliProcess([
    ...args,
    "--home-dir",
    roots.home,
    "--project-dir",
    roots.project,
    "--json",
  ]);
  return { code: result.code, report: JSON.parse(result.stdout) as Report, stderr: result.stderr };
};

const readJson = async (filePath: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;

/**
 * Every managed command in a hook document, across both shapes this tool writes:
 * the nested matcher-group form (Claude Code, Codex, Gemini CLI) and the flat
 * one-entry-per-event form (Cursor, Antigravity).
 */
const commandsIn = (document: Record<string, unknown>): readonly string[] => {
  const hooks = (document.hooks ?? {}) as Record<string, readonly Record<string, unknown>[]>;
  return Object.values(hooks).flatMap((entries) =>
    entries.flatMap((entry) => {
      const nested = entry.hooks;
      if (Array.isArray(nested)) {
        return (nested as readonly { command: string }[]).map((hook) => hook.command);
      }
      return typeof entry.command === "string" ? [entry.command] : [];
    }),
  );
};

const VERIFIED_PROVIDERS = [
  { providerId: "claude-code", segments: [".claude", "settings.json"] },
  { providerId: "codex", segments: [".codex", "hooks.json"] },
  { providerId: "cursor", segments: [".cursor", "hooks.json"] },
  { providerId: "gemini-cli", segments: [".gemini", "settings.json"] },
] as const;

describe("otel-hook setup: every verified planner", () => {
  for (const { providerId, segments } of VERIFIED_PROVIDERS) {
    it(`registers, re-registers idempotently, and uninstalls ${providerId} in both scopes`, async () => {
      const roots = await withRoots();

      for (const scope of ["project", "global"] as const) {
        const expectedPath = path.join(scope === "global" ? roots.home : roots.project, ...segments);

        const first = await runRegistration(["setup", "--provider", providerId, "--scope", scope], roots);
        expect(first.code, `${providerId}/${scope}`).toBe(0);
        expect(first.report.ok).toBe(true);
        const installed = first.report.outcomes[0];
        expect(installed?.status).toBe("applied");
        expect(installed?.configPath).toBe(expectedPath);
        expect(commandsIn(await readJson(expectedPath))).toContain(
          `otel-hook run --provider ${providerId}`,
        );

        const bytes = await readFile(expectedPath, "utf8");
        const second = await runRegistration(["setup", "--provider", providerId, "--scope", scope], roots);
        expect(second.report.outcomes[0]?.status).toBe("unchanged");
        expect(await readFile(expectedPath, "utf8")).toBe(bytes);

        const removed = await runRegistration(
          ["uninstall", "--provider", providerId, "--scope", scope],
          roots,
        );
        expect(removed.code).toBe(0);
        expect(removed.report.outcomes[0]?.status).toBe("applied");
        expect(await readFile(expectedPath, "utf8")).toBe("{}\n");
      }
    });
  }

  it("upgrades a registration an older version wrote, without duplicating it", async () => {
    const roots = await withRoots();
    const settingsPath = path.join(roots.project, ".claude", "settings.json");

    await runRegistration(
      ["setup", "--provider", "claude-code", "--hook-command", "python3 /old/otel-hook.py"],
      roots,
    );
    const upgraded = await runRegistration(
      ["setup", "--provider", "claude-code", "--hook-command", "/opt/bin/otel-hook run --provider claude-code"],
      roots,
    );

    expect(upgraded.report.outcomes[0]?.changes.every((change) => change.action === "updated")).toBe(true);
    const commands = commandsIn(await readJson(settingsPath));
    expect(new Set(commands)).toEqual(new Set(["/opt/bin/otel-hook run --provider claude-code"]));
  });

  it("shows the exact planned document under --dry-run and writes nothing", async () => {
    const roots = await withRoots();
    const settingsPath = path.join(roots.project, ".claude", "settings.json");

    const dry = await runRegistration(["setup", "--provider", "claude-code", "--dry-run"], roots);
    expect(dry.code).toBe(0);
    expect(dry.report.dryRun).toBe(true);
    const planned = dry.report.outcomes[0]?.plannedContents;
    expect(planned).toBeDefined();
    await expect(readFile(settingsPath, "utf8")).rejects.toThrow();

    await runRegistration(["setup", "--provider", "claude-code"], roots);
    expect(await readFile(settingsPath, "utf8")).toBe(planned);
  });

  it("preserves an existing file's unrelated keys, other hooks, and indentation", async () => {
    const roots = await withRoots();
    const settingsPath = path.join(roots.project, ".claude", "settings.json");
    await mkdir(path.dirname(settingsPath), { recursive: true });
    const original = `${JSON.stringify(
      {
        permissions: { allow: ["Bash(git *)"] },
        hooks: { Stop: [{ hooks: [{ type: "command", command: "./notify.sh" }] }] },
      },
      null,
      4,
    )}\n`;
    await writeFile(settingsPath, original, "utf8");

    await runRegistration(["setup", "--provider", "claude-code"], roots);
    const written = await readFile(settingsPath, "utf8");
    expect(written.split("\n")[1]).toBe('    "permissions": {');

    await runRegistration(["uninstall", "--provider", "claude-code"], roots);
    expect(await readFile(settingsPath, "utf8")).toBe(original);
  });

  it("refuses a malformed configuration and exits non-zero without touching it", async () => {
    const roots = await withRoots();
    const settingsPath = path.join(roots.project, ".claude", "settings.json");
    await mkdir(path.dirname(settingsPath), { recursive: true });
    const malformed = '{ "hooks": { } // trailing comment\n}';
    await writeFile(settingsPath, malformed, "utf8");

    const result = await runRegistration(["setup", "--provider", "claude-code"], roots);
    expect(result.code).toBe(1);
    expect(result.report.ok).toBe(false);
    expect(result.report.outcomes[0]?.status).toBe("blocked");
    expect(await readFile(settingsPath, "utf8")).toBe(malformed);
  });

  it("survives concurrent setups of different providers into one project", async () => {
    const roots = await withRoots();

    const results = await Promise.all(
      VERIFIED_PROVIDERS.map(({ providerId }) =>
        runRegistration(["setup", "--provider", providerId], roots),
      ),
    );
    expect(results.every((result) => result.code === 0)).toBe(true);

    for (const { providerId, segments } of VERIFIED_PROVIDERS) {
      const document = await readJson(path.join(roots.project, ...segments));
      expect(commandsIn(document), providerId).toContain(`otel-hook run --provider ${providerId}`);
    }
  });

  it("survives concurrent setups of the same provider into one document", async () => {
    const roots = await withRoots();
    const settingsPath = path.join(roots.project, ".claude", "settings.json");

    const results = await Promise.all(
      ["SessionStart", "PreToolUse", "PostToolUse", "Stop"].map((event) =>
        runRegistration(["setup", "--provider", "claude-code", "--event", event], roots),
      ),
    );
    expect(results.every((result) => result.code === 0)).toBe(true);

    // Serialized by the lock, so every one of the four writes survives.
    const document = await readJson(settingsPath);
    expect(Object.keys(document.hooks as Record<string, unknown>).sort()).toEqual([
      "PostToolUse",
      "PreToolUse",
      "SessionStart",
      "Stop",
    ]);
  });
});

describe("otel-hook diagnose", () => {
  it("reports every verified provider in both scopes and creates nothing", async () => {
    const roots = await withRoots();
    const result = await runRegistration(["diagnose"], roots);

    expect(result.code).toBe(0);
    // Exactly the providers this tool can locate on its own, in both scopes.
    expect(result.report.outcomes).toHaveLength(VERIFIED_PROVIDERS.length * 2);
    expect(result.report.outcomes.every((outcome) => outcome.status === "absent")).toBe(true);
    await expect(readFile(path.join(roots.home, ".claude"), "utf8")).rejects.toThrow();
  });

  it("finds an installation, then reports it gone after uninstall", async () => {
    const roots = await withRoots();
    await runRegistration(["setup", "--provider", "codex"], roots);

    const found = await runRegistration(["diagnose", "--provider", "codex", "--scope", "project"], roots);
    expect(found.code).toBe(0);
    expect(found.report.outcomes[0]?.status).toBe("unchanged");
    expect(found.report.outcomes[0]?.registeredEvents).toContain("PreToolUse");

    await runRegistration(["uninstall", "--provider", "codex"], roots);
    const gone = await runRegistration(["diagnose", "--provider", "codex", "--scope", "project"], roots);
    expect(gone.report.outcomes[0]?.status).toBe("absent");
  });

  it("exits 1 on a partial registration so CI can gate on it", async () => {
    const roots = await withRoots();
    await runRegistration(["setup", "--provider", "claude-code", "--event", "Stop"], roots);

    const result = await runRegistration(
      ["diagnose", "--provider", "claude-code", "--scope", "project"],
      roots,
    );
    expect(result.code).toBe(1);
    expect(result.report.outcomes[0]?.problems.join(" ")).toContain("re-run setup");
  });

  it("reports Codex's documented hooks opt-out without editing config.toml", async () => {
    const roots = await withRoots();
    const codexDir = path.join(roots.project, ".codex");
    await mkdir(codexDir, { recursive: true });
    const toml = "[features]\nhooks = false\n";
    await writeFile(path.join(codexDir, "config.toml"), toml, "utf8");

    const result = await runRegistration(["diagnose", "--provider", "codex", "--scope", "project"], roots);
    expect(result.report.outcomes[0]?.notes.join(" ")).toContain("hooks = false");
    expect(await readFile(path.join(codexDir, "config.toml"), "utf8")).toBe(toml);
  });
});

describe("otel-hook setup: cursor's own document shape", () => {
  it("writes the documented flat shape, and reverses it exactly", async () => {
    const roots = await withRoots();
    const hooksPath = path.join(roots.project, ".cursor", "hooks.json");

    const result = await runRegistration(["setup", "--provider", "cursor"], roots);
    expect(result.code).toBe(0);
    expect(result.report.outcomes[0]?.status).toBe("applied");

    const document = await readJson(hooksPath);
    expect(document.version).toBe(1);
    const hooks = document.hooks as Record<string, readonly Record<string, unknown>[]>;
    // A flat list per event, not a matcher group: an entry with a `command`, not
    // an entry with a nested `hooks` array.
    expect(hooks.preToolUse?.[0]).toEqual({
      type: "command",
      command: "otel-hook run --provider cursor",
    });
    // The pairs that would report one shell or MCP call twice are not registered.
    for (const event of [
      "beforeShellExecution",
      "afterShellExecution",
      "beforeMCPExecution",
      "afterMCPExecution",
      "afterAgentResponse",
    ]) {
      expect(Object.keys(hooks), event).not.toContain(event);
    }

    const removed = await runRegistration(["uninstall", "--provider", "cursor"], roots);
    expect(removed.code).toBe(0);
    // Setup created the file, so uninstall leaves nothing behind — not even the
    // version key it had to add.
    expect(await readFile(hooksPath, "utf8")).toBe("{}\n");
  });

  it("preserves a developer's own cursor hooks and their version", async () => {
    const roots = await withRoots();
    const hooksPath = path.join(roots.project, ".cursor", "hooks.json");
    await mkdir(path.dirname(hooksPath), { recursive: true });
    const original = `${JSON.stringify(
      {
        version: 1,
        hooks: { preToolUse: [{ command: "./scripts/audit.sh" }] },
      },
      null,
      2,
    )}\n`;
    await writeFile(hooksPath, original, "utf8");

    await runRegistration(["setup", "--provider", "cursor"], roots);
    const merged = await readJson(hooksPath);
    expect(commandsIn(merged)).toContain("./scripts/audit.sh");
    expect(commandsIn(merged)).toContain("otel-hook run --provider cursor");

    await runRegistration(["uninstall", "--provider", "cursor"], roots);
    expect(await readFile(hooksPath, "utf8")).toBe(original);
  });
});

describe("otel-hook setup: providers this repository will not guess for", () => {
  it("refuses antigravity without a path, and accepts one the caller supplies", async () => {
    const roots = await withRoots();
    const refused = await runRegistration(["setup", "--provider", "antigravity"], roots);
    expect(refused.code).toBe(1);
    expect(refused.report.outcomes[0]?.problems.join(" ")).toContain("--settings-file");

    const hookFile = path.join(roots.project, "runner", "hooks.json");
    const accepted = await runRegistration(
      ["setup", "--provider", "antigravity", "--settings-file", hookFile],
      roots,
    );
    expect(accepted.code).toBe(0);
    expect(Object.keys((await readJson(hookFile)).hooks as Record<string, unknown>)).toContain(
      "PreToolUse",
    );
  });

  it("prints a human-readable report without --json", async () => {
    const roots = await withRoots();
    const result = await runCliProcess([
      "setup",
      "--provider",
      "claude-code",
      "--dry-run",
      "--home-dir",
      roots.home,
      "--project-dir",
      roots.project,
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("dry run; nothing was written");
    expect(result.stdout).toContain("would change claude-code (project)");
    expect(result.stdout).toContain("--- would write ---");
    expect(result.stderr).toBe("");
  });
});
