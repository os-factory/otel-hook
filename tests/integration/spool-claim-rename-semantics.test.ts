import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFixedClock } from "../../src/runtime/clock.js";
import { sanitizeSegment } from "../../src/state/keys.js";
import { createFileDurableSpool } from "../../src/telemetry/durable-spool.js";

/**
 * Windows renames a *file*, not a *name*.
 *
 * `fs.rename` there is `MoveFileExW`: it opens the source, then renames that open
 * handle. Two drains that open the same queued batch before either renames it
 * both succeed — the second one moves the file out of the first one's claim name
 * into its own — so "the rename succeeded" does not mean "this drain alone holds
 * the batch". Seen on the Windows CI runner as one batch delivered twice by four
 * concurrent drains. POSIX `rename(2)` resolves the source by name at the moment
 * of the call and the loser gets `ENOENT`, which is why it never showed up there.
 *
 * This file swaps `rename` for one with the Windows behavior (resolve the source
 * when the call starts, move whatever file that was when it lands) and widens
 * the gap between the two, so the interleaving happens on every run on any OS.
 */
const handleRename = vi.hoisted(() => ({ enabled: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  /** Current path of each file a rename has opened, by a stable identity. */
  const location = new Map<number, string>();
  const identityAt = new Map<string, number>();
  let nextIdentity = 0;
  const rename = async (from: string, to: string): Promise<void> => {
    if (!handleRename.enabled) {
      return actual.rename(from, to);
    }
    // "Open the source": fails as it would on Windows if nothing is there now.
    await actual.stat(from);
    let identity = identityAt.get(from);
    if (identity === undefined || location.get(identity) !== from) {
      identity = nextIdentity;
      nextIdentity += 1;
      identityAt.set(from, identity);
      location.set(identity, from);
    }
    // Let every concurrent caller open the same file before any of them renames.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const current = location.get(identity) ?? from;
    // "Rename the handle": moves the file wherever an earlier rename put it.
    await actual.rename(current, to);
    identityAt.delete(current);
    identityAt.set(to, identity);
    location.set(identity, to);
  };
  return { ...actual, rename, default: { ...actual, rename } };
});

const PROVIDER = "acme-cli";
const INSTALLATION = "install-1";

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(tmpdir(), "otel-hook-spool-claim-"));
});

afterEach(async () => {
  handleRename.enabled = false;
  await rm(rootDir, { recursive: true, force: true });
});

const spoolDir = (): string => path.join(rootDir, sanitizeSegment(PROVIDER), INSTALLATION, "spool");

const plant = async (order: number, spanId: string): Promise<void> => {
  await mkdir(spoolDir(), { recursive: true });
  await writeFile(
    path.join(spoolDir(), `${String(order).padStart(16, "0")}-planted.json`),
    JSON.stringify({
      providerId: PROVIDER,
      installationId: INSTALLATION,
      resourceAttributes: { "service.name": "obs" },
      instrumentationScope: { name: "otel-hook" },
      spans: [
        {
          name: "tool read_file",
          kind: 0,
          traceId: "0af7651916cd43dd8448eb211c80319c",
          spanId,
          startMillis: 1_000,
          endMillis: 1_750,
          attributes: {},
          statusCode: 0,
        },
      ],
      enqueuedAt: 1_700_000_000_000,
    }),
    "utf8",
  );
};

describe("concurrent drains under handle-based rename (Windows semantics)", () => {
  it("still deliver every batch exactly once", async () => {
    const ids = Array.from({ length: 6 }, (_, index) => (0x100 + index).toString(16).padStart(16, "0"));
    for (const [index, id] of ids.entries()) {
      await plant(index + 1, id);
    }
    handleRename.enabled = true;

    const sent: string[] = [];
    const drains = Array.from({ length: 4 }, () =>
      createFileDurableSpool({
        rootDir,
        providerId: PROVIDER,
        installationId: INSTALLATION,
        clock: createFixedClock(),
      }).drain(async (spooled) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        sent.push(...spooled.spans.map((span) => span.spanId));
        return true;
      }),
    );
    const results = await Promise.all(drains);

    expect([...sent].sort()).toEqual([...ids].sort());
    expect(results.reduce((sum, result) => sum + result.drained, 0)).toBe(ids.length);
    expect(await readdir(spoolDir())).toEqual([]);
  });
});
