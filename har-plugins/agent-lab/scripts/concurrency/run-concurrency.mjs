/**
 * Agent lab, concurrency scenarios: session context (`sessionContext.dir`)
 * under many repositories, slots and agents at once.
 *
 *   node har-plugins/agent-lab/scripts/run-lab.mjs --scenario concurrency [--only s1,s4]
 *
 * Real `claude` / `codex` CLIs against scripted mocks (no model spend), real
 * `otel-hook run` hook processes, real `har` (sandbox HOME) writing the session
 * context files, and one OTLP collector per scenario: every assertion is made on
 * the wire. See AGENT-LAB.md, "Concurrency scenarios".
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import * as path from "node:path";

import { startOtlpReceiver } from "../../../../scripts/e2e-proof/otlp-receiver.mjs";
import { claudeCodeProvider } from "../providers/claude-code.mjs";
import { codexProvider } from "../providers/codex.mjs";
import { invokeHook, percentile, pool, resolveBin, runAgentSession, STALE_RESOURCE, syntheticPayload } from "./agents.mjs";
import { attemptsOf, checkInvariants, CONTEXT_KEYS, decodeCollector, recordIdentity, recordsOf, segmentsOf } from "./checks.mjs";
import { createHarDriver } from "./har.mjs";

const CLAUDE = { agentTool: "claude_code", otel: "claude-code" };
const CODEX = { agentTool: "codex", otel: "codex" };
const key = (tool, sessionId) => `${tool.agentTool}/${sessionId}`;

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

/** Mirror of HAR's `writeSessionContextFile`: temp file + rename, 0600. */
const atomicWrite = async (file, context) => {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${String(process.pid)}.${String(Date.now())}.${randomUUID().slice(0, 6)}.tmp`;
  await writeFile(temp, `${JSON.stringify(context, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, file);
};

/** A deliberately broken writer: truncate + two partial writes, sometimes unlink first. */
const tornWrite = async (file, context, index) => {
  await mkdir(path.dirname(file), { recursive: true });
  const text = `${JSON.stringify(context, null, 2)}\n`;
  if (index % 7 === 0) {
    await unlink(file).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 3));
  }
  const half = Math.floor(text.length / 2);
  await writeFile(file, text.slice(0, half));
  await new Promise((resolve) => setTimeout(resolve, 2));
  await writeFile(file, text);
};

const raceAttributes = (prefix, n) => ({
  "factory.attempt.id": `${prefix}-att-${String(n)}`,
  "factory.work_unit.id": `${prefix}-wu-${String(n)}`,
  "factory.slot.id": String(n),
  "vcs.repository.url.full": `https://example.invalid/lab/${prefix}-${String(n)}.git`,
  "vcs.ref.head.name": `${prefix}-br-${String(n)}`,
});

const countFiles = async (dir) => {
  let total = 0;
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? await countFiles(full) : 1;
  }
  return total;
};

const findDirs = async (dir, predicate, found = []) => {
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    if (predicate(full)) found.push(full);
    await findDirs(full, predicate, found);
  }
  return found;
};

export const runConcurrencyLab = async ({ labRoot, pluginRoot, repoRoot, cliPath, wrapperPath, log, only }) => {
  const bins = {
    "claude-code": await resolveBin("claude", "CLAUDE_BIN"),
    codex: await resolveBin("codex", "CODEX_BIN"),
  };
  if (bins["claude-code"] === undefined || bins.codex === undefined) {
    return { status: "skip", reason: "the concurrency scenarios need both the claude and codex CLIs on PATH" };
  }
  let har;
  try {
    har = await createHarDriver({ labRoot, log });
  } catch (error) {
    return { status: "skip", reason: `har is not runnable: ${error instanceof Error ? error.message : String(error)}` };
  }
  const base = {
    labRoot,
    pluginRoot,
    repoRoot,
    cliPath,
    wrapperPath,
    bins,
    stateDir: path.join(labRoot, "otel-hook-state"),
    sessionsDir: har.sessionsDir,
    hookHome: path.join(labRoot, "hook-home"),
  };
  await mkdir(base.hookHome, { recursive: true });

  const contextsFor = async (pairs) => {
    const map = new Map();
    for (const [tool, sessionId] of pairs) {
      map.set(key(tool, sessionId), segmentsOf(await har.readContext(tool.agentTool, sessionId)));
    }
    return map;
  };
  const withCollector = async (name, fn) => {
    const collector = await startOtlpReceiver({ captureDir: path.join(labRoot, "capture", name) });
    try {
      return await fn({ ...base, collector });
    } finally {
      await collector.close();
    }
  };
  const repoUrl = (name) => `https://example.invalid/lab/${name}.git`;

  const scenarios = {
    /** 1. Two repositories, both slot 1, one Claude Code session each, in parallel. */
    s1: () =>
      withCollector("s1", async (ctx) => {
        const [repoA, repoB] = await Promise.all([har.initRepo("repo-a", repoUrl("repo-a")), har.initRepo("repo-b", repoUrl("repo-b"))]);
        const sidA = randomUUID();
        const sidB = randomUUID();
        const [slotA, slotB] = await Promise.all([
          har.launch(repoA, 1, { agent: { ...CLAUDE, sessionId: sidA }, workId: "wu-a" }),
          har.launch(repoB, 1, { agent: { ...CLAUDE, sessionId: sidB }, workId: "wu-b" }),
        ]);
        const runs = await Promise.all([
          runAgentSession(ctx, { provider: claudeCodeProvider, workspace: slotA.workDir, label: "s1-a", sessionId: sidA }),
          runAgentSession(ctx, { provider: claudeCodeProvider, workspace: slotB.workDir, label: "s1-b", sessionId: sidB }),
        ]);
        const records = decodeCollector(ctx.collector);
        const contexts = await contextsFor([[CLAUDE, sidA], [CLAUDE, sidB]]);
        const invariants = checkInvariants(records, contexts, { sessions: [...contexts.keys()] });
        const failures = [...invariants.failures];
        for (const [sid, slot, repo] of [[sidA, slotA, repoA], [sidB, slotB, repoB]]) {
          const own = recordsOf(records, CLAUDE.otel, sid);
          if (own.length === 0) failures.push(`no records for session ${sid}`);
          const wrongRepo = own.filter((r) => r.attributes["vcs.repository.url.full"] !== repo.url);
          if (wrongRepo.length > 0) failures.push(`${String(wrongRepo.length)} records of ${repo.name} lack its repository URL`);
          if (JSON.stringify(attemptsOf(own)) !== JSON.stringify([slot.attemptId])) {
            failures.push(`${repo.name} records carry attempts ${JSON.stringify(attemptsOf(own))}, expected ${slot.attemptId}`);
          }
        }
        if (slotA.attemptId === slotB.attemptId) failures.push("both slots got the same attempt");
        return {
          ok: failures.length === 0 && runs.every((r) => r.exitCode === 0),
          failures,
          slots: [slotA, slotB],
          agents: runs.map(summarizeRun),
          wire: invariants.counts,
        };
      }),

    /** 2. Claude Code and Codex in one slot at once; Codex joins with work-bind. */
    s2: () =>
      withCollector("s2", async (ctx) => {
        const repo = await har.initRepo("repo-c", repoUrl("repo-c"));
        const sidClaude = randomUUID();
        const slot = await har.launch(repo, 1, { agent: { ...CLAUDE, sessionId: sidClaude }, workId: "wu-c" });
        const joins = [];
        const runs = await Promise.all([
          runAgentSession(ctx, { provider: claudeCodeProvider, workspace: slot.workDir, label: "s2-claude", sessionId: sidClaude }),
          runAgentSession(ctx, {
            provider: codexProvider,
            workspace: slot.workDir,
            label: "s2-codex",
            hold: ["SessionStart"],
            onArrival: async (arrival) => {
              if (arrival.eventName === "SessionStart") {
                joins.push(await har.workBind(repo, slot, { agent: { ...CODEX, sessionId: arrival.sessionId }, workId: "wu-c" }));
              }
            },
          }),
        ]);
        const sidCodex = runs[1].sessionId;
        const records = decodeCollector(ctx.collector);
        const contexts = await contextsFor([[CLAUDE, sidClaude], [CODEX, sidCodex]]);
        const invariants = checkInvariants(records, contexts, { sessions: [...contexts.keys()] });
        const failures = [...invariants.failures];
        const claude = recordsOf(records, CLAUDE.otel, sidClaude);
        const codex = recordsOf(records, CODEX.otel, sidCodex);
        if (claude.length === 0 || codex.length === 0) failures.push("a session exported nothing");
        for (const [name, own] of [["claude", claude], ["codex", codex]]) {
          if (JSON.stringify(attemptsOf(own)) !== JSON.stringify([slot.attemptId])) {
            failures.push(`${name} records carry ${JSON.stringify(attemptsOf(own))}, expected the slot's attempt ${slot.attemptId}`);
          }
        }
        if (joins.length !== 1) failures.push(`expected one work-bind join, got ${String(joins.length)}`);
        if (joins[0]?.entry.attemptId !== slot.attemptId) failures.push("work-bind of the same unit changed the attempt");
        if (sidClaude === sidCodex) failures.push("both agents reported one session id");
        const sessionIdsOnWire = new Set([...claude, ...codex].map((r) => `${r.providerId}/${String(r.sessionId)}`));
        return {
          ok: failures.length === 0 && runs.every((r) => r.exitCode === 0),
          failures,
          slot,
          joinMillis: joins.map((j) => j.millis),
          sessionIdsOnWire: [...sessionIdsOnWire],
          agents: runs.map(summarizeRun),
          wire: invariants.counts,
        };
      }),

    /** 3. Claude Code in slot 1 and Codex in slot 2 of one repository, in parallel. */
    s3: () =>
      withCollector("s3", async (ctx) => {
        const repo = await har.initRepo("repo-d", repoUrl("repo-d"));
        const sidClaude = randomUUID();
        const slot1 = await har.launch(repo, 1, { agent: { ...CLAUDE, sessionId: sidClaude }, workId: "wu-d1" });
        // Slot 2 is launched by the Codex session itself, as its first act.
        const preSlot2 = await har.launch(repo, 2, { workId: "wu-d2" });
        const runs = await Promise.all([
          runAgentSession(ctx, { provider: claudeCodeProvider, workspace: slot1.workDir, label: "s3-claude", sessionId: sidClaude }),
          runAgentSession(ctx, {
            provider: codexProvider,
            workspace: preSlot2.workDir,
            label: "s3-codex",
            hold: ["SessionStart"],
            onArrival: async (arrival) => {
              if (arrival.eventName === "SessionStart") {
                await har.workBind(repo, preSlot2, { agent: { ...CODEX, sessionId: arrival.sessionId }, workId: "wu-d2" });
              }
            },
          }),
        ]);
        const sidCodex = runs[1].sessionId;
        const records = decodeCollector(ctx.collector);
        const contexts = await contextsFor([[CLAUDE, sidClaude], [CODEX, sidCodex]]);
        const invariants = checkInvariants(records, contexts, { sessions: [...contexts.keys()] });
        const failures = [...invariants.failures];
        const claude = recordsOf(records, CLAUDE.otel, sidClaude);
        const codex = recordsOf(records, CODEX.otel, sidCodex);
        if (JSON.stringify(attemptsOf(claude)) !== JSON.stringify([slot1.attemptId])) failures.push(`claude carries ${JSON.stringify(attemptsOf(claude))}`);
        if (JSON.stringify(attemptsOf(codex)) !== JSON.stringify([preSlot2.attemptId])) failures.push(`codex carries ${JSON.stringify(attemptsOf(codex))}`);
        const slots = (own) => [...new Set(own.map((r) => r.attributes["factory.slot.id"]))].sort();
        if (JSON.stringify(slots(claude)) !== '["1"]' || JSON.stringify(slots(codex)) !== '["2"]') {
          failures.push(`slot ids: claude ${JSON.stringify(slots(claude))}, codex ${JSON.stringify(slots(codex))}`);
        }
        return {
          ok: failures.length === 0 && runs.every((r) => r.exitCode === 0),
          failures,
          slots: [slot1, preSlot2],
          agents: runs.map(summarizeRun),
          wire: invariants.counts,
        };
      }),

    /** 4. A Claude Code session moves slot 1 -> slot 2 between PreToolUse and PostToolUse. */
    s4: () =>
      withCollector("s4", async (ctx) => {
        const repo = await har.initRepo("repo-e", repoUrl("repo-e"));
        const sid = randomUUID();
        const agent = { ...CLAUDE, sessionId: sid };
        const slot1 = await har.launch(repo, 1, { agent, workId: "wu-e1" });
        let slot2;
        const runResult = await runAgentSession(ctx, {
          provider: claudeCodeProvider,
          workspace: slot1.workDir,
          label: "s4-claude",
          sessionId: sid,
          hold: ["PostToolUse"],
          onArrival: async (arrival) => {
            if (arrival.eventName === "PostToolUse" && slot2 === undefined) {
              slot2 = await har.launch(repo, 2, { agent, workId: "wu-e2" });
            }
          },
        });
        const teardown1 = await har.teardown(repo, 1);
        const records = decodeCollector(ctx.collector);
        const contexts = await contextsFor([[CLAUDE, sid]]);
        const segments = contexts.get(key(CLAUDE, sid));
        const invariants = checkInvariants(records, contexts, { sessions: [...contexts.keys()] });
        const failures = [...invariants.failures];
        if (slot2 === undefined) failures.push("the session never reached PostToolUse");
        const switchAt = segments[0]?.to;
        const own = recordsOf(records, CLAUDE.otel, sid).filter((r) => r.signal === "log");
        const before = own.filter((r) => r.times[0] < switchAt);
        const after = own.filter((r) => r.times[0] >= switchAt);
        if (before.length === 0 || after.length === 0) failures.push(`expected logs on both sides of the move (${String(before.length)} before, ${String(after.length)} after)`);
        if (before.some((r) => r.attributes["factory.attempt.id"] !== slot1.attemptId)) failures.push("a log before the move lacks slot 1's attempt");
        if (after.some((r) => r.attributes["factory.attempt.id"] !== slot2?.attemptId)) failures.push("a log after the move lacks slot 2's attempt");
        const lateOld = recordsOf(records, CLAUDE.otel, sid).filter(
          (r) => r.signal !== "metric" && Math.min(...r.times) >= switchAt && r.attributes["factory.attempt.id"] === slot1.attemptId,
        );
        if (lateOld.length > 0) failures.push(`${String(lateOld.length)} records wholly after the move keep slot 1's attempt`);
        const toolSpan = recordsOf(records, CLAUDE.otel, sid).find((r) => r.signal === "span" && r.name.startsWith("tool"));
        return {
          ok: failures.length === 0 && runResult.exitCode === 0,
          failures,
          segments: segments.map((s) => ({ from: s.from, to: s.to, attempt: s.attributes["factory.attempt.id"], slot: s.attributes["factory.slot.id"] })),
          logsBefore: before.length,
          logsAfter: after.length,
          straddlingToolSpan:
            toolSpan === undefined
              ? undefined
              : { attempt: toolSpan.attributes["factory.attempt.id"], branch: toolSpan.attributes["vcs.ref.head.name"], startMillis: toolSpan.times[0], endMillis: toolSpan.times[1] },
          teardown1,
          agent: summarizeRun(runResult),
          wire: invariants.counts,
        };
      }),

    /** 5. The context file rewritten 200 times while 50 hook processes read it. */
    s5: () =>
      withCollector("s5", async (ctx) => {
        const cwd = path.join(labRoot, "s5-workspace");
        await mkdir(cwd, { recursive: true });
        const runVariant = async (variant, write) => {
          const sid = randomUUID();
          const file = path.join(har.sessionsDir, "claude_code", `${sid}.json`);
          const segments = [];
          let writing = true;
          let rewrites = 0;
          const writer = (async () => {
            while (writing && rewrites < 200) {
              const now = new Date().toISOString();
              if (segments.length > 0) segments[segments.length - 1].to = now;
              segments.push({ from: now, to: null, reason: "launch", attributes: raceAttributes(variant, rewrites) });
              await write(file, { version: 1, agentTool: "claude_code", sessionId: sid, segments }, rewrites);
              rewrites += 1;
              await new Promise((resolve) => setTimeout(resolve, 4));
            }
          })();
          const hooks = Array.from({ length: 50 }, (_, index) => () =>
            invokeHook(ctx, {
              provider: CLAUDE.otel,
              payload: syntheticPayload("claude-code", index % 3 === 0 ? "prompt" : index % 3 === 1 ? "tool-start" : "tool-end", {
                sessionId: sid,
                cwd,
                toolUseId: `toolu_${variant}_${String(Math.floor(index / 3))}`,
              }),
            }),
          );
          const results = await pool(hooks, 10);
          writing = false;
          await writer;
          // The writer's in-memory history is the truth for this variant.
          await atomicWrite(file, { version: 1, agentTool: "claude_code", sessionId: sid, segments });
          return { sid, results, rewrites, bytes: (await stat(file)).size };
        };
        const atomic = await runVariant("atomic", (file, context) => atomicWrite(file, context));
        const torn = await runVariant("torn", tornWrite);
        const records = decodeCollector(ctx.collector);
        const contexts = await contextsFor([[CLAUDE, atomic.sid], [CLAUDE, torn.sid]]);
        const atomicCheck = checkInvariants(records, new Map([[key(CLAUDE, atomic.sid), contexts.get(key(CLAUDE, atomic.sid))]]), {
          sessions: [key(CLAUDE, atomic.sid)],
        });
        const tornRecords = recordsOf(records, CLAUDE.otel, torn.sid);
        const tornCheck = checkInvariants(tornRecords, new Map([[key(CLAUDE, torn.sid), contexts.get(key(CLAUDE, torn.sid))]]), {
          sessions: [key(CLAUDE, torn.sid)],
        });
        // With a torn writer, a hook that read a partial/missing file stamps
        // nothing (the expected fallback); what must never happen is a stamp
        // from a torn file or another segment's mix.
        const tornHardFailures = tornCheck.failures.filter((f) => !f.includes("segment in force says") && !f.includes("edges say"));
        const failures = [...atomicCheck.failures.map((f) => `atomic: ${f}`), ...tornHardFailures.map((f) => `torn: ${f}`)];
        const crashed = [...atomic.results, ...torn.results].filter((r) => r.code !== 0 || /unsettled|TypeError|SyntaxError|RangeError/.test(r.stderr));
        if (crashed.length > 0) failures.push(`${String(crashed.length)} hook processes failed: ${crashed[0].stderr.slice(0, 300)}`);
        const atomicLogs = recordsOf(records, CLAUDE.otel, atomic.sid).filter((r) => r.signal === "log");
        const tornLogs = tornRecords.filter((r) => r.signal === "log");
        if (atomicLogs.length === 0) failures.push("atomic variant exported no logs");
        const unstampedAtomic = atomicLogs.filter((r) => r.attributes["factory.attempt.id"] === undefined).length;
        if (unstampedAtomic > 0) failures.push(`${String(unstampedAtomic)} logs unstamped under an atomic writer`);
        return {
          ok: failures.length === 0,
          failures,
          atomic: {
            rewrites: atomic.rewrites,
            fileBytes: atomic.bytes,
            hooks: atomic.results.length,
            logs: atomicLogs.length,
            unstampedLogs: unstampedAtomic,
            distinctAttempts: attemptsOf(atomicLogs).length,
            boundarySkew: atomicCheck.counts.boundarySkew,
            maxSkewMillis: atomicCheck.counts.maxSkewMillis,
            hookMillis: latency(atomic.results),
          },
          torn: {
            rewrites: torn.rewrites,
            hooks: torn.results.length,
            logs: tornLogs.length,
            unstampedLogs: tornLogs.filter((r) => r.attributes["factory.attempt.id"] === undefined).length,
            softMismatches: tornCheck.failures.length - tornHardFailures.length,
            boundarySkew: tornCheck.counts.boundarySkew,
            hookMillis: latency(torn.results),
          },
        };
      }),

    /** 6. One session id under two agent tools; two HAR processes writing one session's file. */
    s6: () =>
      withCollector("s6", async (ctx) => {
        const [repoF, repoG] = await Promise.all([har.initRepo("repo-f", repoUrl("repo-f")), har.initRepo("repo-g", repoUrl("repo-g"))]);
        const shared = randomUUID();
        const slotF = await har.launch(repoF, 1, { agent: { ...CLAUDE, sessionId: shared }, workId: "wu-f" });
        const slotG = await har.launch(repoG, 1, { agent: { ...CODEX, sessionId: shared }, workId: "wu-g" });
        const codexHooks = [];
        for (let i = 0; i < 4; i += 1) {
          const toolUseId = `call_shared_${String(i)}`;
          codexHooks.push(() => invokeHook(ctx, { provider: CODEX.otel, payload: syntheticPayload("codex", "tool-start", { sessionId: shared, cwd: slotG.workDir, toolUseId }) }));
          codexHooks.push(() => invokeHook(ctx, { provider: CODEX.otel, payload: syntheticPayload("codex", "tool-end", { sessionId: shared, cwd: slotG.workDir, toolUseId }) }));
        }
        const [claudeRun, codexResults] = await Promise.all([
          runAgentSession(ctx, { provider: claudeCodeProvider, workspace: slotF.workDir, label: "s6-claude", sessionId: shared }),
          (async () => {
            const out = [];
            for (let i = 0; i < codexHooks.length; i += 2) {
              out.push(...(await Promise.all([codexHooks[i](), codexHooks[i + 1]()])));
            }
            return out;
          })(),
        ]);
        const records = decodeCollector(ctx.collector);
        const contexts = await contextsFor([[CLAUDE, shared], [CODEX, shared]]);
        const invariants = checkInvariants(records, contexts, { sessions: [...contexts.keys()] });
        const failures = [...invariants.failures];
        const claude = recordsOf(records, CLAUDE.otel, shared);
        const codex = recordsOf(records, CODEX.otel, shared);
        if (JSON.stringify(attemptsOf(claude)) !== JSON.stringify([slotF.attemptId])) failures.push(`claude_code/${shared} carries ${JSON.stringify(attemptsOf(claude))}`);
        if (codex.length === 0) failures.push("codex hooks exported nothing");
        if (JSON.stringify(attemptsOf(codex)) !== JSON.stringify([slotG.attemptId])) failures.push(`codex/${shared} carries ${JSON.stringify(attemptsOf(codex))}`);
        const traceIds = (own) => new Set(own.filter((r) => r.signal === "span").map((r) => r.attributes.trace_id ?? r.name));
        void traceIds;

        // Two HAR processes writing one session's file at the same moment: each
        // launch must append one segment. Count what survives.
        const [repoH1, repoH2] = await Promise.all([har.initRepo("repo-h1", repoUrl("repo-h1")), har.initRepo("repo-h2", repoUrl("repo-h2"))]);
        const contested = randomUUID();
        const rounds = 5;
        const agent = { ...CLAUDE, sessionId: contested };
        const roundResults = [];
        for (let round = 0; round < rounds; round += 1) {
          const launched = await Promise.allSettled([
            har.launch(repoH1, 1, { agent, workId: `wu-h1-${String(round)}` }),
            har.launch(repoH2, 1, { agent, workId: `wu-h2-${String(round)}` }),
          ]);
          const file = await har.readContext("claude_code", contested);
          roundResults.push({
            launched: launched.map((r) => r.status),
            segmentsAfter: file?.segments.length ?? 0,
            openAfter: (file?.segments ?? []).filter((s) => s.to === null).length,
          });
          await Promise.all([har.teardown(repoH1, 1), har.teardown(repoH2, 1)]);
        }
        const finalFile = await har.readContext("claude_code", contested);
        const expectedSegments = rounds * 2;
        const writerRace = {
          rounds,
          expectedSegments,
          survivingSegments: finalFile?.segments.length ?? 0,
          lostSegments: expectedSegments - (finalFile?.segments.length ?? 0),
          openAtEnd: (finalFile?.segments ?? []).filter((s) => s.to === null).length,
          perRound: roundResults,
        };
        return {
          ok: failures.length === 0 && claudeRun.exitCode === 0 && codexResults.every((r) => r.code === 0),
          failures,
          sharedSessionId: shared,
          claudeAttempt: slotF.attemptId,
          codexAttempt: slotG.attemptId,
          writerRace,
          wire: invariants.counts,
        };
      }),

    /** 7 + 8. 20 concurrent hook processes over 4 sessions, a destination down, then drained. */
    s7: () =>
      withCollector("s7", async (ctx) => {
        const [repoI, repoJ] = await Promise.all([har.initRepo("repo-i", repoUrl("repo-i")), har.initRepo("repo-j", repoUrl("repo-j"))]);
        const sessions = [
          { tool: CLAUDE, provider: "claude-code", sid: randomUUID(), repo: repoI, slot: 1 },
          { tool: CODEX, provider: "codex", sid: randomUUID(), repo: repoI, slot: 2 },
          { tool: CLAUDE, provider: "claude-code", sid: randomUUID(), repo: repoJ, slot: 1 },
          { tool: CODEX, provider: "codex", sid: randomUUID(), repo: repoJ, slot: 2 },
        ];
        for (const session of sessions) {
          session.slotInfo = await har.launch(session.repo, session.slot, {
            agent: { ...session.tool, sessionId: session.sid },
            workId: `wu-${session.repo.name}-${String(session.slot)}`,
          });
        }
        const downPort = await freePort();
        const downUrl = `http://127.0.0.1:${String(downPort)}/v1/traces`;
        const configFile = path.join(labRoot, "s7-destinations.json");
        await writeFile(configFile, `${JSON.stringify({ exporter: { destinations: [{ name: "down", endpoint: downUrl }] } }, null, 2)}\n`);
        const stateFilesBefore = await countFiles(ctx.stateDir);

        // Latency with every destination up: 20 concurrent hook processes over
        // the 4 sessions, with and without session context.
        const healthyPlan = (withContext, tag) =>
          (withContext ? sessions : sessions.map((session) => ({ ...session, sid: randomUUID() }))).flatMap((session) => {
            const cwd = session.slotInfo.workDir;
            const hook = (kind, toolUseId) => () =>
              invokeHook(ctx, { provider: session.provider, withContext, payload: syntheticPayload(session.provider, kind, { sessionId: session.sid, cwd, toolUseId }) });
            return [hook("prompt"), hook("tool-start", `${tag}_h1`), hook("tool-end", `${tag}_h1`), hook("tool-start", `${tag}_h2`), hook("tool-end", `${tag}_h2`)];
          });
        const healthyWithContext = await Promise.all(healthyPlan(true, "hctx").map((task) => task()));
        const healthyBaseline = await Promise.all(healthyPlan(false, "hbase").map((task) => task()));

        // Per session: a prompt, then two tools whose start and end fire at the
        // same instant (the SubagentStart / PostToolUse race seen live).
        // The baseline round runs the same load for sessions with no context
        // file and no context directory configured: the cost of the feature.
        const baselineSessions = sessions.map((session) => ({ ...session, sid: randomUUID() }));
        const plan = (withContext, tag) =>
          (withContext ? sessions : baselineSessions).flatMap((session) => {
            const cwd = session.slotInfo.workDir;
            const hook = (kind, toolUseId) => () =>
              invokeHook(ctx, { provider: session.provider, configFile, withContext, payload: syntheticPayload(session.provider, kind, { sessionId: session.sid, cwd, toolUseId }) });
            return [
              hook("prompt"),
              hook("tool-start", `${tag}_t1_${session.sid.slice(0, 8)}`),
              hook("tool-end", `${tag}_t1_${session.sid.slice(0, 8)}`),
              hook("tool-start", `${tag}_t2_${session.sid.slice(0, 8)}`),
              hook("tool-end", `${tag}_t2_${session.sid.slice(0, 8)}`),
            ];
          });
        const downStartedAt = Date.now();
        const withContext = await Promise.all(plan(true, "ctx").map((task) => task()));
        const stateFilesMid = await countFiles(ctx.stateDir);
        const baseline = await Promise.all(plan(false, "base").map((task) => task()));
        const stateFilesAfter = await countFiles(ctx.stateDir);

        const failures = [];
        const all = [...withContext, ...baseline, ...healthyWithContext, ...healthyBaseline];
        const crashed = all.filter((r) => r.code !== 0 || /unsettled top-level await|TypeError|SyntaxError/.test(r.stderr));
        if (crashed.length > 0) failures.push(`${String(crashed.length)} hook processes failed: ${crashed[0].stderr.slice(0, 300)}`);

        const live = decodeCollector(ctx.collector);
        const contexts = await contextsFor(sessions.map((s) => [s.tool, s.sid]));
        const liveCheck = checkInvariants(live, contexts, { sessions: [...contexts.keys()] });
        const baselineContexts = new Map(baselineSessions.map((s) => [key(s.tool, s.sid), []]));
        const baselineCheck = checkInvariants(live, baselineContexts, { sessions: [...baselineContexts.keys()] });
        failures.push(...baselineCheck.failures.map((f) => `baseline: ${f}`));
        failures.push(...liveCheck.failures.map((f) => `live: ${f}`));
        // Every tool start/end pair must reach the wire as one tool span per call.
        const toolSpans = live.filter((r) => r.signal === "span" && r.name.startsWith("tool"));
        // 2 tools per session per round: two healthy rounds, two rounds with a destination down.
        const expectedTools = sessions.length * 2 * 4;
        if (toolSpans.length !== expectedTools) failures.push(`expected ${String(expectedTools)} tool spans on the live destination, got ${String(toolSpans.length)}`);
        const logEvents = live.filter((r) => r.signal === "log").length;

        // Spool of the down destination: valid, per destination, own Resource.
        const spoolDirs = await findDirs(ctx.stateDir, (dir) => /destinations[\\/]down[\\/]spool/.test(dir) && !dir.endsWith("-corrupt"));
        const spool = { dirs: spoolDirs.length, files: 0, invalid: 0, resourceMismatch: 0, records: 0 };
        for (const dir of spoolDirs) {
          for (const name of (await readdir(dir)).filter((n) => n.endsWith(".json") && !n.startsWith(".tmp-") && !n.startsWith("drops"))) {
            spool.files += 1;
            try {
              const batch = JSON.parse(await readFile(path.join(dir, name), "utf8"));
              const items = batch.spans ?? batch.records ?? batch.points ?? [];
              spool.records += items.length;
              const resourceAttempt = batch.resourceAttributes?.["factory.attempt.id"];
              if (resourceAttempt !== undefined && resourceAttempt !== STALE_RESOURCE["factory.attempt.id"]) {
                const recordAttempts = new Set(items.map((item) => item.attributes?.["factory.attempt.id"]));
                if (recordAttempts.size !== 1 || !recordAttempts.has(resourceAttempt)) spool.resourceMismatch += 1;
              }
            } catch {
              spool.invalid += 1;
            }
          }
        }
        if (spool.files === 0) failures.push("the down destination spooled nothing");
        if (spool.invalid > 0) failures.push(`${String(spool.invalid)} spool files are not valid JSON`);
        if (spool.resourceMismatch > 0) failures.push(`${String(spool.resourceMismatch)} spooled batches carry a Resource their records contradict`);

        // Bring the destination up and drain with 4 concurrent hook processes per round.
        const revived = await startOtlpReceiver({ port: downPort, captureDir: path.join(labRoot, "capture", "s7-revived") });
        const drainRounds = [];
        try {
          for (let round = 0; round < 12; round += 1) {
            const before = await countSpooled(spoolDirs);
            if (before === 0) break;
            const results = await Promise.all(
              sessions.map((session) =>
                invokeHook(ctx, { provider: session.provider, configFile, payload: syntheticPayload(session.provider, "prompt", { sessionId: session.sid, cwd: session.slotInfo.workDir }) }),
              ),
            );
            drainRounds.push({ before, after: await countSpooled(spoolDirs), codes: results.map((r) => r.code) });
          }
        } finally {
          await revived.close();
        }
        const replayed = decodeCollector(revived);
        const replayCheck = checkInvariants(replayed, contexts, { sessions: [...contexts.keys()] });
        failures.push(...replayCheck.failures.map((f) => `replayed: ${f}`));
        // Exactly once: every span / log the live destination got, the revived
        // one got once (both destinations receive the same records).
        const counted = new Map();
        for (const record of replayed.filter((r) => r.signal !== "metric")) {
          const id = recordIdentity(record);
          counted.set(id, (counted.get(id) ?? 0) + 1);
        }
        const duplicates = [...counted.values()].reduce((sum, n) => sum + n - 1, 0);
        const liveIds = new Set(live.filter((r) => r.signal !== "metric" && Math.min(...r.times) >= downStartedAt).map(recordIdentity));
        const missing = [...liveIds].filter((id) => !counted.has(id)).length;
        if (duplicates > 0) failures.push(`${String(duplicates)} records delivered twice by concurrent drains`);
        if (missing > 0) failures.push(`${String(missing)} live records never reached the revived destination`);
        const remaining = await countSpooled(spoolDirs);
        if (remaining > 0) failures.push(`${String(remaining)} batches still spooled after draining`);
        const corrupt = await findDirs(ctx.stateDir, (dir) => dir.endsWith("-corrupt"));
        let quarantined = 0;
        for (const dir of corrupt) quarantined += (await readdir(dir)).length;
        if (quarantined > 0) failures.push(`${String(quarantined)} spool batches quarantined during concurrent drains`);

        return {
          ok: failures.length === 0,
          failures,
          hookMillis: {
            allDestinationsUp: { withContext: latency(healthyWithContext), withoutContext: latency(healthyBaseline) },
            oneDestinationDown: { withContext: latency(withContext), withoutContext: latency(baseline) },
          },
          concurrency: withContext.length,
          stateFiles: { before: stateFilesBefore, afterContextRound: stateFilesMid, afterBaselineRound: stateFilesAfter },
          live: { ...liveCheck.counts, toolSpans: toolSpans.length, logs: logEvents },
          spool,
          drain: { rounds: drainRounds, replayed: replayCheck.counts, duplicates, missing, remaining, quarantined },
        };
      }),
  };

  const selected = only === undefined ? Object.keys(scenarios) : only.split(",").map((s) => s.trim());
  const results = {};
  for (const name of selected) {
    const scenario = scenarios[name];
    if (scenario === undefined) throw new Error(`unknown concurrency scenario ${name}`);
    log(`==> concurrency ${name}`);
    const started = Date.now();
    try {
      results[name] = { ...(await scenario()), millis: Date.now() - started };
    } catch (error) {
      results[name] = { ok: false, failures: [error instanceof Error ? error.stack ?? error.message : String(error)], millis: Date.now() - started };
    }
    log(`==> concurrency ${name}: ${results[name].ok ? "PASS" : "FAIL"}`);
  }
  // Scenario 8 (exporter isolation) is asserted inside every scenario: the
  // Resource check of checkInvariants on the live and replayed wire.
  const ok = Object.values(results).every((result) => result.ok);
  return { status: ok ? "pass" : "fail", har: har.version, contextKeys: CONTEXT_KEYS, scenarios: results };
};

const countSpooled = async (dirs) => {
  let total = 0;
  for (const dir of dirs) {
    try {
      total += (await readdir(dir)).filter((n) => n.endsWith(".json") && !n.startsWith(".tmp-") && !n.startsWith("drops")).length;
    } catch {
      // gone
    }
  }
  return total;
};

const latency = (results) => {
  const values = results.map((r) => r.millis);
  return { n: values.length, p50: percentile(values, 50), p95: percentile(values, 95), max: percentile(values, 100) };
};

const summarizeRun = (run) => ({
  label: run.label,
  provider: run.provider,
  sessionId: run.sessionId,
  exitCode: run.exitCode,
  millis: run.millis,
  hookEvents: run.hookEvents,
  ...(run.exitCode === 0 ? {} : { stderrTail: run.stderrTail }),
});

export const cleanupLab = (labRoot) => rm(labRoot, { recursive: true, force: true });
